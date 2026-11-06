import type { FactoryDatabase } from '@nexus/factory-db'
import { PORTAL_CODE } from '@nexus/factory-domain/auth/portal/codes'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { callerFor, command } from '../../../core/command'
import { defineCron, type CronJob } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { serverClock, type Clock } from '../../../core/time'
import { activeTenants, systemContext } from '../../outbox/system'

/**
 * The purge of dead portal codes (B-W2b-159; PLT-050; GDPR art. 5(1)(e): kept no longer than needed): the scheduler's
 * clustered cron `portal.purgeCodes`, every hour at minute 41, per ACTIVE tenant in its system context. Every code dies
 * 15 minutes after it was made at the latest; a code expired more than a day ago (PORTAL_CODE.keepDeadMs: long enough
 * for the security log of a recent sign-in) is deleted, at most 1000 per tenant and tick (the next tick takes the rest),
 * in ONE command per tenant with one audit row (how many, up to when). The database lets the office role delete codes
 * (the purge) and nothing else ever does.
 */

export interface PurgeOptions {
  readonly database: FactoryDatabase
  readonly log: Log
  readonly clock?: Clock
}

const BATCH = 1000

/** One tick over every active tenant (the cron's; tests call it directly). Returns how many codes were deleted. */
export async function purgePortalCodes(options: PurgeOptions): Promise<number> {
  const now = (options.clock ?? serverClock).now()
  const before = new Date(now.getTime() - PORTAL_CODE.keepDeadMs)
  const requestId = `portal-purge-${newId()}`
  let purged = 0
  for (const tenantId of await activeTenants(options.database)) {
    try {
      const caller = callerFor(options.database, systemContext(tenantId, requestId))
      const due = await caller.withClient((client) => client.portalSignInCode.findMany({ where: { expiresAt: { lt: before } }, select: { id: true }, orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }], take: BATCH }))
      if (due.length === 0) continue
      const { result } = await command(caller, { name: 'portal.purgeCodes', input: { before: toUtcIso(before), count: due.length } }, async ({ tx, audit }) => {
        const { count } = await tx.portalSignInCode.deleteMany({ where: { id: { in: due.map((row) => row.id) }, expiresAt: { lt: before } } })
        audit({ recordType: 'Tenant', recordId: tenantId, companyId: null, after: { portalCodesDeleted: count, expiredBefore: toUtcIso(before) } })
        return count
      })
      purged += result
    } catch (error) {
      options.log.error({ err: error, tenantId }, 'the dead portal codes of a tenant could not be purged')
    }
  }
  if (purged > 0) options.log.info({ purged }, 'dead portal codes purged')
  return purged
}

/** The scheduler's cron: every hour at minute 41. */
export function portalCodePurgeCron(options: PurgeOptions): CronJob {
  return defineCron({
    name: 'portal.purgeCodes',
    schedule: '41 * * * *',
    lockTtlMs: 600_000,
    async run() {
      await purgePortalCodes(options)
    },
  })
}
