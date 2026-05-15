/**
 * Phase 13: Infrastructure Scale-Up - BullMQ Autopilot Worker
 *
 * Enterprise-grade message broker replacing node-cron polling
 * - Event-driven architecture with Redis backing
 * - Concurrency control (5 workers) to respect Amazon rate limits
 * - Grace period support via BullMQ native scheduling
 * - Automatic retry with exponential backoff
 */

import { Worker, Job } from 'bullmq'
import { prisma } from '@nexus/database'
import { redis } from '../lib/queue.js'
import { logger } from '../utils/logger.js'
import { variationSyncProcessor } from '../services/variation-sync-processor.service.js'
import OutboundSyncService from '../services/outbound-sync.service.js'
import { calculateTargetPrice } from '../services/repricer.service.js'
import { productEventService } from '../services/product-event.service.js'

// Worker statistics
let processedCount = 0
let successCount = 0
let failureCount = 0
let cancelledCount = 0

/**
 * Initialize the BullMQ worker for outbound sync processing
 */
export function initializeBullMQWorker() {
  logger.info('🚀 Initializing BullMQ Autopilot Worker...')

  const worker = new Worker('outbound-sync', processOutboundSyncJob, {
    connection: redis.connection,
    concurrency: 5, // Respect Amazon rate limits
  })

  // Event listeners
  worker.on('completed', (job) => {
    logger.debug('✅ Job completed', {
      jobId: job.id,
      queueId: job.data.queueId,
      processingTime: job.finishedOn ? job.finishedOn - job.processedOn! : 0,
    })
    successCount++
  })

  worker.on('failed', (job, error) => {
    logger.warn('❌ Job failed', {
      jobId: job?.id,
      queueId: job?.data?.queueId,
      error: error.message,
      attempt: job?.attemptsMade,
      maxAttempts: job?.opts.attempts,
    })
    failureCount++
  })

  worker.on('error', (error) => {
    logger.error('🔴 Worker error', {
      error: error instanceof Error ? error.message : String(error),
    })
  })

  logger.info('✅ BullMQ Autopilot Worker Started', {
    concurrency: 5,
    queueName: 'outbound-sync',
    timestamp: new Date().toISOString(),
  })

  return worker
}

/**
 * Process a single outbound sync job
 * 
 * Job data structure:
 * {
 *   queueId: string (OutboundSyncQueue.id)
 *   productId: string
 *   channelListingId: string
 *   targetChannel: string
 *   syncType: string
 * }
 */
async function processOutboundSyncJob(job: Job) {
  const { queueId, productId, channelListingId, targetChannel, syncType } = job.data

  logger.info('⚙️ Processing sync job', {
    jobId: job.id,
    queueId,
    productId,
    targetChannel,
    syncType,
    attempt: job.attemptsMade + 1,
  })

  try {
    // ─────────────────────────────────────────────────────────────────────
    // CRUCIAL CHECK: Grace Period (Phase 12a)
    // If user hit "Undo" during grace period, syncStatus will be CANCELLED
    // ─────────────────────────────────────────────────────────────────────
    const queueRecord = await prisma.outboundSyncQueue.findUnique({
      where: { id: queueId },
    })

    if (!queueRecord) {
      logger.warn('Queue record not found', { queueId })
      throw new Error(`Queue record ${queueId} not found`)
    }

    // If user cancelled during grace period, skip processing
    if ((queueRecord.syncStatus as any) === 'CANCELLED') {
      logger.info('⏭️ Skipping cancelled sync', {
        queueId,
        productId,
        reason: 'User cancelled during grace period',
      })
      cancelledCount++
      return { status: 'CANCELLED', queueId }
    }

    // Verify status is still PENDING
    if (queueRecord.syncStatus !== 'PENDING') {
      logger.warn('Queue record not in PENDING status', {
        queueId,
        currentStatus: queueRecord.syncStatus,
      })
      return { status: 'SKIPPED', queueId, reason: 'Not in PENDING status' }
    }

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 15: Publishing Control Checks
    // Skip sync if listing is unpublished or offers are inactive
    // ─────────────────────────────────────────────────────────────────────
    if (channelListingId) {
      const channelListing = await prisma.channelListing.findUnique({
        where: { id: channelListingId },
        include: { offers: true },
      })

      if (!channelListing) {
        logger.warn('Channel listing not found', { channelListingId })
        throw new Error(`Channel listing ${channelListingId} not found`)
      }

      // Check if listing is published
      if (!channelListing.isPublished) {
        logger.info('⏭️ Skipping unpublished listing', {
          queueId,
          channelListingId,
          reason: 'Listing isPublished = false',
        })
        await prisma.outboundSyncQueue.update({
          where: { id: queueId },
          data: {
            syncStatus: 'SKIPPED',
            errorMessage: 'Listing is unpublished (isPublished = false)',
          },
        })
        return { status: 'SKIPPED', queueId, reason: 'Listing unpublished' }
      }

      // Check if all offers are inactive (for offer-specific syncs)
      if (syncType === 'OFFER_SYNC' && channelListing.offers.length > 0) {
        const activeOffers = channelListing.offers.filter((o) => o.isActive !== false)
        if (activeOffers.length === 0) {
          logger.info('⏭️ Skipping sync with no active offers', {
            queueId,
            channelListingId,
            reason: 'All offers are inactive',
          })
          await prisma.outboundSyncQueue.update({
            where: { id: queueId },
            data: {
              syncStatus: 'SKIPPED',
              errorMessage: 'No active offers to sync',
            },
          })
          return { status: 'SKIPPED', queueId, reason: 'No active offers' }
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // PHASE 28: PRICING CALCULATION
    // Calculate target price based on pricing rules before sync
    // ─────────────────────────────────────────────────────────────────────
    if (channelListingId) {
      try {
        const product = await prisma.product.findUnique({
          where: { id: productId },
          select: {
            basePrice: true,
            costPrice: true,
            minMargin: true,
          },
        })

        const listing = await prisma.channelListing.findUnique({
          where: { id: channelListingId },
          select: {
            pricingRule: true,
            priceAdjustmentPercent: true,
            priceOverride: true,
            // TECH_DEBT #48 — without this we'd recompute even when
            // the seller has explicitly opted out of following the
            // master, and silently overwrite their per-marketplace
            // override with a rule-based value.
            followMasterPrice: true,
          },
        })

        if (product && listing && listing.followMasterPrice) {
          const pricingResult = calculateTargetPrice({
            masterPrice: product.basePrice,
            costPrice: product.costPrice,
            minMargin: product.minMargin,
            pricingRule: listing.pricingRule as 'FIXED' | 'MATCH_AMAZON' | 'PERCENT_OF_MASTER',
            priceAdjustmentPercent: listing.priceAdjustmentPercent,
          })

          logger.info('💰 Pricing calculated', {
            queueId,
            channelListingId,
            finalPrice: pricingResult.finalPrice.toString(),
            rule: pricingResult.rule,
            floorPrice: pricingResult.floorPrice.toString(),
            adjustmentApplied: pricingResult.adjustmentApplied,
            reason: pricingResult.reason,
          })

          // Update the listing with calculated price
          await prisma.channelListing.update({
            where: { id: channelListingId },
            data: {
              price: pricingResult.finalPrice,
            },
          })
        } else if (product && listing && !listing.followMasterPrice) {
          // followMasterPrice=false → seller has set a per-marketplace
          // price override. Skip the recompute so we don't trash it on
          // the next sync. The push uses listing.price as-is.
          logger.debug('💰 Skipping pricing recompute (followMasterPrice=false)', {
            queueId,
            channelListingId,
          })
        }
      } catch (pricingError) {
        logger.warn('⚠️ Pricing calculation failed, continuing with sync', {
          queueId,
          channelListingId,
          error: pricingError instanceof Error ? pricingError.message : String(pricingError),
        })
        // Don't fail the entire sync if pricing calculation fails
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // SYNC PROCESSING
    // Route to appropriate sync processor based on syncType
    // ─────────────────────────────────────────────────────────────────────
    let syncResult: any

    if (syncType === 'VARIATION_SYNC') {
      // Phase 12d: Variation Sync Engine
      logger.info('🔄 Processing variation sync', { queueId, productId })
      syncResult = await variationSyncProcessor.processVariationSync(queueRecord)
    } else {
      // Standard sync via OutboundSyncService
      logger.info('🔄 Processing standard sync', { queueId, productId, targetChannel })
      syncResult = await OutboundSyncService.processPendingSyncs()
    }

    // ─────────────────────────────────────────────────────────────────────
    // UPDATE QUEUE RECORD
    // ─────────────────────────────────────────────────────────────────────
    if (syncResult.success) {
      await prisma.outboundSyncQueue.update({
        where: { id: queueId },
        data: {
          syncStatus: 'SUCCESS',
          syncedAt: new Date(),
          payload: {
            ...(queueRecord.payload as any),
            processedBy: 'BullMQ',
            jobId: job.id,
          },
        },
      })

      logger.info('✅ Sync completed successfully', {
        queueId,
        productId,
        targetChannel,
        processingTime: job.finishedOn ? job.finishedOn - job.processedOn! : 0,
      })

      processedCount++
      return { status: 'SUCCESS', queueId, result: syncResult }
    } else {
      // Determine if this is a retryable error
      const isRetryable = syncResult.retryable !== false
      const newRetryCount = (queueRecord.retryCount || 0) + 1
      const exhausted = newRetryCount >= (queueRecord.maxRetries ?? 3)
      const nextRetryAt = isRetryable && !exhausted
        ? new Date(Date.now() + Math.pow(2, job.attemptsMade) * 5000)
        : null

      await prisma.outboundSyncQueue.update({
        where: { id: queueId },
        data: {
          syncStatus: (isRetryable && !exhausted) ? 'PENDING' : 'FAILED',
          errorMessage: syncResult.error || 'Unknown error',
          errorCode: syncResult.errorCode,
          retryCount: newRetryCount,
          nextRetryAt,
          // P3.2 — mark dead when retries exhausted
          ...(exhausted ? { isDead: true, diedAt: new Date() } : {}),
          payload: {
            ...(queueRecord.payload as any),
            processedBy: 'BullMQ',
            jobId: job.id,
            lastError: syncResult.error,
          },
        },
      })

      if (exhausted) {
        productEventService.emit({
          aggregateId: queueRecord.productId ?? queueId,
          aggregateType: 'ChannelListing',
          eventType: 'SYNC_DEAD',
          data: {
            queueId,
            channel: targetChannel,
            syncType,
            error: syncResult.error,
            retryCount: newRetryCount,
          },
          metadata: { source: 'SYSTEM' },
        }).catch(() => {})
      }

      if (isRetryable) {
        logger.warn('⚠️ Sync failed, will retry', {
          queueId,
          productId,
          error: syncResult.error,
          retryCount: (queueRecord.retryCount || 0) + 1,
          nextRetryAt,
        })
        throw new Error(syncResult.error) // BullMQ will retry
      } else {
        logger.error('❌ Sync failed permanently', {
          queueId,
          productId,
          error: syncResult.error,
          errorCode: syncResult.errorCode,
        })
        return { status: 'FAILED', queueId, error: syncResult.error }
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    logger.error('❌ Job processing error', {
      jobId: job.id,
      queueId,
      error: errorMsg,
      attempt: job.attemptsMade + 1,
      stack: error instanceof Error ? error.stack : undefined,
    })

    // Update queue record with error
    try {
      await prisma.outboundSyncQueue.update({
        where: { id: queueId },
        data: {
          errorMessage: errorMsg,
          retryCount: (job.attemptsMade || 0) + 1,
        },
      })
    } catch (updateError) {
      logger.error('Failed to update queue record with error', {
        queueId,
        error: updateError instanceof Error ? updateError.message : String(updateError),
      })
    }

    // Re-throw to let BullMQ handle retry
    throw error
  }
}

/**
 * Get worker statistics for monitoring
 */
export function getBullMQWorkerStats() {
  return {
    processed: processedCount,
    succeeded: successCount,
    failed: failureCount,
    cancelled: cancelledCount,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Reset worker statistics (for testing)
 */
export function resetBullMQWorkerStats() {
  processedCount = 0
  successCount = 0
  failureCount = 0
  cancelledCount = 0
  logger.info('🔄 BullMQ Worker stats reset')
}
