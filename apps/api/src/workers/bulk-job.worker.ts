/**
 * W13.1 — Bulk-job BullMQ worker.
 *
 * Out-of-process processor for BulkActionJob rows. Large bulk
 * jobs (W13.2 promotion threshold; default 200 items) get
 * enqueued here so the API process stays responsive while a
 * 10k-row batch chews on its work. Small jobs continue to run
 * in-process via the existing /process endpoint.
 *
 * The worker is intentionally thin: it calls
 * BulkActionService.processJob(jobId) and lets the existing
 * service handle the per-item loop, audit row writes, cancel-
 * cooperative checkpointing (W10.4), ETA recompute (W10.2),
 * and SSE-friendly progress updates (W10.1). The only thing
 * the worker adds is "this runs out-of-process now."
 */

import { Worker, type Job } from 'bullmq'
import { redis } from '../lib/queue.js'
import { logger } from '../utils/logger.js'

export interface BulkJobData {
  jobId: string
}

export interface BulkJobResult {
  jobId: string
  status: string
  processedItems: number
  failedItems: number
  skippedItems: number
  durationMs: number
}

let bulkJobWorker: Worker<BulkJobData, BulkJobResult> | null = null

export function initializeBulkJobWorker(): Worker<BulkJobData, BulkJobResult> | null {
  if (bulkJobWorker) {
    logger.info('⚠️ Bulk-job worker already initialized — skipping')
    return bulkJobWorker
  }
  logger.info('🚀 Initializing Bulk-Job Worker...')
  bulkJobWorker = new Worker<BulkJobData, BulkJobResult>(
    'bulk-job',
    async (job: Job<BulkJobData>) => {
      const startedAt = Date.now()
      const { jobId } = job.data
      // Lazy-import the service so the worker module's top-level
      // doesn't pull in the catalog / AI / channel dependency
      // graph at boot. Keeps cold-start fast for API processes
      // that aren't queue-enabled.
      const { BulkActionService } = await import(
        '../services/bulk-action.service.js'
      )
      const svc = new BulkActionService()
      logger.info('[bulk-job-worker] processing', { bullJobId: job.id, jobId })
      const result = await svc.processJob(jobId)
      return {
        jobId,
        status: result.status,
        processedItems: result.processedItems,
        failedItems: result.failedItems,
        skippedItems: result.skippedItems,
        durationMs: Date.now() - startedAt,
      }
    },
    {
      connection: redis.connection,
      // Per-worker concurrency. Two in-flight is enough — bulk-action
      // service holds connections + spawns Prisma writes; running 5+
      // jobs in parallel here would saturate the connection pool.
      concurrency: 2,
    },
  )

  bulkJobWorker.on('completed', (job, result) => {
    logger.info('[bulk-job-worker] completed', {
      bullJobId: job.id,
      jobId: result?.jobId,
      status: result?.status,
      durationMs: result?.durationMs,
    })
  })
  bulkJobWorker.on('failed', (job, err) => {
    logger.error('[bulk-job-worker] failed', {
      bullJobId: job?.id,
      jobId: job?.data?.jobId,
      error: err instanceof Error ? err.message : String(err),
    })
  })
  bulkJobWorker.on('error', (err) => {
    logger.error('[bulk-job-worker] worker error', {
      error: err instanceof Error ? err.message : String(err),
    })
  })

  logger.info('✅ Bulk-Job Worker started', {
    queueName: 'bulk-job',
    concurrency: 2,
    timestamp: new Date().toISOString(),
  })
  return bulkJobWorker
}
