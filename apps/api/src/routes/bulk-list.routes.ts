import { FastifyInstance } from 'fastify'
import { enqueueBulkList, bulkListQueue, BulkListJobData } from '../services/bulk-list.service.js'
import { logger } from '../utils/logger.js'

export async function bulkListRoutes(app: FastifyInstance) {
  /**
   * POST /api/listings/bulk-publish-to-ebay
   * Queue a bulk listing job for multiple products
   *
   * Request body:
   * {
   *   "productIds": ["prod-1", "prod-2", ...],
   *   "marketplaceId": "EBAY_IT",
   *   "pricingMarkupPercent": 15,
   *   "dryRun": false
   * }
   *
   * Response:
   * {
   *   "jobId": "bulk-1234567890-abc123",
   *   "queued": 50
   * }
   */
  app.post<{
    Body: {
      productIds: string[]
      marketplaceId: 'EBAY_IT' | 'EBAY_US' | 'EBAY_DE' | 'EBAY_FR' | 'EBAY_UK'
      pricingMarkupPercent?: number
      dryRun?: boolean
    }
  }>('/listings/bulk-publish-to-ebay', async (request, reply) => {
    try {
      const { productIds, marketplaceId, pricingMarkupPercent = 0, dryRun = false } = request.body

      // Validate productIds
      if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
        return reply.status(400).send({
          error: 'productIds must be a non-empty array',
        })
      }

      if (productIds.length > 1000) {
        return reply.status(400).send({
          error: 'Maximum 1000 products per bulk job',
        })
      }

      // Validate marketplaceId
      const validMarketplaces = ['EBAY_IT', 'EBAY_US', 'EBAY_DE', 'EBAY_FR', 'EBAY_UK']
      if (!validMarketplaces.includes(marketplaceId)) {
        return reply.status(400).send({
          error: `Invalid marketplaceId. Must be one of: ${validMarketplaces.join(', ')}`,
        })
      }

      // Validate pricingMarkupPercent
      if (pricingMarkupPercent < 0 || pricingMarkupPercent > 500) {
        return reply.status(400).send({
          error: 'pricingMarkupPercent must be between 0 and 500',
        })
      }

      // Enqueue the job
      const jobData: BulkListJobData = {
        productIds,
        marketplaceId,
        pricingMarkupPercent,
        dryRun,
      }

      const jobId = await enqueueBulkList(jobData)

      logger.info('[BulkListRoutes] Bulk listing job queued', {
        jobId,
        productCount: productIds.length,
        marketplaceId,
        pricingMarkupPercent,
        dryRun,
      })

      return reply.status(202).send({
        jobId,
        queued: productIds.length,
      })
    } catch (error) {
      logger.error('[BulkListRoutes] Error queuing bulk job', {
        error: error instanceof Error ? error.message : String(error),
      })
      return reply.status(500).send({
        error: 'Failed to queue bulk listing job',
      })
    }
  })

  /**
   * GET /api/listings/bulk-publish-to-ebay/:jobId
   * Poll the status of a bulk listing job
   *
   * Response:
   * {
   *   "jobId": "bulk-1234567890-abc123",
   *   "state": "completed|active|waiting|failed",
   *   "progress": {
   *     "current": 25,
   *     "total": 50,
   *     "currentSku": "prod-25"
   *   },
   *   "result": {
   *     "listed": 24,
   *     "skipped": 0,
   *     "failed": 1,
   *     "errors": [
   *       { "productId": "prod-10", "reason": "Product not found" }
   *     ],
   *     "totalProcessed": 25,
   *     "duration": 12345
   *   },
   *   "failedReason": null
   * }
   */
  app.get<{ Params: { jobId: string } }>(
    '/listings/bulk-publish-to-ebay/:jobId',
    async (request, reply) => {
      try {
        const { jobId } = request.params

        // Fetch job from queue
        const job = await bulkListQueue.getJob(jobId)

        if (!job) {
          return reply.status(404).send({
            error: 'Job not found',
          })
        }

        // Get job state
        const state = await job.getState()
        const progress = job.progress
        const result = job.returnvalue
        const failedReason = job.failedReason

        logger.debug('[BulkListRoutes] Job status retrieved', {
          jobId,
          state,
          progress,
        })

        return reply.send({
          jobId,
          state,
          progress,
          result,
          failedReason,
        })
      } catch (error) {
        logger.error('[BulkListRoutes] Error retrieving job status', {
          jobId: request.params.jobId,
          error: error instanceof Error ? error.message : String(error),
        })
        return reply.status(500).send({
          error: 'Failed to retrieve job status',
        })
      }
    }
  )
}
