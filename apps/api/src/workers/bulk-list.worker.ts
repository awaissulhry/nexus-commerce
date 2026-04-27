import { Worker, Job } from 'bullmq'
import { redis } from '../lib/queue.js'
import { bulkListQueue, BulkListJobData, BulkListJobResult } from '../services/bulk-list.service.js'
import { AiListingService } from '../services/ai/ai-listing.service.js'
import { EbayPublishService } from '../services/ebay-publish.service.js'
import { GeminiService } from '../services/ai/gemini.service.js'
import { EbayCategoryService } from '../services/ebay-category.service.js'
import { EbayService } from '../services/marketplaces/ebay.service.js'
import prisma from '@nexus/database'
import { logger } from '../utils/logger.js'

/**
 * Bulk listing worker - processes products sequentially to respect eBay rate limits
 * Concurrency: 1 (sequential processing)
 */
export const bulkListWorker = new Worker<BulkListJobData, BulkListJobResult>(
  'bulk-ebay-listing',
  async (job: Job<BulkListJobData>) => {
    const startTime = Date.now()
    const { productIds, marketplaceId, pricingMarkupPercent = 0, dryRun = false } = job.data

    const result: BulkListJobResult = {
      listed: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      totalProcessed: 0,
      duration: 0,
    }

    // Initialize services
    const geminiService = new GeminiService()
    const ebayCategoryService = new EbayCategoryService()
    const aiListingService = new AiListingService(geminiService, ebayCategoryService, prisma as any)
    const ebayService = new EbayService()
    const ebayPublishService = new EbayPublishService(ebayService)

    logger.info(`[BulkListWorker] Starting bulk listing job`, {
      jobId: job.id,
      productCount: productIds.length,
      marketplaceId,
      pricingMarkupPercent,
      dryRun,
    })

    // Process each product sequentially
    for (let i = 0; i < productIds.length; i++) {
      const productId = productIds[i]
      result.totalProcessed++

      try {
        // Update progress
        await job.updateProgress({
          current: i + 1,
          total: productIds.length,
          currentSku: productId,
        })

        // Step 1: Fetch product
        const product = await (prisma as any).product.findUnique({
          where: { id: productId },
          include: {
            variations: true,
            images: true,
          },
        })

        if (!product) {
          result.skipped++
          result.errors.push({
            productId,
            reason: 'Product not found',
          })
          continue
        }

        // Step 2: Check if draft exists, generate if needed
        let draft = await (prisma as any).draftListing.findFirst({
          where: { productId },
        })

        if (!draft) {
          try {
            const draftResponse = await aiListingService.generateListingDraft(
              productId,
              false,
              marketplaceId
            )
            draft = await (prisma as any).draftListing.findUnique({
              where: { id: draftResponse.draftListingId },
            })
          } catch (error) {
            result.failed++
            result.errors.push({
              productId,
              reason: `Failed to generate draft: ${error instanceof Error ? error.message : 'Unknown error'}`,
            })
            continue
          }
        }

        // Step 3: Calculate final price with markup
        let finalPrice = Number(product.basePrice)
        if (pricingMarkupPercent > 0) {
          finalPrice = finalPrice * (1 + pricingMarkupPercent / 100)
        }

        // Step 4: Publish to eBay (or skip if dryRun)
        if (!dryRun) {
          try {
            await ebayPublishService.publishDraft(draft.id)
            result.listed++
            logger.info(`[BulkListWorker] Listed product`, {
              jobId: job.id,
              productId,
              finalPrice,
            })
          } catch (error) {
            result.failed++
            result.errors.push({
              productId,
              reason: `Failed to publish: ${error instanceof Error ? error.message : 'Unknown error'}`,
            })
          }
        } else {
          // Dry run mode - just count as listed without publishing
          result.listed++
          logger.info(`[BulkListWorker] Dry-run: would list product`, {
            jobId: job.id,
            productId,
            finalPrice,
          })
        }
      } catch (error) {
        result.failed++
        result.errors.push({
          productId,
          reason: `Unexpected error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        })
        logger.error(`[BulkListWorker] Unexpected error processing product`, {
          jobId: job.id,
          productId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    result.duration = Date.now() - startTime

    logger.info(`[BulkListWorker] Bulk listing job completed`, {
      jobId: job.id,
      result,
    })

    return result
  },
  {
    connection: redis,
    concurrency: 1, // Sequential processing to respect eBay rate limits
  }
)

// Event listeners for monitoring
bulkListWorker.on('completed', (job) => {
  logger.info(`[BulkListWorker] Job completed`, {
    jobId: job.id,
    result: job.returnvalue,
  })
})

bulkListWorker.on('failed', (job, error) => {
  logger.error(`[BulkListWorker] Job failed`, {
    jobId: job?.id,
    error: error.message,
  })
})

bulkListWorker.on('error', (error) => {
  logger.error(`[BulkListWorker] Worker error`, {
    error: error.message,
  })
})
