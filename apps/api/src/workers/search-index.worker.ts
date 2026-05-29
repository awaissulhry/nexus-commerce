/**
 * PIM search-index worker.
 *
 * Sibling to read-cache.worker.ts. Processes jobs enqueued by
 * productEventService (gated on SEARCH_ENGINE_ENABLED) and pushes the
 * updated product document into Typesense. Deduped by jobId
 * ("search:index:<productId>") so rapid successive mutations on the same
 * product collapse to one index op.
 *
 * Failures here never touch the read-cache rebuild (separate queue) and
 * never affect the write path — the search index is the optional, gated
 * read engine with ProductReadCache as the always-present fallback.
 */

import { Worker } from 'bullmq'
import { redis } from '../lib/queue.js'
import { productSearchIndexerService } from '../services/product-search-indexer.service.js'
import { logger } from '../utils/logger.js'

export function initializeSearchIndexWorker() {
  const worker = new Worker(
    'search-index',
    async (job) => {
      const { productId } = job.data as { productId: string }
      if (!productId) {
        logger.warn('[search-index] job missing productId', { jobId: job.id })
        return
      }
      await productSearchIndexerService.indexProduct(productId)
    },
    {
      connection: redis.connection,
      concurrency: 10,
    },
  )

  worker.on('failed', (job, err) => {
    logger.warn('[search-index] job failed', {
      jobId: job?.id,
      productId: job?.data?.productId,
      error: err.message,
    })
  })

  return worker
}
