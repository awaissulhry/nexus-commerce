/**
 * Phase 25: Marketplace Sync Execution Engine - Channel Sync Worker
 * 
 * BullMQ worker that processes channel sync jobs from the channel-sync queue.
 * Routes jobs to appropriate marketplace handlers based on targetChannel.
 * Updates ChannelListing sync status throughout the process.
 */

import { Job } from 'bullmq'
import { WorkspaceWorker as Worker } from '../lib/workspace-jobs.js'
import prisma from '../db.js'
import { redis } from '../lib/queue.js'
import { logger } from '../utils/logger.js'
import { syncProductToAmazon } from '../services/marketplaces/amazon-sync.service.js'
import { syncProductToEbay } from '../services/marketplaces/ebay-sync.service.js'
import { syncProductToShopify } from '../services/marketplaces/shopify-sync.service.js'

// Worker statistics
let processedCount = 0
let successCount = 0
let failureCount = 0

/**
 * Initialize the BullMQ worker for channel sync processing
 */
export function initializeChannelSyncWorker() {
  logger.info('🚀 Initializing Channel Sync Worker...')

  const worker = new Worker('channel-sync', processChannelSyncJob, {
    connection: redis.connection,
    concurrency: 3, // Process 3 syncs concurrently
  })

  // Event listeners
  worker.on('completed', (job) => {
    logger.debug('✅ Channel sync job completed', {
      jobId: job.id,
      productId: job.data.productId,
      targetChannel: job.data.targetChannel,
      processingTime: job.finishedOn ? job.finishedOn - job.processedOn! : 0,
    })
    successCount++
  })

  worker.on('failed', (job, error) => {
    logger.warn('❌ Channel sync job failed', {
      jobId: job?.id,
      productId: job?.data?.productId,
      targetChannel: job?.data?.targetChannel,
      error: error.message,
      attempt: job?.attemptsMade,
      maxAttempts: job?.opts.attempts,
    })
    failureCount++
  })

  worker.on('error', (error) => {
    logger.error('🔴 Channel sync worker error', {
      error: error instanceof Error ? error.message : String(error),
    })
  })

  logger.info('✅ Channel Sync Worker Started', {
    concurrency: 3,
    queueName: 'channel-sync',
    timestamp: new Date().toISOString(),
  })

  return worker
}

/**
 * Process a single channel sync job
 * 
 * Job data structure:
 * {
 *   productId: string
 *   targetChannel: 'AMAZON' | 'EBAY' | 'SHOPIFY'
 *   channelListingId?: string (optional, for specific listing sync)
 * }
 */
/**
 * P7a.1 — exported so its guards can be driven directly. The worker had no test at all, which is
 * how a branch that invents a market and one that strands a row both survived: nothing could run
 * them. The BullMQ wiring above is unchanged.
 */
export async function processChannelSyncJob(job: Job) {
  const { productId, targetChannel, channelListingId } = job.data

  logger.info('⚙️ Processing channel sync job', {
    jobId: job.id,
    productId,
    targetChannel,
    channelListingId,
    attempt: job.attemptsMade + 1,
  })

  try {
    // ─────────────────────────────────────────────────────────────────────
    // STEP 1: Fetch product and validate
    // ─────────────────────────────────────────────────────────────────────
    const product = await prisma.product.findUnique({
      where: { id: productId },
    })

    if (!product) {
      logger.error('Product not found', { productId })
      throw new Error(`Product ${productId} not found`)
    }

    logger.info('📦 Product fetched', {
      productId,
      sku: product.sku,
      name: product.name,
    })

    // ─────────────────────────────────────────────────────────────────────
    // STEP 2: Fetch or create channel listing
    // ─────────────────────────────────────────────────────────────────────
    let channelListing = null
    
    if (channelListingId) {
      channelListing = await prisma.channelListing.findUnique({
        where: { id: channelListingId },
      })
    } else {
      // P7a.1 — this branch used to do two things no writer in Nexus is allowed to do.
      //
      // 1. `findFirst({ productId, channel })` with no marketplace picked **an arbitrary one**
      //    of a product's listings. Measured on the development database: 214 Amazon products
      //    and 21 eBay products carry MORE THAN ONE listing on that channel (AMAZON_IT 273,
      //    AMAZON_DE 214, AMAZON_ES 123, AMAZON_FR 115, EBAY_IT 253, EBAY_DE 21). So for 235
      //    products this picked a market at random and then marked it SYNCING.
      //
      // 2. When it found none it CREATED one with `channelMarket: `${targetChannel}_US`` and
      //    `region: 'US'` — a market this seller does not sell in. Every real row is IT, DE, ES,
      //    FR or GLOBAL; `_US` appears **0 times** and `region = 'US'` **0 times**.
      //
      // Both were latent: 0 rows are stuck at SYNCING, so this branch has never run. That is
      // the same shape as P4.3a — a wrong writer one button-press away — and the same answer:
      // the rule goes in the engine. **Refuse rather than guess.** Nexus never picks "the
      // first" (the Owner's P1.4 ruling) and never invents a market (P4.3c).
      const candidates = await prisma.channelListing.findMany({
        where: { productId, channel: targetChannel },
        select: { id: true, channelMarket: true, marketplace: true },
        orderBy: { id: 'asc' },
      })

      if (candidates.length === 0) {
        throw new Error(
          `${product.sku ?? productId} has no ${targetChannel} listing, and Nexus will not create one for a market nobody named. Add the listing for its market first. Nothing was synced.`,
        )
      }
      if (candidates.length > 1) {
        const markets = candidates.map((c) => c.channelMarket ?? c.marketplace ?? '(no market)').join(', ')
        throw new Error(
          `${product.sku ?? productId} has ${candidates.length} ${targetChannel} listings (${markets}), so this sync must name one. Nothing was synced.`,
        )
      }
      channelListing = await prisma.channelListing.findUnique({ where: { id: candidates[0].id } })
    }

    if (!channelListing) {
      throw new Error(`Channel listing not found for product ${productId} on ${targetChannel}`)
    }

    logger.info('📋 Channel listing fetched', {
      channelListingId: channelListing.id,
      channel: channelListing.channel,
      currentSyncStatus: channelListing.syncStatus,
    })

    // ─────────────────────────────────────────────────────────────────────
    // STEP 3: Update sync status to SYNCING
    // ─────────────────────────────────────────────────────────────────────
    // P7a.1 — remembered, so the noop path can put it back rather than stranding the row.
    const statusBefore = channelListing.syncStatus
    await prisma.channelListing.update({
      where: { id: channelListing.id },
      data: {
        syncStatus: 'SYNCING',
      },
    })

    logger.info('🔄 Updated sync status to SYNCING', {
      channelListingId: channelListing.id,
    })

    // ─────────────────────────────────────────────────────────────────────
    // STEP 4: Route to appropriate channel handler
    // ─────────────────────────────────────────────────────────────────────
    let syncResult: any

    switch (targetChannel) {
      case 'AMAZON':
        syncResult = await syncToAmazon(product, channelListing)
        break
      case 'EBAY':
        syncResult = await syncToEbay(product, channelListing)
        break
      case 'SHOPIFY':
        syncResult = await syncToShopify(product, channelListing)
        break
      default:
        throw new Error(`Unknown target channel: ${targetChannel}`)
    }

    // ─────────────────────────────────────────────────────────────────────
    // STEP 5: Update sync status — but ONLY on a real publish.
    // Phase 0.3 — the per-channel handlers above only BUILD a payload; the real
    // outbound push runs via OutboundSyncQueue (outbound-sync.service). So a
    // 'noop' result must NOT mark the listing IN_SYNC/SUCCESS (that was a silent
    // false success). Leave the listing's status untouched and log honestly.
    // ─────────────────────────────────────────────────────────────────────
    if (syncResult?.status === 'noop') {
      // P7a.1 — put the status BACK. STEP 3 set it to SYNCING, and the noop path used to leave
      // it there for ever: a sync that never finishes, on a row picked at random. "Leave the
      // listing's status untouched" was the right instinct about IN_SYNC and the wrong one about
      // SYNCING, because the status had already been touched two steps earlier.
      await prisma.channelListing.update({
        where: { id: channelListing.id },
        data: { syncStatus: statusBefore },
      })
      logger.warn('[channel-sync] payload built but NOT published here — real push runs via OutboundSyncQueue', {
        channelListingId: channelListing.id,
        productId,
        targetChannel,
        syncStatusRestoredTo: statusBefore,
      })
    } else {
      await prisma.channelListing.update({
        where: { id: channelListing.id },
        data: {
          syncStatus: 'IN_SYNC',
          lastSyncedAt: new Date(),
          lastSyncStatus: 'SUCCESS',
        },
      })
      logger.info('✅ Sync completed successfully', {
        channelListingId: channelListing.id,
        productId,
        targetChannel,
        syncResult,
      })
    }

    processedCount++
    return { status: 'SUCCESS', channelListingId: channelListing.id, syncResult }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error('❌ Channel sync job failed', {
      jobId: job.id,
      productId,
      targetChannel,
      error: errorMsg,
      attempt: job.attemptsMade + 1,
      stack: error instanceof Error ? error.stack : undefined,
    })

    // Update channel listing with error status
    try {
      if (channelListingId) {
        await prisma.channelListing.update({
          where: { id: channelListingId },
          data: {
            syncStatus: 'FAILED',
            lastSyncStatus: 'FAILED',
            lastSyncError: errorMsg,
          },
        })
      }
    } catch (updateError) {
      logger.error('Failed to update channel listing with error', {
        channelListingId,
        error: updateError instanceof Error ? updateError.message : String(updateError),
      })
    }

    // Re-throw to let BullMQ handle retry
    throw error
  }
}

/**
 * Sync product to Amazon
 */
async function syncToAmazon(product: any, channelListing: any): Promise<any> {
  try {
    const payload = await syncProductToAmazon(product, channelListing)
    
    // Phase 0.3 — syncProductToAmazon only BUILDS a payload; it does not call
    // Amazon. The real push runs via OutboundSyncQueue. Don't claim success.
    logger.warn('[channel-sync] Amazon payload built but NOT sent (real push via OutboundSyncQueue)', {
      channel: 'AMAZON',
      sku: product.sku,
      price: payload.price,
    })

    return {
      channel: 'AMAZON',
      sku: product.sku,
      status: 'noop',
      payload,
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error('❌ Amazon sync failed', {
      sku: product.sku,
      error: errorMsg,
    })
    throw error
  }
}

/**
 * Sync product to eBay
 */
async function syncToEbay(product: any, channelListing: any): Promise<any> {
  try {
    const payload = await syncProductToEbay(product, channelListing)
    
    // Phase 0.3 — payload-only builder; the real push runs via OutboundSyncQueue.
    logger.warn('[channel-sync] eBay payload built but NOT sent (real push via OutboundSyncQueue)', {
      channel: 'EBAY',
      sku: product.sku,
      price: payload.price,
    })

    return {
      channel: 'EBAY',
      sku: product.sku,
      status: 'noop',
      payload,
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error('❌ eBay sync failed', {
      sku: product.sku,
      error: errorMsg,
    })
    throw error
  }
}

/**
 * Sync product to Shopify
 */
async function syncToShopify(product: any, channelListing: any): Promise<any> {
  try {
    const payload = await syncProductToShopify(product, channelListing)
    
    // Phase 0.3 — payload-only builder; the real push runs via OutboundSyncQueue.
    logger.warn('[channel-sync] Shopify payload built but NOT sent (real push via OutboundSyncQueue)', {
      channel: 'SHOPIFY',
      sku: product.sku,
      price: payload.price,
    })

    return {
      channel: 'SHOPIFY',
      sku: product.sku,
      status: 'noop',
      payload,
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error('❌ Shopify sync failed', {
      sku: product.sku,
      error: errorMsg,
    })
    throw error
  }
}

/**
 * Get worker statistics for monitoring
 */
export function getChannelSyncWorkerStats() {
  return {
    processed: processedCount,
    succeeded: successCount,
    failed: failureCount,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Reset worker statistics (for testing)
 */
export function resetChannelSyncWorkerStats() {
  processedCount = 0
  successCount = 0
  failureCount = 0
  logger.info('🔄 Channel Sync Worker stats reset')
}
