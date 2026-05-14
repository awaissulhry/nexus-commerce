/**
 * ES.3 — Read-cache refresh worker.
 *
 * Processes jobs enqueued by productEventService.enqueueRefresh().
 * Each job carries a single { productId } and triggers one upsert
 * into ProductReadCache. Because jobs are deduplicated by jobId
 * ("cache:refresh:<productId>"), rapid successive mutations on the
 * same product collapse to one rebuild.
 */

import { Worker } from 'bullmq'
import { redis } from '../lib/queue.js'
import { productReadCacheService } from '../services/product-read-cache.service.js'
import { logger } from '../utils/logger.js'

export function initializeReadCacheWorker() {
  const worker = new Worker(
    'read-cache',
    async (job) => {
      const { productId } = job.data as { productId: string }
      if (!productId) {
        logger.warn('[read-cache] job missing productId', { jobId: job.id })
        return
      }
      await productReadCacheService.refresh(productId)
    },
    {
      connection: redis.connection,
      concurrency: 10,
    },
  )

  worker.on('failed', (job, err) => {
    logger.warn('[read-cache] job failed', {
      jobId: job?.id,
      productId: job?.data?.productId,
      error: err.message,
    })
  })

  return worker
}
