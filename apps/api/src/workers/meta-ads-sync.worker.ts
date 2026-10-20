/**
 * Meta ads M1 — the worker half of the read: one job = one Meta ad account of one business, read now
 * (services/marketing/meta-ads/sync.service.ts). WorkspaceWorker runs each job in the business it was queued from, so
 * the read sees and writes only that business's rows; a business that no longer has the account linked gets no call.
 *
 * Concurrency 1: Meta's limits are per ad account and per app, and one read at a time keeps the account's rate bucket
 * predictable. A read records its own outcome in words (MetaAdAccount.lastSyncStatus) and does not throw for a Meta
 * answer; a thrown job is a fault of Nexus's own and is retried once by the queue.
 */
import { WorkspaceWorker as Worker } from '../lib/workspace-jobs.js'
import { redis } from '../lib/queue.js'
import { META_ADS_SYNC_QUEUE, type MetaAdsSyncJobData } from '../services/marketing/meta-ads/enqueue.js'
import { syncMetaAdAccountById } from '../services/marketing/meta-ads/sync.service.js'
import { metaAdsSyncSwitchedOff } from '../services/marketing/meta-ads/sync-switch.js'
import { logger } from '../utils/logger.js'

const KINDS = new Set(['BACKFILL', 'DAILY', 'MANUAL', 'TOKEN'])

/** One job's work, in the business the job carries (WorkspaceWorker binds it). Exported for tests. */
export async function processMetaAdsSyncJob(data: Partial<MetaAdsSyncJobData> | undefined) {
  const adAccountId = typeof data?.adAccountId === 'string' && /^\d{1,25}$/.test(data.adAccountId) ? data.adAccountId : null
  const kind = typeof data?.kind === 'string' && KINDS.has(data.kind) ? data.kind : null
  if (!adAccountId || !kind) {
    logger.warn('[meta-ads-sync] job without a valid ad account or kind; skipped')
    return { skipped: true as const }
  }
  if (metaAdsSyncSwitchedOff()) return { skipped: true as const }
  const result = await syncMetaAdAccountById(adAccountId, kind)
  return { skipped: false as const, status: result.status, calls: result.calls }
}

export function initializeMetaAdsSyncWorker() {
  const worker = new Worker(
    META_ADS_SYNC_QUEUE,
    async (job) => processMetaAdsSyncJob(job.data as Partial<MetaAdsSyncJobData>),
    { connection: redis.connection, concurrency: 1 },
  )
  worker.on('failed', (job, err) => {
    logger.warn('[meta-ads-sync] job failed', { jobId: job?.id, error: err.message })
  })
  worker.on('error', (error) => {
    logger.error('[meta-ads-sync] worker error', { error: error instanceof Error ? error.message : String(error) })
  })
  return worker
}
