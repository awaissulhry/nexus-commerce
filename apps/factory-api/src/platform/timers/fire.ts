import type { FactoryDatabase } from '@nexus/factory-db'
import { KINDS, isRuleKind, thresholdOf } from '@nexus/factory-domain/alerts/kinds'
import { daysBetween, dedupeKeyOf } from '@nexus/factory-domain/alerts/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as timerEvents } from '@nexus/factory-domain/timers/events'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings, type CommandTools } from '../../core/command'
import { defineCron, type CronJob } from '../../core/cron'
import type { Log } from '../../core/queue'
import { serverClock, type Clock } from '../../core/time'
import { datedFor } from '../alerts/evaluators'
import { raiseInCommand } from '../alerts/raise'
import { lockKind, RULE_COLUMNS, tenantIdOf } from '../alerts/store'
import { activeTenants, systemContext } from '../outbox/system'
import { cancelTimerInCommand, TIMER_COLUMNS, type TimerRow } from './service'

/**
 * Firing the date timers (B-W2a-33; PLT-100): the scheduler's clustered cron `timers.fire` (every minute, one replica per
 * tick). Per ACTIVE tenant, the PENDING timers whose time came (oldest first, at most FIRE_LIMIT a tick; the next tick
 * goes on), each in ONE system command keyed by the timer (a repeated tick answers from its receipt):
 *
 *   a DATE rule's timer   the kind's lock first (the same as the rules' evaluation), then the timer's row; the record is
 *                         read again: no longer dated (renewed, invoiced) → CANCELLED (GONE), its date moved → CANCELLED
 *                         (MOVED; the next evaluation sets the new one), the rule switched off → CANCELLED (RULE_OFF);
 *                         else FIRED + `timer.fired`, and the rule's alert raised for the record (once: not while one of
 *                         its key is unresolved, and not again within the rule's cooldown)
 *   a module's timer      FIRED + `timer.fired`; the module's worker handler does the rest
 */

export const FIRE_LIMIT = 200
const [timerFired] = timerEvents

export interface FireOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export interface FireOutcome {
  readonly outcome: 'FIRED' | 'RAISED' | 'CANCELLED' | 'SKIPPED'
}

function markFired(tools: CommandTools, row: TimerRow): Promise<number> {
  return tools.tx.dueTimer
    .updateMany({ where: { id: row.id, status: 'PENDING', version: row.version }, data: { status: 'FIRED', firedAt: tools.now, version: row.version + 1, updatedAt: tools.now } })
    .then(({ count }) => {
      if (count === 0) return 0
      tools.audit({ action: 'timers.fire', recordType: 'DueTimer', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { timerKey: row.timerKey, recordType: row.recordType, recordId: row.recordId, ruleId: row.ruleId } })
      tools.emit(eventFor(timerFired, { subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { timerId: row.id, timerKey: row.timerKey, ruleId: row.ruleId, recordType: row.recordType, recordId: row.recordId } }))
      return count
    })
}

/** Fires one timer (the cron's work per timer; tests call it). */
export async function fireTimer(caller: CommandCaller, timerId: string, settings: CommandSettings): Promise<FireOutcome> {
  const peek = await caller.withClient((db) => db.dueTimer.findUnique({ where: { id: timerId }, select: { status: true, fireAt: true, ruleId: true, rule: { select: { ruleKind: true } } } }))
  // Not due yet, or done: no command (a stored answer would stand for the timer's key for good).
  if (!peek || peek.status !== 'PENDING' || peek.fireAt.getTime() > settings.clock.now().getTime()) return { outcome: 'SKIPPED' }
  const { result } = await runCommand(
    caller,
    { name: 'timers.fire', idempotencyKey: `timer-fire:${timerId}`, input: { timerId } },
    async (tools): Promise<FireOutcome> => {
      const { tx, now } = tools
      // The kind's lock before the timer's row: the rules' evaluation takes them in the same order.
      if (peek.rule) await lockKind(tx, tenantIdOf(tools.context), peek.rule.ruleKind)
      await tx.$queryRaw`SELECT id FROM "DueTimer" WHERE id = ${timerId}::uuid FOR UPDATE`
      const row = await tx.dueTimer.findUnique({ where: { id: timerId }, select: TIMER_COLUMNS })
      if (!row || row.status !== 'PENDING') {
        tools.audit({ action: 'timers.fire', recordType: 'DueTimer', recordId: timerId, after: { skipped: row?.status ?? 'MISSING' } })
        return { outcome: 'SKIPPED' }
      }
      const record = { type: row.recordType, id: row.recordId }
      if (row.ruleId === null) {
        await markFired(tools, row)
        return { outcome: 'FIRED' }
      }
      const rule = await tx.alertRule.findUnique({ where: { id: row.ruleId }, select: RULE_COLUMNS })
      if (!rule || !rule.enabled || !isRuleKind(rule.ruleKind) || KINDS[rule.ruleKind].trigger !== 'DATE') {
        await cancelTimerInCommand(tools, record, row.timerKey, 'RULE_OFF')
        return { outcome: 'CANCELLED' }
      }
      const kind = rule.ruleKind
      const [dated] = await datedFor(kind, tx, rule, now, [row.recordId])
      if (!dated) {
        await cancelTimerInCommand(tools, record, row.timerKey, 'GONE')
        return { outcome: 'CANCELLED' }
      }
      const dueDate = businessDate(row.dueAt)
      if (dated.date !== dueDate) {
        await cancelTimerInCommand(tools, record, row.timerKey, 'MOVED')
        return { outcome: 'CANCELLED' }
      }
      await markFired(tools, row)
      const dedupeKey = dedupeKeyOf(kind, row.recordId)
      const last = await tx.alert.findFirst({ where: { dedupeKey }, orderBy: { occurrence: 'desc' }, select: { state: true, occurrence: true, raisedAt: true } })
      if (last && last.state !== 'RESOLVED') return { outcome: 'FIRED' }
      if (last && now.getTime() - last.raisedAt.getTime() < rule.cooldownMinutes * 60_000) return { outcome: 'FIRED' }
      const threshold = thresholdOf(kind, rule.threshold) as { daysBefore: number; workingDays: boolean }
      await raiseInCommand(tools, {
        rule: { id: rule.id, severity: rule.severity },
        kind,
        finding: {
          recordType: row.recordType,
          recordId: row.recordId,
          label: dated.label,
          scope: dated.scope,
          facts: { dueDate, daysLeft: daysBetween(businessDate(now), dueDate), daysBefore: threshold.daysBefore, workingDays: threshold.workingDays, timerKey: row.timerKey },
        },
        dedupeKey,
        occurrence: (last?.occurrence ?? 0) + 1,
      })
      return { outcome: 'RAISED' }
    },
    settings,
  )
  return result
}

export interface FireRun {
  readonly tenants: number
  readonly fired: number
  readonly raised: number
  readonly cancelled: number
  readonly failed: number
}

/** One tick over every active tenant (the cron's; tests call it directly). */
export async function fireDueTimers(options: FireOptions): Promise<FireRun> {
  const clock = options.clock ?? serverClock
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock }
  const requestId = `timers-fire-${newId()}`
  const totals = { fired: 0, raised: 0, cancelled: 0, failed: 0 }
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    let due: { id: string }[]
    try {
      due = await caller.withClient((db) => db.dueTimer.findMany({ where: { status: 'PENDING', fireAt: { lte: clock.now() } }, orderBy: [{ fireAt: 'asc' }, { id: 'asc' }], take: FIRE_LIMIT, select: { id: true } }))
    } catch (error) {
      totals.failed++
      options.log.error({ err: error, tenantId }, 'the due timers of a tenant could not be read')
      continue
    }
    for (const timer of due) {
      try {
        const { outcome } = await fireTimer(caller, timer.id, settings)
        if (outcome === 'FIRED') totals.fired++
        else if (outcome === 'RAISED') {
          totals.fired++
          totals.raised++
        } else if (outcome === 'CANCELLED') totals.cancelled++
      } catch (error) {
        totals.failed++
        options.log.error({ err: error, tenantId, timerId: timer.id }, 'a timer could not be fired')
      }
    }
  }
  const run = { tenants: tenants.length, ...totals }
  if (run.fired + run.cancelled + run.failed > 0) options.log.info({ ...run }, 'date timers fired')
  return run
}

/** The scheduler's cron: every minute. */
export function timersFireCron(options: FireOptions): CronJob {
  return defineCron({
    name: 'timers.fire',
    schedule: '* * * * *',
    async run() {
      await fireDueTimers(options)
    },
  })
}
