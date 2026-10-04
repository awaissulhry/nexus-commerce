/**
 * Sheet publish parity, step 5 — the publication batch worker. Thin: it runs `runPublicationBatch`, which claims the
 * batch header and sends each review through the normal studio submit (services/pim/publication-batch.processor.ts).
 * The job carries its business profile (`WorkspaceWorker` + `scopeJobData`), so every read and send happens in it.
 */
import { type Job } from 'bullmq'
import { WorkspaceWorker as Worker } from '../lib/workspace-jobs.js'
import { redis } from '../lib/queue.js'
import { logger } from '../utils/logger.js'

export interface PublicationBatchJobData { batchId: string }

let worker: Worker<PublicationBatchJobData> | null = null

export function initializePublicationBatchWorker(): Worker<PublicationBatchJobData> {
  if (worker) return worker
  worker = new Worker<PublicationBatchJobData>('publication-batch', async (job: Job<PublicationBatchJobData>) => {
    const { runPublicationBatch } = await import('../services/pim/publication-batch.processor.js')
    return runPublicationBatch(job.data.batchId)
  }, {
    connection: redis.connection,
    // Each batch already sends two channel accounts side by side; two batches at once is enough for one worker.
    concurrency: 2,
  })
  worker.on('failed', (job, error) => logger.warn('[publication-batch-worker] failed; the resume job re-queues it when its heartbeat goes stale',
    { bullJobId: job?.id, batchId: job?.data?.batchId, error: error instanceof Error ? error.message : String(error) }))
  return worker
}
