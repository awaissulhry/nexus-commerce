/**
 * Phase 9: Enhanced Outbound Sync Service
 * Phase 12d: Variation Sync Engine
 * Phase 13: BullMQ Integration
 *
 * Handles sync triggers for:
 * - Product changes (Master Catalog updates)
 * - ChannelListing changes (Platform-specific updates)
 * - Offer changes (Fulfillment-specific updates)
 * - Variation changes (Parent/Child sync with smart parent triggers)
 *
 * Now pushes jobs to BullMQ queue after creating Prisma records
 */

import { prisma } from '@nexus/database'
import { OutboundSyncStatus } from '@prisma/client'
import { logger } from '../utils/logger.js'
import { amazonMapperService } from './amazon-mapper.service.js'
export class OutboundSyncServicePhase9 {
  /**
   * Get pending sync items for processing
   * ── PHASE 12a: Grace Period (Undo Sync) ─────────────────────────
   * Only returns items where holdUntil is NULL or in the past
   */
  async getPendingSyncItems(limit: number = 100) {
    return prisma.outboundSyncQueue.findMany({
      where: {
        syncStatus: OutboundSyncStatus.PENDING,
        nextRetryAt: { lte: new Date() },
        // Only process items that are not in grace period
        OR: [
          { holdUntil: null },
          { holdUntil: { lte: new Date() } },
        ],
      },
      include: {
        product: true,
        channelListing: { include: { offers: true } },
      },
      take: limit,
    })
  }

  /**
   * Mark sync item as successful
   */
  async markSyncSuccess(queueItemId: string) {
    return prisma.outboundSyncQueue.update({
      where: { id: queueItemId },
      data: {
        syncStatus: OutboundSyncStatus.SUCCESS,
        syncedAt: new Date(),
      },
    })
  }

  /**
   * Mark sync item as failed with retry logic
   */
  async markSyncFailed(queueItemId: string, error: string) {
    const item = await (prisma as any).outboundSyncQueue.findUnique({
      where: { id: queueItemId },
    })

    if (!item) return

    const nextRetryAt =
      item.retryCount < item.maxRetries
        ? new Date(Date.now() + 5 * 60 * 1000) // 5 min backoff
        : null

    return (prisma as any).outboundSyncQueue.update({
      where: { id: queueItemId },
      data: {
        syncStatus:
          item.retryCount < item.maxRetries
            ? 'PENDING'
            : 'FAILED',
        errorMessage: error,
        retryCount: { increment: 1 },
        nextRetryAt,
      },
    })
  }

  /**
   * ── PHASE 12d: Variation Sync Engine ──────────────────────────────
   * Handle child product attribute changes and trigger parent sync
   *
   * When a child product's variation attributes change (e.g., color),
   * automatically queue a LISTING_SYNC for the parent's Amazon listing
   */
  async handleChildVariationChange(
    childProductId: string,
    changeType: 'CREATE' | 'UPDATE' | 'DELETE',
    payload: Partial<any>
  ): Promise<void> {
    try {
      // Fetch the child product with its master product
      const childProduct = await (prisma as any).product.findUnique({
        where: { id: childProductId },
        include: {
          masterProduct: {
            include: {
              channelListings: {
                where: { channel: 'AMAZON' },
              },
            },
          },
        },
      })

      if (!childProduct || !childProduct.masterProduct) {
        logger.debug('Child product has no master product', { childProductId })
        return
      }

      const parentProduct = childProduct.masterProduct
      const changedFields = Object.keys(payload)

      // Check if variation attributes changed
      const variationAttributesChanged = changedFields.includes('categoryAttributes')
      if (!variationAttributesChanged) {
        logger.debug('No variation attribute changes detected', { childProductId })
        return
      }

      logger.info('Child variation attributes changed - triggering parent sync', {
        childProductId,
        childSku: childProduct.sku,
        parentProductId: parentProduct.id,
        parentSku: parentProduct.sku,
        changedFields,
      })

      // Queue LISTING_SYNC for each Amazon channel listing of the parent
      for (const amazonListing of parentProduct.channelListings) {
        if (amazonListing.syncLocked) {
          logger.info('Skipping sync for locked parent listing', {
            listingId: amazonListing.id,
            channelMarket: amazonListing.channelMarket,
          })
          continue
        }

        // Only sync if parent has variation theme configured
        if (!amazonListing.variationTheme) {
          logger.warn('Parent listing has no variation theme', {
            listingId: amazonListing.id,
            parentSku: parentProduct.sku,
          })
          continue
        }

        await (prisma as any).outboundSyncQueue.create({
          data: {
            productId: parentProduct.id,
            channelListingId: amazonListing.id,
            targetChannel: 'AMAZON',
            targetRegion: amazonListing.region,
            syncStatus: 'PENDING',
            syncType: 'LISTING_SYNC',
            holdUntil: new Date(Date.now() + 5 * 60 * 1000),
            payload: {
              source: 'CHILD_VARIATION_CHANGE',
              triggerChildProductId: childProductId,
              triggerChildSku: childProduct.sku,
              changedFields,
              reason: 'Parent listing must be updated when child variation attributes change',
              variationTheme: amazonListing.variationTheme,
            },
          },
        })

        logger.info('Queued parent variation sync (smart trigger)', {
          parentProductId: parentProduct.id,
          parentSku: parentProduct.sku,
          listingId: amazonListing.id,
          channelMarket: amazonListing.channelMarket,
          triggerChildSku: childProduct.sku,
        })
      }
    } catch (error) {
      logger.error('Error handling child variation change', {
        childProductId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Build and log Amazon variation payload for a parent product
   * Used by the Autopilot when processing LISTING_SYNC for variation parents
   */
  async buildAndLogVariationPayload(
    channelListingId: string,
    productId: string
  ): Promise<void> {
    try {
      logger.info('Building Amazon variation payload', {
        productId,
        channelListingId,
      })

      const payload = await amazonMapperService.buildVariationPayload(
        channelListingId,
        productId
      )

      logger.info('📦 AMAZON VARIATION PAYLOAD', {
        payload: JSON.stringify(payload, null, 2),
      })

      logger.info('✅ Variation payload formatted successfully', {
        parentSku: payload.parentSku,
        childCount: payload.childCount,
        variationTheme: payload.variationTheme,
        itemCount: payload.items.length,
      })
    } catch (error) {
      logger.error('Error building variation payload', {
        productId,
        channelListingId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}

export const outboundSyncServicePhase9 = new OutboundSyncServicePhase9()
