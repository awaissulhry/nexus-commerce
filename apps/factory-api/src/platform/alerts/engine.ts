import type { FactoryDatabase } from '@nexus/factory-db'
import { KINDS, RECHECK_EVENTS, kindsOf, recheckOf, thresholdOf, type RuleKind } from '@nexus/factory-domain/alerts/kinds'
import { planEvaluation, type EvaluatedRule, type EvaluationPlan, type Finding, type KeyState } from '@nexus/factory-domain/alerts/rules'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { dueAtOf, plusCalendarDays, timerKeyOf, timerPlan, type TimerPlan, type WantedTimer } from '@nexus/factory-domain/timers/rules'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings, type CommandTools, type CommandTx } from '../../core/command'
import { defineCron, type CronJob } from '../../core/cron'
import type { Log } from '../../core/queue'
import { serverClock, type Clock } from '../../core/time'
import { addWorkingDaysFor } from '../calendars/service'
import { defineHandler, type EventHandler } from '../outbox/dispatch'
import { activeTenants, systemContext } from '../outbox/system'
import { applyTimerPlan, timersOfRule, type TimerRow, type TimerSpec } from '../timers/service'
import { ensureBuiltInRules } from './built-in'
import { datedFor, findFor, type DatedRecord } from './evaluators'
import { clearInCommand, raiseInCommand } from './raise'
import { lockKind, RULE_COLUMNS, tenantIdOf, type Reader, type RuleRow } from './store'

/**
 * The exception rules' engine (B-W2a-33; ANA-036, PLT-100): the scheduler's clustered cron `alerts.evaluate` (every 5
 * minutes, one replica per tick) and the worker's handler `alerts.recheck` (one record again, right after an event that
 * changes it). Per ACTIVE tenant, in its system context:
 *
 *   built-ins    the kinds without their built-in rule get it (./built-in.ts)
 *   CONDITION    per kind: every enabled rule's findings (./evaluators.ts) → factory-domain alerts/rules planEvaluation →
 *                raise the new ones (a record found, no unresolved alert of its key, the cooldown passed), clear the
 *                ones no rule finds any more
 *   DATE         per kind: every enabled rule's dated records → the timers they should have (one per record and rule:
 *                `KIND:-Nd`, N calendar days before the date, or N working days of the record's company) → timers set,
 *                moved and cancelled (timers/rules timerPlan; a timer that FIRED for the same date is never set again);
 *                the alerts whose record left its window (renewed, invoiced, the date moved later) are cleared. Their
 *                alerts are raised by the timers themselves (platform/timers/fire.ts).
 *
 * A pass first PLANS outside any transaction (reads only); a kind with nothing to do writes nothing (no audit flood
 * every five minutes). A kind with something to do runs ONE system command: the kind's advisory lock, the plan made
 * again under it, then the writes, so two passes (the cron and a recheck, two replicas) never raise twice and a replay
 * finds nothing left to do. One failing kind or tenant is logged and the others go on.
 */

export interface EngineOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export interface KindOutcome {
  readonly kind: RuleKind
  readonly raised: number
  readonly cleared: number
  readonly timersSet: number
  readonly timersCancelled: number
}

const settingsOf = (clock: Clock): CommandSettings => ({ ...COMMAND_SETTINGS, clock })

const evaluated = (rule: RuleRow): EvaluatedRule => ({ id: rule.id, companyId: rule.companyId, siteId: rule.siteId, severity: rule.severity, cooldownMinutes: rule.cooldownMinutes, createdAt: rule.createdAt })

async function enabledRules(db: Reader, kind: RuleKind): Promise<RuleRow[]> {
  return db.alertRule.findMany({ where: { ruleKind: kind, enabled: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: RULE_COLUMNS })
}

/** The latest alert of each key a pass found, and every unresolved alert of the kind (of these records, for a recheck). */
async function latestOf(db: Reader, kind: RuleKind, keys: readonly string[], only?: readonly string[]): Promise<KeyState[]> {
  const select = { id: true, dedupeKey: true, recordId: true, occurrence: true, raisedAt: true, state: true } as const
  const unresolved = await db.alert.findMany({ where: { ruleKind: kind, state: { not: 'RESOLVED' }, ...(only ? { recordId: { in: [...only] } } : {}) }, select })
  const open = new Set(unresolved.map((row) => row.dedupeKey))
  const others = keys.filter((key) => !open.has(key))
  const resolved = others.length
    ? await db.alert.findMany({ where: { dedupeKey: { in: others } }, distinct: ['dedupeKey'], orderBy: [{ dedupeKey: 'asc' }, { occurrence: 'desc' }], select })
    : []
  return [...unresolved, ...resolved].map((row) => ({ alertId: row.id, dedupeKey: row.dedupeKey, recordId: row.recordId, occurrence: row.occurrence, raisedAt: row.raisedAt, resolved: row.state === 'RESOLVED' }))
}

const keysOf = (kind: RuleKind, findings: ReadonlyMap<string, readonly Finding[]>): string[] => [...new Set([...findings.values()].flat().map((finding) => `${kind}:${finding.recordId}${finding.subKey ? `:${finding.subKey}` : ''}`))]

// ---- CONDITION kinds ---------------------------------------------------------------------------------------------------------

interface ConditionPlan {
  readonly rules: readonly RuleRow[]
  readonly plan: EvaluationPlan
}

async function planCondition(db: CommandTx, kind: RuleKind, now: Date, only?: readonly string[]): Promise<ConditionPlan> {
  const rules = await enabledRules(db, kind)
  const findings = new Map<string, Finding[]>()
  for (const rule of rules) findings.set(rule.id, await findFor(kind, db, rule, now, only))
  const latest = await latestOf(db, kind, keysOf(kind, findings), only)
  return { rules, plan: planEvaluation({ kind, findings, rules: rules.map(evaluated), latest, now, raise: true, only: only ? new Set(only) : undefined }) }
}

const hasWork = (plan: EvaluationPlan): boolean => plan.raise.length > 0 || plan.clear.length > 0

async function applyCondition(tools: CommandTools, kind: RuleKind, plan: EvaluationPlan): Promise<{ raised: number; cleared: number }> {
  let raised = 0
  let cleared = 0
  for (const entry of plan.raise) {
    await raiseInCommand(tools, { rule: { id: entry.rule.id, severity: entry.rule.severity }, kind, finding: entry.finding, dedupeKey: entry.dedupeKey, occurrence: entry.occurrence })
    raised++
  }
  for (const alertId of plan.clear) if (await clearInCommand(tools, alertId)) cleared++
  return { raised, cleared }
}

// ---- DATE kinds --------------------------------------------------------------------------------------------------------------

interface RuleTimers {
  readonly rule: RuleRow
  readonly records: ReadonlyMap<string, DatedRecord>
  readonly plan: TimerPlan
  readonly rows: ReadonlyMap<string, TimerRow>
  /** The records whose timer time has come (the alert's window). */
  readonly inWindow: readonly Finding[]
}

interface DatePlan {
  readonly rules: readonly RuleTimers[]
  readonly clear: EvaluationPlan
}

/** When a DATE rule's timer of a record fires: N calendar days before its date, or N working days of its company. */
async function fireDateOf(db: CommandTx, record: DatedRecord, daysBefore: number, workingDays: boolean, cache: Map<string, BusinessDate>): Promise<BusinessDate> {
  if (daysBefore === 0) return record.date
  if (!workingDays || record.scope.companyId === null) return plusCalendarDays(record.date, -daysBefore)
  const key = `${record.scope.companyId}|${record.date}|${daysBefore}`
  const cached = cache.get(key)
  if (cached) return cached
  const found = await addWorkingDaysFor(db, { scope: 'COMPANY', id: record.scope.companyId }, record.date, -daysBefore).catch(() => null)
  const date = found?.date ?? plusCalendarDays(record.date, -daysBefore)
  cache.set(key, date)
  return date
}

async function planDate(db: CommandTx, kind: RuleKind, now: Date, only?: readonly string[]): Promise<DatePlan> {
  const timerKind = KINDS[kind].timer!
  const rules = await enabledRules(db, kind)
  const cache = new Map<string, BusinessDate>()
  const plans: RuleTimers[] = []
  const inWindow = new Map<string, Finding[]>()
  for (const rule of rules) {
    const threshold = thresholdOf(kind, rule.threshold) as { daysBefore: number; workingDays: boolean }
    const timerKey = timerKeyOf(timerKind, threshold.daysBefore > 0 ? { amount: -threshold.daysBefore, unit: 'd' } : null)
    const dated = await datedFor(kind, db, rule, now, only)
    const wanted: WantedTimer[] = []
    const window: Finding[] = []
    for (const record of dated) {
      const fireAt = dueAtOf(await fireDateOf(db, record, threshold.daysBefore, threshold.workingDays, cache))
      const timer = { recordType: record.recordType, recordId: record.recordId, timerKey, dueAt: dueAtOf(record.date), fireAt }
      // Only what comes within the horizon gets a timer now; the window is what fired (or should have).
      wanted.push(timer)
      if (fireAt.getTime() <= now.getTime()) window.push({ recordType: record.recordType, recordId: record.recordId, label: record.label, scope: record.scope, facts: {} })
    }
    const { pending, fired, rows } = await timersOfRule(db, rule.id, only)
    plans.push({ rule, records: new Map(dated.map((record) => [record.recordId, record])), plan: timerPlan(wanted, pending, 'GONE', fired), rows, inWindow: window })
    inWindow.set(rule.id, window)
  }
  const latest = await latestOf(db, kind, keysOf(kind, inWindow), only)
  return { rules: plans, clear: planEvaluation({ kind, findings: inWindow, rules: rules.map(evaluated), latest, now, raise: false, only: only ? new Set(only) : undefined }) }
}

const dateHasWork = (plan: DatePlan): boolean => plan.clear.clear.length > 0 || plan.rules.some((entry) => entry.plan.set.length > 0 || entry.plan.cancel.length > 0)

async function applyDate(tools: CommandTools, kind: RuleKind, plan: DatePlan): Promise<{ cleared: number; timersSet: number; timersCancelled: number }> {
  let timersSet = 0
  let timersCancelled = 0
  for (const entry of plan.rules) {
    const threshold = thresholdOf(kind, entry.rule.threshold) as { daysBefore: number; workingDays: boolean }
    const specOf = (wanted: WantedTimer): TimerSpec => {
      const record = entry.records.get(wanted.recordId)!
      return {
        record: { type: wanted.recordType, id: wanted.recordId },
        recordLabel: record.label,
        timerKey: wanted.timerKey,
        dueAt: wanted.dueAt,
        fireAt: wanted.fireAt,
        companyId: record.scope.companyId,
        siteId: record.scope.siteId,
        partyId: record.scope.partyId,
        ruleId: entry.rule.id,
        payload: { kind, date: record.date, daysBefore: threshold.daysBefore, workingDays: threshold.workingDays },
      }
    }
    const done = await applyTimerPlan(tools, entry.plan, entry.rows, specOf)
    timersSet += done.set
    timersCancelled += done.cancelled
  }
  let cleared = 0
  for (const alertId of plan.clear.clear) if (await clearInCommand(tools, alertId)) cleared++
  return { cleared, timersSet, timersCancelled }
}

// ---- one kind, one tenant ------------------------------------------------------------------------------------------------------

/**
 * Evaluates one kind in the caller's tenant (`only`: these records again, after an event). Writes only when the plan has
 * something to do, in one command under the kind's lock (the plan is made again there).
 */
export async function evaluateKind(caller: CommandCaller, kind: RuleKind, settings: CommandSettings, only?: readonly string[]): Promise<KindOutcome> {
  const none: KindOutcome = { kind, raised: 0, cleared: 0, timersSet: 0, timersCancelled: 0 }
  const now = settings.clock.now()
  const trigger = KINDS[kind].trigger
  const work = await caller.withClient((db) => (trigger === 'CONDITION' ? planCondition(db as CommandTx, kind, now, only).then((entry) => hasWork(entry.plan)) : planDate(db as CommandTx, kind, now, only).then(dateHasWork)))
  if (!work) return none
  const { result } = await runCommand(
    caller,
    { name: 'alerts.evaluate', input: { kind, only: only ?? null } },
    async (tools) => {
      const tenantId = tenantIdOf(tools.context)
      await lockKind(tools.tx, tenantId, kind)
      if (trigger === 'CONDITION') {
        const { rules, plan } = await planCondition(tools.tx, kind, tools.now, only)
        const done = await applyCondition(tools, kind, plan)
        if (done.raised + done.cleared === 0) tools.audit({ action: 'alerts.evaluate', recordType: rules[0] ? 'AlertRule' : 'Tenant', recordId: rules[0]?.id ?? tenantId, after: { kind, raised: 0, cleared: 0 } })
        return { ...none, ...done }
      }
      const plan = await planDate(tools.tx, kind, tools.now, only)
      const done = await applyDate(tools, kind, plan)
      if (done.cleared + done.timersSet + done.timersCancelled === 0) tools.audit({ action: 'alerts.evaluate', recordType: plan.rules[0] ? 'AlertRule' : 'Tenant', recordId: plan.rules[0]?.rule.id ?? tenantId, after: { kind, cleared: 0, timers: 0 } })
      return { ...none, ...done }
    },
    settings,
  )
  return result
}

export interface EvaluationRun {
  readonly tenants: number
  readonly builtIns: number
  readonly raised: number
  readonly cleared: number
  readonly timersSet: number
  readonly timersCancelled: number
  readonly failed: number
}

/** One pass over every active tenant (the cron's tick; tests call it directly). */
export async function runAlertEvaluation(options: EngineOptions): Promise<EvaluationRun> {
  const clock = options.clock ?? serverClock
  const settings = settingsOf(clock)
  const requestId = `alerts-evaluate-${newId()}`
  const totals = { builtIns: 0, raised: 0, cleared: 0, timersSet: 0, timersCancelled: 0, failed: 0 }
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    try {
      totals.builtIns += await ensureBuiltInRules(caller, settings)
    } catch (error) {
      totals.failed++
      options.log.error({ err: error, tenantId }, 'the built-in alert rules could not be made')
    }
    for (const kind of [...kindsOf('CONDITION'), ...kindsOf('DATE')]) {
      try {
        const outcome = await evaluateKind(caller, kind, settings)
        totals.raised += outcome.raised
        totals.cleared += outcome.cleared
        totals.timersSet += outcome.timersSet
        totals.timersCancelled += outcome.timersCancelled
      } catch (error) {
        totals.failed++
        options.log.error({ err: error, tenantId, kind }, 'an exception rule kind could not be evaluated')
      }
    }
  }
  const run = { tenants: tenants.length, ...totals }
  if (run.raised + run.cleared + run.timersSet + run.timersCancelled + run.builtIns + run.failed > 0) options.log.info({ ...run }, 'exception rules evaluated')
  return run
}

/** The scheduler's cron: every 5 minutes. */
export function alertsEvaluateCron(options: EngineOptions): CronJob {
  return defineCron({
    name: 'alerts.evaluate',
    schedule: '*/5 * * * *',
    async run() {
      await runAlertEvaluation(options)
    },
  })
}

/**
 * The worker's handler: an event that changes a record a kind watches (factory-domain alerts/kinds `recheck`) evaluates
 * that kind again for that record only, at once (a hold released clears its alert now, not in five minutes). Safe to
 * repeat: a replay finds nothing left to do.
 */
export function alertsRecheckHandler(clock: Clock = serverClock): EventHandler {
  return defineHandler({
    name: 'alerts.recheck',
    events: [...RECHECK_EVENTS],
    async handle(event, tools) {
      const payload = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Record<string, unknown>
      for (const { kind, key } of recheckOf(event.type)) {
        const recordId = payload[key]
        if (typeof recordId !== 'string' || !isUuid(recordId)) continue
        await evaluateKind(tools.caller, kind, settingsOf(clock), [recordId])
      }
    },
  })
}

