/**
 * Commit 3 of the bulk-operations rebuild — BullMQ worker that
 * consumes the `bulk-action` queue and runs BulkActionService.processJob.
 *
 * Concurrency: 1. Bulk jobs are heavy and serialized writes against
 * the same Product / ChannelListing rows would race. Single-threaded
 * sequencing matches the existing in-process behavior.
 *
 * Mid-run cancel is implemented in BulkActionService.processJob
 * itself — it re-reads job.status periodically and breaks the loop
 * if the user has flipped it to CANCELLED.
 */

import { Worker, Job } from 'bullmq'
import { redis } from '../lib/queue.js'
import { logger } from '../utils/logger.js'
import { BulkActionService } from '../services/bulk-action.service.js'
import type { BulkActionJobData } from '../services/bulk-action-queue.service.js'
import prisma from '../db.js'

let bulkActionWorker: Worker<BulkActionJobData> | null = null

const bulkActionService = new BulkActionService(prisma)

export function initializeBulkActionWorker() {
  if (bulkActionWorker) {
    logger.info('⚠️ Bulk action worker already initialized, skipping')
    return bulkActionWorker
  }

  logger.info('🚀 Initializing Bulk Action Worker...')

  bulkActionWorker = new Worker<BulkActionJobData>(
    'bulk-action',
    async (job: Job<BulkActionJobData>) => {
      const { jobId } = job.data
      logger.info('[BulkActionWorker] Picking up job', {
        bullmqJobId: job.id,
        bulkActionJobId: jobId,
      })
      const result = await bulkActionService.processJob(jobId)
      logger.info('[BulkActionWorker] Job finished', {
        bulkActionJobId: jobId,
        status: result.status,
        processed: result.processedItems,
        failed: result.failedItems,
        skipped: result.skippedItems,
      })
      return result
    },
    {
      connection: redis.connection,
      concurrency: 1,
    },
  )

  bulkActionWorker.on('completed', (job) => {
    logger.debug('[BulkActionWorker] ✅ completed', {
      bullmqJobId: job.id,
      bulkActionJobId: job.data.jobId,
    })
  })

  bulkActionWorker.on('failed', (job, err) => {
    logger.warn('[BulkActionWorker] ❌ failed', {
      bullmqJobId: job?.id,
      bulkActionJobId: job?.data?.jobId,
      error: err.message,
    })
  })

  bulkActionWorker.on('error', (err) => {
    logger.error('[BulkActionWorker] 🔴 worker error', {
      error: err instanceof Error ? err.message : String(err),
    })
  })

  logger.info('✅ Bulk Action Worker started', {
    queueName: 'bulk-action',
    concurrency: 1,
  })

  return bulkActionWorker
}
