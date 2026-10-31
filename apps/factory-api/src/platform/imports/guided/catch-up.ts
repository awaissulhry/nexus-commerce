import type { FactoryClient, FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandTools, type CommandTx } from '../../../core/command'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, asSystem, systemContext } from '../../outbox/system'
import { auditMarks } from './first-load'

/**
 * The first-load steps done before they had their table (B-W2b-24; B-W2a-41 kept an audit row `imports.firstLoadStepDone`
 * per "Done"; B-W2b-03 added FirstLoadStep): each such step gets its row from its latest audit row — the import it
 * matched (or "nothing to load" with its reason), when and by whom. A "nothing to load" marked before a reason was asked
 * says so in its reason (the table needs one). Until its row exists the guided first load reads the audit row (first-load.ts
 * doneMarks), so the worker's start and the daily cron (`imports.firstLoadCatchUp`, 03:30 Europe/Rome) may write them any
 * time. One system command per tenant, only when a step waits (an idle pass writes nothing).
 */

type Reader = FactoryClient | CommandTx

export const NO_REASON_THEN = 'Marked "nothing to load" before the reason was asked (B-W2a-41).'

interface StepToWrite {
  readonly companyId: string
  readonly step: string
  readonly jobId: string | null
  readonly reason: string | null
  readonly doneAt: Date
  readonly doneById: string
}

/** The steps an audit row says are done and that have no row yet. */
export async function stepsToWrite(db: Reader): Promise<StepToWrite[]> {
  const companies = await db.auditLog.findMany({ where: { action: 'imports.firstLoadStepDone', companyId: { not: null } }, select: { companyId: true }, distinct: ['companyId'], take: 200 })
  const out: StepToWrite[] = []
  for (const { companyId } of companies) {
    if (!companyId) continue
    const have = new Set((await db.firstLoadStep.findMany({ where: { companyId }, select: { step: true } })).map((row) => row.step))
    for (const [step, mark] of await auditMarks(db, companyId)) {
      if (have.has(step)) continue
      const nothing = mark.nothing || mark.jobId === null
      out.push({ companyId, step, jobId: nothing ? null : mark.jobId, reason: nothing ? mark.reason?.trim() || NO_REASON_THEN : null, doneAt: mark.at, doneById: mark.byId ?? SYSTEM_ACTOR_ID })
    }
  }
  return out
}

/** The work inside the tenant's system command: each step read again, its row written once. */
export async function writeSteps({ tx, audit, now, context }: CommandTools): Promise<number> {
  if (context.audience !== 'system') throw new Error('This catch-up runs as the system, one tenant at a time.')
  let written = 0
  for (const step of await stepsToWrite(tx)) {
    const id = newId()
    await tx.firstLoadStep.create({
      data: { id, companyId: step.companyId, step: step.step, jobId: step.jobId, nothingToLoad: step.jobId === null, reason: step.reason, doneAt: step.doneAt, doneById: step.doneById, createdAt: now, updatedAt: now, createdById: SYSTEM_ACTOR_ID },
      select: { id: true },
    })
    written++
    audit({ action: 'imports.firstLoadCatchUp', recordType: 'FirstLoadStep', recordId: id, companyId: step.companyId, after: { step: step.step, jobId: step.jobId, nothing: step.jobId === null, doneAt: toUtcIso(step.doneAt), from: 'audit' } })
  }
  if (written === 0) audit({ action: 'imports.firstLoadCatchUp', recordType: 'Tenant', recordId: context.tenantId, after: { written: 0 } })
  return written
}

export interface CatchUpOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export async function writeStepsAll(options: CatchUpOptions): Promise<{ readonly tenants: number; readonly written: number; readonly failed: number }> {
  const settings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `imports-first-load-catch-up-${newId()}`
  let written = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const pending = await asSystem(options.database, tenantId, requestId, (client) => stepsToWrite(client))
      if (pending.length === 0) continue
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const { result } = await runCommand(caller, { name: 'imports.firstLoadCatchUp', input: null }, writeSteps, settings)
      written += result
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, "the first-load steps of a tenant could not be written from the audit log")
    }
  }
  if (written > 0 || failed > 0) options.log.info({ tenants: tenants.length, written, failed }, 'first-load steps written from the audit log')
  return { tenants: tenants.length, written, failed }
}

/** The scheduler's daily cron (03:30 Europe/Rome; the worker's start does it after a deploy). */
export function firstLoadCatchUpCron(options: CatchUpOptions): CronJob {
  return defineCron({
    name: 'imports.firstLoadCatchUp',
    schedule: '30 3 * * *',
    async run() {
      await writeStepsAll(options)
    },
  })
}
