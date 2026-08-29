/**
 * CX.3b — put the operator's Ads decisions back on the scope.
 *
 * The CX.3a migration seeded `mode` / `writesEnabledAt` / `lastWriteAt` into each
 * profile scope's metadata. The heartbeats that ran before the metadata-merge fix
 * (`4be9d2c53`) shipped **replaced** that metadata with what discovery knew, and
 * discovery does not know an operator decision — so those three fields were dropped.
 * Measured on prod 2026-08-29: all nine EU profiles came back with `mode: null`.
 *
 * This copies them back from `AmazonAdsConnection`, which is still the system of
 * record for them, merging so nothing discovery wrote is lost in the other direction.
 * Idempotent, registry-triggered (`cx3b-ads-decisions-reseed`), safe to re-run.
 *
 * It is a repair, not a sync: CX.3c moves ownership of these fields onto the scope for
 * good, at which point the row stops being the source and this job stops being useful.
 */
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

export async function runAdsDecisionsReseed(): Promise<string> {
  return recordCronRun('cx3b-ads-decisions-reseed', async () => {
    // MAP.3 — DECLARED: the channel's primary Ads account, not whichever row came back.
    const { tryResolveConnection } = await import('../services/connection-resolver.service.js')
    const conn = await tryResolveConnection({ channel: 'AMAZON_ADS', primary: true })
    if (!conn) return 'no AMAZON_ADS connection — nothing to reseed'

    const rows = await prisma.amazonAdsConnection.findMany({
      select: { profileId: true, mode: true, writesEnabledAt: true, lastWriteAt: true },
    })
    if (rows.length === 0) return 'no AmazonAdsConnection rows — nothing to reseed'

    let written = 0
    let unchanged = 0
    let noScope = 0

    for (const row of rows) {
      const scope = await prisma.connectionScope.findUnique({
        where: { connectionId_kind_externalId: { connectionId: conn.id, kind: 'profile', externalId: row.profileId } },
        select: { metadata: true },
      })
      if (!scope) {
        noScope++
        continue
      }
      const meta = (scope.metadata ?? {}) as Record<string, unknown>
      const want = {
        mode: row.mode,
        writesEnabledAt: row.writesEnabledAt ? row.writesEnabledAt.toISOString() : null,
        lastWriteAt: row.lastWriteAt ? row.lastWriteAt.toISOString() : null,
      }
      if (meta.mode === want.mode && meta.writesEnabledAt === want.writesEnabledAt && meta.lastWriteAt === want.lastWriteAt) {
        unchanged++
        continue
      }
      await prisma.connectionScope.update({
        where: { connectionId_kind_externalId: { connectionId: conn.id, kind: 'profile', externalId: row.profileId } },
        // Merge: discovery's facts (market, currency, account) must survive a repair
        // of the operator's, exactly as the operator's must survive discovery.
        data: { metadata: { ...meta, ...want } as never, isActive: row.mode === 'production' },
      })
      written++
    }

    if (noScope > 0) {
      logger.warn('[cx3b] some Ads profiles have no scope row', { noScope })
    }
    return `profiles=${rows.length} written=${written} unchanged=${unchanged} noScope=${noScope}`
  })
}
