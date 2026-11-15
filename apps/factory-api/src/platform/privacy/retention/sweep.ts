import type { FactoryDatabase } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDayStart } from '@nexus/factory-domain/core/time'
import { cutoffOf, RULE_HELD_WORDS, RULE_LIMITS, sweepModeOf, type RetentionAction, type SweepFailure } from '@nexus/factory-domain/privacy/retention/retention'
import { callerFor, command, type CommandCaller, type CommandTx } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { activeTenants, systemContext } from '../../outbox/system'
import { dateOf } from '../access'
import { retentionTypeOf } from './rules'
import type { Reader, SweepScope } from './rules/type'

/**
 * The retention sweep (B-W2b-405; PLT-204; GDPR art. 5(1)(e)): one pass over one rule, written as one RetentionSweep row. The
 * scheduler's clustered cron `privacy.retentionSweep` (nightly at 02:50 Europe/Rome) sweeps every ACTIVE rule of every active
 * tenant in its system scope; a person sweeps one rule now (POST /privacy/retention/rules/:ruleId/sweep).
 *
 * GATE-PRIVACY: a rule REPORTS (counts what is due, changes nothing) until a person switched it on to apply (applyOn, with a
 * fresh code); the database refuses an APPLY sweep otherwise. An applying sweep takes at most RULE_LIMITS.perSweep records (the
 * next sweep takes the rest) and does what the record type's entry says (rules/*.ts). ONE command: the sweep RUNNING, the due
 * records read and the action applied in its transaction, the sweep DONE; a refusal rolls it back and a FAILED sweep is written in
 * its own command with the code (DB_REFUSED). The append-only ledgers are never swept (no entry names them).
 */

export const SWEEP_JOB = 'privacy.retentionSweep'
export const SWEEP_SCHEDULE = '50 2 * * *'
export const SWEEP_SCHEDULE_WORDS = 'Every night at 02:50 (Europe/Rome), every rule that is on; a rule only reports until a person switches it on to apply (GATE-PRIVACY).'

/** The records a rule covers: its company's, or (a tenant-wide rule) those of companies without an active rule of their own. */
export async function scopeOf(db: Reader, rule: { readonly companyId: string | null; readonly recordType: string }): Promise<SweepScope> {
  if (rule.companyId !== null) return { companyId: rule.companyId, exceptCompanies: [] }
  const own = await db.retentionRule.findMany({ where: { recordType: rule.recordType, active: true, companyId: { not: null } }, select: { companyId: true } })
  return { companyId: null, exceptCompanies: own.map((row) => row.companyId!).filter((value, index, all) => all.indexOf(value) === index) }
}

interface RuleRow {
  readonly id: string
  readonly companyId: string | null
  readonly recordType: string
  readonly keepMonths: number
  readonly thenAction: RetentionAction
  readonly active: boolean
  readonly applyOn: boolean
}

async function ruleFor(tx: CommandTx, ruleId: string): Promise<RuleRow> {
  // FOR SHARE as the database's check: a rule switched off or on meanwhile waits for the sweep.
  await tx.$queryRaw`SELECT id FROM "RetentionRule" WHERE id = ${ruleId}::uuid FOR SHARE`
  const rule = await tx.retentionRule.findUnique({ where: { id: ruleId }, select: { id: true, companyId: true, recordType: true, keepMonths: true, thenAction: true, active: true, applyOn: true } })
  if (!rule) throw new NotFoundError('Retention rule not found.')
  if (!rule.active) throw new InvalidStateError(RULE_HELD_WORDS.SWITCHED_OFF)
  return rule as RuleRow
}

/** A sweep that failed, in its own command (the failed one rolled back): RUNNING → FAILED with the code. */
async function failedSweep(caller: CommandCaller, ruleId: string, code: SweepFailure, requestedById: string | null): Promise<string> {
  const { result } = await command(caller, { name: 'privacy.retentionSweepFailed', input: { ruleId, code } }, async (tools) => {
    const rule = await ruleFor(tools.tx, ruleId)
    const id = newId()
    const cutoff = cutoffOf(tools.now, rule.keepMonths)
    await tools.tx.retentionSweep.create({ data: { id, ruleId, mode: 'REPORT', keepMonths: rule.keepMonths, thenAction: rule.thenAction, cutoffOn: dateOf(cutoff), status: 'RUNNING', startedAt: tools.now, requestedById }, select: { id: true } })
    await tools.tx.retentionSweep.update({ where: { id }, data: { status: 'FAILED', finishedAt: tools.now, failedCount: 0, failures: [{ code }] }, select: { id: true } })
    tools.audit({ recordType: 'RetentionSweep', recordId: id, companyId: rule.companyId, after: { ruleId, recordType: rule.recordType, mode: 'REPORT', status: 'FAILED', failure: code } })
    tools.emit({ type: 'privacy.retention_swept', subject: ruleId, companyId: rule.companyId, payload: { sweepId: id, ruleId, recordType: rule.recordType, mode: 'REPORT', status: 'FAILED', due: 0, applied: 0, held: 0, failed: 0 } })
    return id
  })
  return result
}

/** Sweeps one rule now (the cron's and the route's): the sweep's id. A rule switched off answers 409 in words. */
export async function sweepRule(caller: CommandCaller, ruleId: string, options: { readonly requestedById: string | null; readonly log?: Log }): Promise<string> {
  try {
    const { result } = await command(caller, { name: 'privacy.retentionSweep', input: { ruleId, requestedById: options.requestedById } }, async (tools) => {
      const { tx, now } = tools
      const rule = await ruleFor(tx, ruleId)
      const type = retentionTypeOf(rule.recordType)
      const mode = type ? sweepModeOf(rule) : 'REPORT'
      const cutoff = cutoffOf(now, rule.keepMonths)
      const id = newId()
      await tx.retentionSweep.create({ data: { id, ruleId, mode, keepMonths: rule.keepMonths, thenAction: rule.thenAction, cutoffOn: dateOf(cutoff), status: 'RUNNING', startedAt: now, requestedById: options.requestedById }, select: { id: true } })
      let counts = { due: 0, applied: 0, held: 0 }
      if (!type) {
        await tx.retentionSweep.update({ where: { id }, data: { status: 'FAILED', finishedAt: now, failures: [{ code: 'UNKNOWN_TYPE' }] }, select: { id: true } })
      } else {
        const due = await type.due(tx, await scopeOf(tx, rule), { instant: businessDayStart(cutoff), day: dateOf(cutoff) }, now, RULE_LIMITS.perSweep)
        counts = { due: due.total, applied: 0, held: 0 }
        if (mode === 'APPLY' && due.ids.length > 0) {
          const outcome = await type.apply(tx, rule.thenAction, due.ids, now)
          counts = { due: due.total, applied: outcome.applied, held: outcome.held ? due.ids.length - outcome.applied : 0 }
        }
        await tx.retentionSweep.update({ where: { id }, data: { status: 'DONE', finishedAt: now, dueCount: counts.due, appliedCount: counts.applied, heldCount: counts.held }, select: { id: true } })
      }
      const status = type ? 'DONE' : 'FAILED'
      tools.audit({ recordType: 'RetentionSweep', recordId: id, companyId: rule.companyId, after: { ruleId, recordType: rule.recordType, mode, cutoffOn: cutoff, status, ...counts } })
      tools.emit({ type: 'privacy.retention_swept', subject: ruleId, companyId: rule.companyId, payload: { sweepId: id, ruleId, recordType: rule.recordType, mode, status, due: counts.due, applied: counts.applied, held: counts.held, failed: 0 } })
      return id
    })
    return result
  } catch (error) {
    if (error instanceof InvalidStateError || error instanceof NotFoundError) throw error
    options.log?.warn({ err: error, ruleId }, 'a retention sweep was refused; recorded as FAILED')
    return failedSweep(caller, ruleId, 'DB_REFUSED', options.requestedById)
  }
}

export interface SweepCronOptions {
  readonly database: FactoryDatabase
  readonly log: Log
}

/** One night over every active tenant (the cron's; tests call it directly): how many sweeps ran and failed. */
export async function runRetentionSweeps(options: SweepCronOptions): Promise<{ swept: number; failed: number }> {
  const requestId = `retention-sweep-${newId()}`
  const totals = { swept: 0, failed: 0 }
  for (const tenantId of await activeTenants(options.database)) {
    const caller = callerFor(options.database, systemContext(tenantId, requestId))
    const rules = await caller.withClient((client) => client.retentionRule.findMany({ where: { active: true }, select: { id: true }, orderBy: [{ recordType: 'asc' }, { id: 'asc' }] }))
    for (const rule of rules) {
      try {
        await sweepRule(caller, rule.id, { requestedById: null, log: options.log })
        totals.swept += 1
      } catch (error) {
        totals.failed += 1
        options.log.error({ err: error, tenantId, ruleId: rule.id }, 'a retention sweep failed; tried again next night')
      }
    }
  }
  if (totals.swept + totals.failed > 0) options.log.info(totals, 'retention sweeps done')
  return totals
}

export function retentionSweepCron(options: SweepCronOptions): CronJob {
  return defineCron({
    name: SWEEP_JOB,
    schedule: SWEEP_SCHEDULE,
    lockTtlMs: 1_800_000,
    async run() {
      await runRetentionSweeps(options)
    },
  })
}
