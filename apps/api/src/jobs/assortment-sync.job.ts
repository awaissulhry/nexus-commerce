/**
 * Shared stock plan step 6 (research AE.4) — live product sync (contract
 * docs/2026-09-19-shared-stock-build.md §6.1).
 *
 * The worker: LISTENs for the capture trigger's notify on a direct connection, with a poll behind it
 * (2 s after work, backing off to 60 s when quiet), and syncs each follower business's waiting links
 * in that business's own context (services/assortment/sync-worker.ts).
 *
 * The repair, nightly per business (the clustered wrapper visits each active business under a lease,
 * so replicas never double-run it): queue every link whose source changed after its last sync or
 * whose rename is held — the worker's compare heals or records each — and delete finished changes
 * older than a week. Most businesses follow nothing: one indexed probe, and no run is recorded.
 */
import cron from '../lib/cron/clustered.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { afterSyncQueued, cleanFinishedChanges, queueStaleLinks, startAssortmentSyncWorker } from '../services/assortment/sync-worker.js'

let scheduledTask: ReturnType<typeof cron.schedule> | null = null
let stopWorker: (() => void) | null = null

export function startAssortmentSync(): void {
  if (!stopWorker) stopWorker = startAssortmentSyncWorker()
  if (scheduledTask) return
  scheduledTask = cron.schedule('17 3 * * *', async () => {
    try {
      const queued = await queueStaleLinks()
      const cleaned = await cleanFinishedChanges()
      if (!queued && !cleaned) return
      await recordCronRun('assortment-sync-repair', async () => `queued=${queued} cleaned=${cleaned}`)
      if (queued) afterSyncQueued()
    } catch (error) {
      logger.warn('assortment-sync: repair failed', { error: error instanceof Error ? error.message : String(error) })
    }
  })
}
