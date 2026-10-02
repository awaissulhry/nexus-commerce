/**
 * MCP full control L4 — the studio publication settle sweep (plan section 02, step 4).
 *
 * A publication's result is settled when someone reads it (`studio-publication.service.ts`): an Amazon feed reports what
 * it accepted, an eBay item is read back. A publish Claude asked for and a person approved is read by nobody, so its
 * Amazon draft would stay a draft in Nexus and the prices held for it would never be sent. This sweep is that reader:
 * every 5 minutes, per business, publications left SUBMITTED (Amazon) or UNVERIFIED (eBay Trading) for more than
 * 2 minutes — sent within the last 30 days, at most 50 a run — settle through `publicationResultFor`, the same step the
 * studio's status read runs. A settled one leaves the set; one the channel has not finished stays for the next run.
 *
 * OFF by default: settling reads Amazon feed results and eBay items through the channel gateway, and a draft that goes
 * live sends its held prices once. `NEXUS_STUDIO_PUBLICATION_SETTLE=1` turns it on; `NEXUS_STUDIO_PUBLICATION_SETTLE_SCHEDULE`
 * moves it. Scheduled only through lib/cron/clustered.ts (once per active business when business profiles are on).
 */
import cron from '../lib/cron/clustered.js'
import { visitActiveWorkspaces } from '../lib/workspace-sweep.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'

const JOB_NAME = 'studio-publication-settle'
/** A publication younger than this is left to the request that sent it. */
export const SETTLE_AFTER_MS = 2 * 60_000
const HORIZON_MS = 30 * 24 * 60 * 60_000
const BATCH = 50
const PENDING = new Set(['SUBMITTED', 'UNVERIFIED', 'PUBLISHING'])

let scheduledTask: ReturnType<typeof cron.schedule> | null = null

export async function runStudioPublicationSettleOnce(): Promise<{ summary: string }> {
  return recordCronRun(JOB_NAME, async () => {
    const { publicationResultFor, unsettledPublicationIds } = await import('../services/pim/studio-publication.service.js')
    const totals = { read: 0, settled: 0, pending: 0, error: 0 }
    await visitActiveWorkspaces(async () => {
      const ids = await unsettledPublicationIds({ minAgeMs: SETTLE_AFTER_MS, horizonMs: HORIZON_MS, limit: BATCH })
      for (const id of ids) {
        totals.read += 1
        try {
          const result = await publicationResultFor(id)
          if (PENDING.has(result.status)) totals.pending += 1
          else totals.settled += 1
        } catch (error) {
          // One publication's failure never stops the others; it stays in the set for the next run.
          totals.error += 1
          logger.warn(`${JOB_NAME}: a publication could not be settled; the next run tries again`, {
            publicationId: id, error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })
    return { summary: `read ${totals.read} · settled ${totals.settled} · still pending ${totals.pending} · errors ${totals.error}` }
  })
}

export function startStudioPublicationSettleCron(): void {
  if (process.env.NEXUS_STUDIO_PUBLICATION_SETTLE !== '1') {
    logger.info(`${JOB_NAME}: cron off (NEXUS_STUDIO_PUBLICATION_SETTLE=1 turns it on; it reads Amazon and eBay results)`)
    return
  }
  const schedule = process.env.NEXUS_STUDIO_PUBLICATION_SETTLE_SCHEDULE || '*/5 * * * *'
  scheduledTask = cron.schedule(schedule, async () => {
    await runStudioPublicationSettleOnce().catch(error =>
      logger.error(`${JOB_NAME}: run failed`, { error: error instanceof Error ? error.message : String(error) }))
  })
  logger.info(`${JOB_NAME}: scheduled (${schedule})`)
}

export function stopStudioPublicationSettleCron(): void {
  scheduledTask?.stop()
  scheduledTask = null
}
