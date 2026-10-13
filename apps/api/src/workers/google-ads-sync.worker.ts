/**
 * Google Ads step 1a — the worker half of the read: one job = one Google Ads account of one business, read now
 * (services/marketing/google-ads/sync.service.ts). WorkspaceWorker runs each job in the business it was queued from,
 * so the read sees and writes only that business's rows; a business that no longer has the account linked gets no call.
 *
 * Concurrency 1: Google counts operations per Cloud project per day, and one read at a time keeps the allowance and the
 * account's rate bucket predictable. Across worker replicas (and inline reads), the read's own lock per business and
 * account (read-guard.ts) keeps two reads of one account apart: the second is skipped (ALREADY_RUNNING, no call). A read
 * records its own outcome in words (GoogleAdsCustomer.lastSyncStatus) and does not throw for a Google answer; a thrown
 * job is a fault of Nexus's own and is retried once by the queue.
 */
import { WorkspaceWorker as Worker } from '../lib/workspace-jobs.js'
import { redis } from '../lib/queue.js'
import { GOOGLE_ADS_SYNC_QUEUE, type GoogleAdsSyncJobData } from '../services/marketing/google-ads/enqueue.js'
import { syncGoogleAdsCustomer } from '../services/marketing/google-ads/sync.service.js'
import { googleAdsSyncSwitchedOff } from '../services/marketing/google-ads/sync-switch.js'
import { logger } from '../utils/logger.js'

const KINDS = new Set(['BACKFILL', 'DAILY', 'MANUAL'])

/** One job's work, in the business the job carries (WorkspaceWorker binds it). Exported for tests. */
export async function processGoogleAdsSyncJob(data: Partial<GoogleAdsSyncJobData> | undefined) {
  const customerId = typeof data?.customerId === 'string' && /^\d{1,20}$/.test(data.customerId) ? data.customerId : null
  const kind = typeof data?.kind === 'string' && KINDS.has(data.kind) ? data.kind : null
  if (!customerId || !kind) {
    logger.warn('[google-ads-sync] job without a valid account or kind; skipped')
    return { skipped: true as const }
  }
  // A job queued before the kill switch was set makes no call either.
  if (googleAdsSyncSwitchedOff()) return { skipped: true as const }
  const result = await syncGoogleAdsCustomer(customerId, kind)
  return { skipped: false as const, status: result.status, ops: result.ops }
}

export function initializeGoogleAdsSyncWorker() {
  const worker = new Worker(
    GOOGLE_ADS_SYNC_QUEUE,
    async (job) => processGoogleAdsSyncJob(job.data as Partial<GoogleAdsSyncJobData>),
    { connection: redis.connection, concurrency: 1 },
  )
  worker.on('failed', (job, err) => {
    logger.warn('[google-ads-sync] job failed', { jobId: job?.id, error: err.message })
  })
  worker.on('error', (error) => {
    logger.error('[google-ads-sync] worker error', { error: error instanceof Error ? error.message : String(error) })
  })
  return worker
}
