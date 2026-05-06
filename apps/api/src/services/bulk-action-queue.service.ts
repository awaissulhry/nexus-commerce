/**
 * Commit 3 of the bulk-operations rebuild — BullMQ queue for bulk
 * action job execution.
 *
 * Why a separate queue (vs. running inline on the API process):
 *   - Crash recovery: if Railway restarts the API mid-job, BullMQ
 *     jobs survive in Redis and the next worker picks them up.
 *     Inline processJob would leave the BulkActionJob row stuck in
 *     IN_PROGRESS forever.
 *   - Health isolation: the route handler returns instantly after
 *     enqueueing. If a job hangs (we've seen this — TECH_DEBT #54),
 *     the API box stays healthy because the hung work is in the
 *     worker process, not the request-serving process.
 *   - Mid-run cancel: the worker re-reads job.status every N items;
 *     POST /:id/cancel just flips the DB column and the worker
 *     bails on its next check.
 *
 * Idempotency: BullMQ job id = BulkActionJob.id. Repeated enqueues
 * for the same DB job are deduped by BullMQ.
 *
 * Retries: attempts=1. A bulk job that re-runs would double-apply
 * its mutations (e.g., stack a +5 stock delta into +10). Match the
 * bulk-list.service.ts pattern.
 */

import { Queue } from 'bullmq'
import { redis } from '../lib/queue.js'

export interface BulkActionJobData {
  /** BulkActionJob.id in the database. */
  jobId: string
}

let _bulkActionQueue: Queue<BulkActionJobData> | null = null

/** Lazy singleton — same pattern as outboundSyncQueue (lib/queue.ts). */
function getBulkActionQueue(): Queue<BulkActionJobData> {
  if (!_bulkActionQueue) {
    _bulkActionQueue = new Queue<BulkActionJobData>('bulk-action', {
      connection: redis.connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 86400 },
      },
    })
  }
  return _bulkActionQueue
}

export const bulkActionQueue = new Proxy({} as Queue<BulkActionJobData>, {
  get(_, prop) {
    const q = getBulkActionQueue() as any
    const v = q[prop]
    return typeof v === 'function' ? v.bind(q) : v
  },
})

/**
 * Enqueue a bulk action job for worker processing. Returns the
 * BullMQ jobId (which equals the BulkActionJob.id).
 */
export async function enqueueBulkActionJob(jobId: string): Promise<string> {
  const job = await bulkActionQueue.add(
    'process-bulk-action',
    { jobId },
    { jobId },
  )
  return job.id ?? jobId
}
