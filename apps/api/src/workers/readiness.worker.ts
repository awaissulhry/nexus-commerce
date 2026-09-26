/**
 * P2 (docs/attributes/PLAN.md §4.7) — rebuilds the readiness of one product family after a bulk edit.
 *
 * Jobs come from `produceReadinessForProducts` when a write spans more families than it may rebuild inline. The job is
 * only the fast lane: the pending marks on `ReadinessIndex` are the durable record, and `readiness-pending.job.ts`
 * drains whatever this worker did not reach. A job whose family is no longer pending does nothing.
 */
import { WorkspaceWorker as Worker } from '../lib/workspace-jobs.js'
import { redis } from '../lib/queue.js'
import { rebuildPendingFamily } from '../services/pim/readiness-index.service.js'
import { logger } from '../utils/logger.js'

export function initializeReadinessWorker() {
  const worker = new Worker(
    'readiness',
    async (job) => {
      const { rootId } = job.data as { rootId?: string }
      if (!rootId) {
        logger.warn('[readiness] job missing rootId', { jobId: job.id })
        return
      }
      await rebuildPendingFamily(rootId)
    },
    {
      connection: redis.connection,
      // One rebuild is 3–5 s and ~1,000 statements (measured 2026-09-26). Two lanes, like read-cache: enough to drain a
      // bulk edit in the background without starving the saves that are still arriving.
      concurrency: 2,
    },
  )

  worker.on('failed', (job, err) => {
    logger.warn('[readiness] job failed', { jobId: job?.id, rootId: job?.data?.rootId, error: err.message })
  })

  return worker
}
