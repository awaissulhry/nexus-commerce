import type { FactoryClient, FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { addressOfSuppression, UNBLOCKED_PREFIX } from '@nexus/factory-domain/email-delivery/rules'
import { callerFor, COMMAND_SETTINGS, runCommand, type CommandTools, type CommandTx } from '../../../core/command'
import { SYSTEM_ACTOR_ID } from '../../../core/context'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, asSystem, systemContext } from '../../outbox/system'

/**
 * The blocks B-W2a-41 lifted before the lift had its columns (B-W2b-24; B-W2b-03 note "IN THE SAME DEPLOY"): such a row
 * had its address moved aside as `~unblocked:<id>:<address>`. Here each goes back to its address with the lift written in
 * its columns from its `email.unblockAddress` audit row (when, who, why). Until it moved, every reader counts it as lifted
 * (log.ts IN_FORCE / LIFTED; the sends look a block up by its exact address, which the moved-aside row never matched), so
 * the worker's start after the deploy and the daily cron (`email.liftCatchUp`, 03:25 Europe/Rome) can move them at any
 * time. One system command per tenant, only when a row waits (an idle pass writes nothing).
 */

type Reader = FactoryClient | CommandTx

/** The moved-aside rows still waiting, with what their audit row says. */
export async function liftsToMove(db: Reader): Promise<{ readonly id: string; readonly address: string; readonly liftedAt: Date; readonly liftedById: string; readonly liftReason: string }[]> {
  const rows = await db.suppression.findMany({ where: { liftedAt: null, address: { startsWith: UNBLOCKED_PREFIX } }, select: { id: true, address: true, updatedAt: true }, orderBy: { id: 'asc' }, take: 500 })
  if (rows.length === 0) return []
  const audits = await db.auditLog.findMany({
    where: { recordType: 'Suppression', recordId: { in: rows.map((row) => row.id) }, action: 'email.unblockAddress' },
    select: { recordId: true, at: true, actorId: true, audience: true, reason: true },
    orderBy: { at: 'desc' },
  })
  return rows.map((row) => {
    const audit = audits.find((entry) => entry.recordId === row.id)
    return {
      id: row.id,
      address: addressOfSuppression(row.address),
      liftedAt: audit?.at ?? row.updatedAt,
      liftedById: audit && audit.audience === 'OFFICE' ? audit.actorId : SYSTEM_ACTOR_ID,
      liftReason: audit?.reason?.trim() || 'Unblocked before the lift was recorded on the row (B-W2a-41).',
    }
  })
}

/** The work inside the tenant's system command: each row read again (still moved aside, still not lifted). */
export async function moveLifts({ tx, audit, context }: CommandTools): Promise<number> {
  if (context.audience !== 'system') throw new Error('This catch-up runs as the system, one tenant at a time.')
  let moved = 0
  for (const lift of await liftsToMove(tx)) {
    const { count } = await tx.suppression.updateMany({
      where: { id: lift.id, liftedAt: null, address: { startsWith: UNBLOCKED_PREFIX } },
      data: { address: lift.address, liftedAt: lift.liftedAt, liftedById: lift.liftedById, liftReason: lift.liftReason },
    })
    if (count !== 1) continue
    moved++
    audit({ action: 'email.liftCatchUp', recordType: 'Suppression', recordId: lift.id, companyId: null, before: { movedAside: true }, after: { liftedAt: toUtcIso(lift.liftedAt), from: 'audit' } })
  }
  if (moved === 0) audit({ action: 'email.liftCatchUp', recordType: 'Tenant', recordId: context.tenantId, after: { moved: 0 } })
  return moved
}

export interface CatchUpOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

export async function moveLiftsAll(options: CatchUpOptions): Promise<{ readonly tenants: number; readonly moved: number; readonly failed: number }> {
  const settings = { ...COMMAND_SETTINGS, clock: options.clock ?? serverClock }
  const requestId = `email-lift-catch-up-${newId()}`
  let moved = 0
  let failed = 0
  const tenants = await activeTenants(options.database)
  for (const tenantId of tenants) {
    try {
      const pending = await asSystem(options.database, tenantId, requestId, (client) => liftsToMove(client))
      if (pending.length === 0) continue
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const { result } = await runCommand(caller, { name: 'email.liftCatchUp', input: null }, moveLifts, settings)
      moved += result
    } catch (error) {
      failed++
      options.log.error({ err: error, tenantId }, "the unblocked addresses of a tenant could not be moved to the lift's columns")
    }
  }
  if (moved > 0 || failed > 0) options.log.info({ tenants: tenants.length, moved, failed }, "unblocked addresses moved to the lift's columns")
  return { tenants: tenants.length, moved, failed }
}

/** The scheduler's daily cron (03:25 Europe/Rome; the worker's start does it after a deploy). */
export function liftCatchUpCron(options: CatchUpOptions): CronJob {
  return defineCron({
    name: 'email.liftCatchUp',
    schedule: '25 3 * * *',
    async run() {
      await moveLiftsAll(options)
    },
  })
}
