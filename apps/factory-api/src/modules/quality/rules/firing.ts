import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { holdLabel } from '@nexus/factory-domain/quality/holds/rules'
import { daysStepDue, EVENT_FACTS, firingKey, rulesInForce, waitDue, type AlertRecordType, type QualityAlertEvent } from '@nexus/factory-domain/quality/rules/alerts'
import { dutiesInForce, isFourEyesCondition, secondPersonNeeded, type DutiesRow } from '@nexus/factory-domain/quality/rules/duties'
import type { FourEyesRule } from '@nexus/factory-domain/quality/release/rules'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { activeTenants, systemContext } from '../../../platform/outbox/system'
import { FIRED_ACTION, RULE_COLUMNS, type Db, type RuleRow } from './store'

/**
 * When a quality alert rule fires (B-W2b-118; QHS-154), as the tenant's system. Two ways in, one way out:
 *
 *   the handler `quality.alertRules`  (background.ts) at once on the record's own event: quality.hold_placed,
 *                                     ncr.created (a critical one), complaint.safety_raised → the rules of that event in
 *                                     force for the record's company with no wait
 *   the cron `quality.alertRules`     (background.ts, every 5 minutes) every rule but CAPA_ACTION_OVERDUE (B-W2b-108's
 *                                     reminders escalate those): a wait crossed (the hold still on hold, the NCR still open,
 *                                     the safety complaint still not acknowledged, the inspection not signed, the passed
 *                                     inspection whose release still waits for its second person), a certificate's date
 *                                     step reached, and a missed at-once firing of the last day (a worker that was down)
 *   ONE system command per firing     keyed `quality-alert:<rule>:<record>:<step>[:<date>]`: the rule still on, not told
 *                                     yet (the rule's audit trail holds the key: told once, whatever the receipts' age),
 *                                     an audit row on the rule (FIRED_ACTION) and `quality.alert_fired`; the bell's
 *                                     fan-out (./notices.ts) tells the audience
 *
 * Per rule and tick at most MAX_PER_RULE firings (a rule added over many old records never floods the bell).
 */

const MAX_PER_RULE = 200
const CANDIDATES = 500
/** An at-once firing missed by the handler is caught up for this long (and only for records after the rule existed). */
const CATCH_UP_MS = 24 * 60 * 60_000

export interface Candidate {
  readonly recordType: AlertRecordType
  readonly recordId: string
  readonly label: string
  readonly companyId: string | null
  readonly siteId: string | null
  /** The moment a wait counts from (placed, raised, opened, decided). */
  readonly since: Date
  /** A safety complaint already acknowledged (a waiting rule stops); a certificate's last valid day. */
  readonly settled?: boolean
  readonly date?: BusinessDate
}

const isoDay = (value: Date): BusinessDate => value.toISOString().slice(0, 10)

/** The records an event's rules look at (all of them, or the one `recordId`). */
export async function candidatesOf(db: Db, event: QualityAlertEvent, now: Date, recordId?: string): Promise<Candidate[]> {
  const one = recordId ? { id: recordId } : {}
  switch (event) {
    case 'HOLD_PLACED': {
      const rows = await db.qualityHold.findMany({ where: { ...one, status: 'ACTIVE' }, orderBy: [{ placedAt: 'desc' }], take: CANDIDATES, select: { id: true, number: true, companyId: true, siteId: true, placedAt: true } })
      return rows.map((row) => ({ recordType: 'QualityHold', recordId: row.id, label: holdLabel(row), companyId: row.companyId, siteId: row.siteId, since: row.placedAt }))
    }
    case 'CRITICAL_NCR': {
      const rows = await db.nonconformance.findMany({ where: { ...one, severity: 'CRITICAL', stage: { notIn: ['CLOSED', 'CANCELLED'] } }, orderBy: [{ createdAt: 'desc' }], take: CANDIDATES, select: { id: true, number: true, companyId: true, siteId: true, createdAt: true } })
      return rows.map((row) => ({ recordType: 'Nonconformance', recordId: row.id, label: row.number, companyId: row.companyId, siteId: row.siteId, since: row.createdAt }))
    }
    case 'SAFETY_COMPLAINT': {
      const rows = await db.complaint.findMany({ where: { ...one, safetyRaisedAt: { not: null }, status: { not: 'CLOSED' } }, orderBy: [{ safetyRaisedAt: 'desc' }], take: CANDIDATES, select: { id: true, number: true, companyId: true, safetyRaisedAt: true, safetyAcknowledgedAt: true } })
      return rows.map((row) => ({ recordType: 'Complaint', recordId: row.id, label: row.number, companyId: row.companyId, siteId: null, since: row.safetyRaisedAt!, settled: row.safetyAcknowledgedAt !== null }))
    }
    case 'INSPECTION_WAITING': {
      const finals = await db.inspection.findMany({ where: { ...one, status: 'OPEN' }, orderBy: [{ createdAt: 'desc' }], take: CANDIDATES, select: { id: true, number: true, companyId: true, siteId: true, createdAt: true } })
      const incoming = await db.incomingInspection.findMany({ where: { ...one, status: 'OPEN' }, orderBy: [{ createdAt: 'desc' }], take: CANDIDATES, select: { id: true, number: true, companyId: true, siteId: true, createdAt: true } })
      return [
        ...finals.map((row): Candidate => ({ recordType: 'Inspection', recordId: row.id, label: row.number ?? `inspection ${row.id.slice(0, 8)}`, companyId: row.companyId, siteId: row.siteId, since: row.createdAt })),
        ...incoming.map((row): Candidate => ({ recordType: 'IncomingInspection', recordId: row.id, label: row.number, companyId: row.companyId, siteId: row.siteId, since: row.createdAt })),
      ]
    }
    case 'RELEASE_WAITING_SECOND_PERSON':
      return releasesWaiting(db, recordId)
    case 'CERTIFICATE_EXPIRING': {
      const today = businessDate(now)
      const rows = await db.certificate.findMany({ where: { ...one, status: 'VALID', validTo: { gte: new Date(`${today}T00:00:00Z`), lte: new Date(Date.parse(`${today}T00:00:00Z`) + 731 * 86_400_000) } }, orderBy: [{ validTo: 'asc' }], take: CANDIDATES, select: { id: true, number: true, companyId: true, validTo: true, createdAt: true } })
      return rows.map((row) => ({ recordType: 'Certificate', recordId: row.id, label: row.number, companyId: row.companyId, siteId: null, since: row.createdAt, date: isoDay(row.validTo) }))
    }
    case 'CAPA_ACTION_OVERDUE':
      return []
  }
}

/**
 * PASSED inspections nothing was released from yet whose release needs a second person by the rules in force (the
 * database writes the same reasons): an override while OVERRIDE is a condition, a listed customer's garments while
 * CUSTOMER is, or every release (ALWAYS).
 */
async function releasesWaiting(db: Db, recordId?: string): Promise<Candidate[]> {
  const rows = await db.inspection.findMany({ where: { ...(recordId ? { id: recordId } : {}), status: 'PASSED', decidedAt: { not: null } }, orderBy: [{ decidedAt: 'desc' }], take: CANDIDATES, select: { id: true, number: true, companyId: true, siteId: true, workOrderId: true, decidedAt: true, overrideReason: true } })
  if (rows.length === 0) return []
  const released = new Set((await db.qualityRelease.findMany({ where: { inspectionId: { in: rows.map((row) => row.id) } }, select: { inspectionId: true } })).map((row) => row.inspectionId))
  const waiting = rows.filter((row) => !released.has(row.id))
  if (waiting.length === 0) return []
  const cells = await db.workOrderSize.findMany({ where: { workOrderId: { in: [...new Set(waiting.map((row) => row.workOrderId))] } }, select: { workOrderId: true, partyId: true } })
  const settings = await db.qualitySettings.findMany({ select: { id: true, companyId: true, releaseFourEyes: true, fourEyesConditions: true, secondPersonPartyIds: true, placerMayRelease: true } })
  const rowOf = (row: (typeof settings)[number] | undefined): DutiesRow | null =>
    row ? { releaseFourEyes: (row.releaseFourEyes ?? null) as FourEyesRule | null, fourEyesConditions: row.fourEyesConditions.filter(isFourEyesCondition), secondPersonPartyIds: row.secondPersonPartyIds, placerMayRelease: row.placerMayRelease } : null
  const tenant = rowOf(settings.find((row) => row.companyId === null))
  return waiting
    .filter((row) => {
      const inForce = dutiesInForce(rowOf(settings.find((entry) => entry.companyId === row.companyId)), tenant)
      const listed = cells.some((cell) => cell.workOrderId === row.workOrderId && cell.partyId !== null && inForce.customers.includes(cell.partyId))
      return secondPersonNeeded({ overridden: row.overrideReason !== null, customerListed: listed, inForce }).length > 0
    })
    .map((row) => ({ recordType: 'Inspection' as const, recordId: row.id, label: row.number ?? `inspection ${row.id.slice(0, 8)}`, companyId: row.companyId, siteId: row.siteId, since: row.decidedAt! }))
}

/** A firing due now for a rule and a record: its step and date, or null. */
export function dueStep(rule: RuleRow, candidate: Candidate, now: Date): { step: number; date: BusinessDate | null } | null {
  const facts = EVENT_FACTS[rule.event]
  if (facts.timing === 'ESCALATION') return null
  if (facts.timing === 'DAYS') {
    if (!candidate.date) return null
    const step = daysStepDue(candidate.date, businessDate(now), rule.daysBefore)
    return step === null ? null : { step, date: candidate.date }
  }
  if (facts.timing === 'EVENT' && rule.withinMinutes === 0) {
    // At once: the handler fires it; the cron catches up a missed one of the last day, for records after the rule existed.
    const at = candidate.since.getTime()
    return at >= rule.createdAt.getTime() && at <= now.getTime() && now.getTime() - at <= CATCH_UP_MS ? { step: 0, date: null } : null
  }
  // A wait: the record is still so (a safety complaint not acknowledged yet).
  if (candidate.settled) return null
  return waitDue(candidate.since, rule.withinMinutes, now).due ? { step: 0, date: null } : null
}

class NothingDue extends Error {}

/** One firing in its own system command; false when it was told already or the rule is off. */
export async function fireOnce(caller: CommandCaller, rule: RuleRow, candidate: Candidate, step: number, date: BusinessDate | null, settings: CommandSettings = COMMAND_SETTINGS): Promise<boolean> {
  const key = firingKey(rule.id, candidate.recordId, step, date)
  try {
    const { replayed } = await runCommand(
      caller,
      { name: 'quality.alertFire', idempotencyKey: key, input: { ruleId: rule.id, recordId: candidate.recordId, step, date } },
      async (tools) => {
        const { tx } = tools
        const current = await tx.qualityAlertRule.findUnique({ where: { id: rule.id }, select: { enabled: true, audience: true } })
        if (!current || !current.enabled) throw new NothingDue()
        const told = await tx.auditLog.findFirst({ where: { recordType: 'QualityAlertRule', recordId: rule.id, action: FIRED_ACTION, after: { path: ['key'], equals: key } }, select: { id: true } })
        if (told) throw new NothingDue()
        tools.audit({ action: FIRED_ACTION, recordType: 'QualityAlertRule', recordId: rule.id, companyId: candidate.companyId, after: { key, event: rule.event, recordType: candidate.recordType, recordId: candidate.recordId, step, date } })
        tools.emit({
          type: 'quality.alert_fired',
          subject: candidate.recordId,
          companyId: candidate.companyId,
          siteId: candidate.siteId,
          payload: { ruleId: rule.id, event: rule.event, audience: current.audience, recordType: candidate.recordType, recordId: candidate.recordId, label: candidate.label.slice(0, 80), companyId: candidate.companyId, siteId: candidate.siteId, step, date, testFor: null },
        })
        return { key }
      },
      settings,
    )
    // A repeated key answers from its receipt: told already.
    return !replayed
  } catch (error) {
    if (error instanceof NothingDue) return false
    throw error
  }
}

const allRulesOf = async (db: Db): Promise<RuleRow[]> => (await db.qualityAlertRule.findMany({ where: { event: { not: 'CAPA_ACTION_OVERDUE' } }, select: RULE_COLUMNS })) as unknown as RuleRow[]

/** Every rule of one tenant once (the cron's body for a tenant). */
export async function evaluateTenant(caller: CommandCaller, now: Date, settings: CommandSettings = COMMAND_SETTINGS, log?: Log): Promise<{ fired: number; failed: number }> {
  const all = await caller.withClient((db) => allRulesOf(db))
  const on = all.filter((rule) => rule.enabled)
  let fired = 0
  let failed = 0
  for (const event of [...new Set(on.map((rule) => rule.event))]) {
    const candidates = await caller.withClient((db) => candidatesOf(db, event, now))
    const perRule = new Map<string, number>()
    for (const candidate of candidates) {
      for (const rule of rulesInForce(all, candidate.companyId, event)) {
        const due = dueStep(rule, candidate, now)
        if (!due || (perRule.get(rule.id) ?? 0) >= MAX_PER_RULE) continue
        try {
          if (await fireOnce(caller, rule, candidate, due.step, due.date, settings)) {
            fired++
            perRule.set(rule.id, (perRule.get(rule.id) ?? 0) + 1)
          }
        } catch (error) {
          failed++
          log?.error({ err: error, ruleId: rule.id, recordId: candidate.recordId }, 'a quality alert rule could not fire')
        }
      }
    }
  }
  return { fired, failed }
}

export interface FiringOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

/** One pass over every tenant (the cron's body; tests call it with a moved clock). */
export async function runAlertRules(options: FiringOptions): Promise<{ readonly tenants: number; readonly fired: number; readonly failed: number }> {
  const settings: CommandSettings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `quality-alert-rules-${newId()}`
  let fired = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const result = await evaluateTenant(caller, settings.clock.now(), settings, options.log)
    fired += result.fired
    failed += result.failed
  }
  if (fired + failed > 0) options.log.info({ tenants: tenants.length, fired, failed }, 'quality alert rules fired')
  return { tenants: tenants.length, fired, failed }
}

/** The clustered cron (scheduler only; one replica per tick): every 5 minutes. */
export function alertRulesCron(options: FiringOptions): CronJob {
  return defineCron({
    name: 'quality.alertRules',
    schedule: '*/5 * * * *',
    async run() {
      await runAlertRules(options)
    },
  })
}

// ---- at once, on the record's own event ---------------------------------------------------------------------------------

const AT_ONCE: Readonly<Record<string, { readonly event: QualityAlertEvent; readonly idOf: (payload: Record<string, unknown>) => string | null }>> = Object.freeze({
  'quality.hold_placed': { event: 'HOLD_PLACED', idOf: (payload) => (typeof payload.holdId === 'string' ? payload.holdId : null) },
  'ncr.created': { event: 'CRITICAL_NCR', idOf: (payload) => (payload.severity === 'CRITICAL' && typeof payload.ncrId === 'string' ? payload.ncrId : null) },
  'complaint.safety_raised': { event: 'SAFETY_COMPLAINT', idOf: (payload) => (typeof payload.complaintId === 'string' ? payload.complaintId : null) },
})

/** The at-once rules of the event for the record: one firing each (the same command and key as the cron's catch-up). */
export async function fireAtOnce(caller: CommandCaller, event: Pick<EventEnvelope, 'type' | 'payload'>, now: Date): Promise<number> {
  const entry = AT_ONCE[event.type]
  const recordId = entry ? entry.idOf((event.payload ?? {}) as Record<string, unknown>) : null
  if (!entry || !recordId) return 0
  const all = await caller.withClient((db) => allRulesOf(db))
  if (!all.some((rule) => rule.enabled && rule.event === entry.event && rule.withinMinutes === 0)) return 0
  const [candidate] = await caller.withClient((db) => candidatesOf(db, entry.event, now, recordId))
  if (!candidate) return 0
  let fired = 0
  for (const rule of rulesInForce(all, candidate.companyId, entry.event)) {
    if (rule.withinMinutes !== 0) continue
    if (await fireOnce(caller, rule, candidate, 0, null)) fired++
  }
  return fired
}

export function alertRulesHandler(): EventHandler {
  return defineHandler({
    name: 'quality.alertRules',
    events: Object.keys(AT_ONCE),
    async handle(event, tools) {
      await fireAtOnce(tools.caller, event, new Date())
    },
  })
}

