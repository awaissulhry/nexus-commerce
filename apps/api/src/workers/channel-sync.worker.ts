/**
 * Phase 25: Marketplace Sync Execution Engine - Channel Sync Worker
 * 
 * BullMQ worker that processes channel sync jobs from the channel-sync queue.
 * Routes jobs to appropriate marketplace handlers based on targetChannel.
 * Updates ChannelListing sync status throughout the process.
 */

import { Worker, Job } from 'bullmq'
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
    connection: redis,
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
async function processChannelSyncJob(job: Job) {
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
      // Find or create channel listing for this product
      const channelMarket = `${targetChannel}_US` // Default to US region
      channelListing = await prisma.channelListing.findFirst({
        where: {
          productId,
          channel: targetChannel,
        },
      })

      if (!channelListing) {
        logger.info('Creating new channel listing', {
          productId,
          channel: targetChannel,
        })
        channelListing = await prisma.channelListing.create({
          data: {
            productId,
            channel: targetChannel,
            channelMarket,
            region: 'US',
            title: product.name,
            description: '',
            price: product.basePrice,
            quantity: product.totalStock,
            listingStatus: 'DRAFT',
            syncStatus: 'IDLE',
          },
        })
      }
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
    // STEP 5: Update sync status to IN_SYNC
    // ─────────────────────────────────────────────────────────────────────
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
    
    logger.info('✅ [SYNC COMPLETE] Amazon sync successful', {
      channel: 'AMAZON',
      sku: product.sku,
      price: payload.price,
    })

    return {
      channel: 'AMAZON',
      sku: product.sku,
      status: 'synced',
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
    
    logger.info('✅ [SYNC COMPLETE] eBay sync successful', {
      channel: 'EBAY',
      sku: product.sku,
      price: payload.price,
    })

    return {
      channel: 'EBAY',
      sku: product.sku,
      status: 'synced',
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
    
    logger.info('✅ [SYNC COMPLETE] Shopify sync successful', {
      channel: 'SHOPIFY',
      sku: product.sku,
      price: payload.price,
    })

    return {
      channel: 'SHOPIFY',
      sku: product.sku,
      status: 'synced',
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
