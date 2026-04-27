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
import { outboundSyncQueue } from '../lib/queue.js'

export class OutboundSyncServicePhase9 {
  /**
   * Phase 9: Enhanced trigger detection
   * Listens to changes on Product, ChannelListing, and Offer models
   */
  async detectAndQueueChanges(
    entityType: 'PRODUCT' | 'CHANNEL_LISTING' | 'OFFER',
    entityId: string,
    changeType: 'CREATE' | 'UPDATE' | 'DELETE',
    payload: any
  ): Promise<void> {
    try {
      switch (entityType) {
        case 'PRODUCT':
          await this.handleProductChange(entityId, changeType, payload)
          break
        case 'CHANNEL_LISTING':
          await this.handleChannelListingChange(entityId, changeType, payload)
          break
        case 'OFFER':
          await this.handleOfferChange(entityId, changeType, payload)
          break
      }
    } catch (error) {
      logger.error('Error detecting sync changes', {
        entityType,
        entityId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Handle Product changes (Master Catalog updates)
   * Queues sync for all connected channel listings
   */
  private async handleProductChange(
    productId: string,
    changeType: 'CREATE' | 'UPDATE' | 'DELETE',
    payload: Partial<any>
  ): Promise<void> {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { channelListings: true },
    })

    if (!product) return

    // Determine what changed
    const changedFields = Object.keys(payload)
    const syncType = this.determineSyncType(changedFields)

    logger.info('Product change detected', {
      productId,
      sku: product.sku,
      syncType,
      changedFields,
    })

    // Queue sync for each connected channel listing
    for (const listing of product.channelListings) {
      if (listing.syncLocked) {
        logger.info('Skipping sync for locked listing', {
          listingId: listing.id,
          channelMarket: listing.channelMarket,
        })
        continue
      }

      const queueRecord = await prisma.outboundSyncQueue.create({
        data: {
          productId,
          channelListingId: listing.id,
          targetChannel: listing.channel,
          targetRegion: listing.region,
          syncStatus: 'PENDING',
          syncType,
          // ── PHASE 12a: Grace Period (Undo Sync) ─────────────────────────
          // Set holdUntil to 5 minutes in the future to allow cancellation
          holdUntil: new Date(Date.now() + 5 * 60 * 1000),
          payload: {
            source: 'PRODUCT_CHANGE',
            changedFields,
            masterData: {
              name: product.name,
              basePrice: product.basePrice,
              totalStock: product.totalStock,
              bulletPoints: product.bulletPoints,
              categoryAttributes: product.categoryAttributes,
            },
          },
        },
      })

      // ── PHASE 13: Push to BullMQ Queue ──────────────────────────────────
      // Schedule job with 5-minute delay (grace period)
      await outboundSyncQueue.add(
        'sync-job',
        {
          queueId: queueRecord.id,
          productId,
          channelListingId: listing.id,
          targetChannel: listing.channel,
          syncType,
        },
        {
          delay: 5 * 60 * 1000, // 5 minute grace period
          jobId: queueRecord.id, // Use queue ID as job ID for tracking
        }
      )

      logger.info('Queued product sync', {
        queueId: queueRecord.id,
        productId,
        listingId: listing.id,
        channelMarket: listing.channelMarket,
        delayMs: 5 * 60 * 1000,
      })
    }
  }

  /**
   * Handle ChannelListing changes (Platform-specific updates)
   * Queues sync for the specific channel listing
   */
  private async handleChannelListingChange(
    channelListingId: string,
    changeType: 'CREATE' | 'UPDATE' | 'DELETE',
    payload: Partial<any>
  ): Promise<void> {
    const listing = await prisma.channelListing.findUnique({
      where: { id: channelListingId },
      include: { product: true, offers: true },
    })

    if (!listing) return

    const changedFields = Object.keys(payload)
    const syncType = this.determineSyncType(changedFields)

    logger.info('ChannelListing change detected', {
      listingId: channelListingId,
      channelMarket: listing.channelMarket,
      syncType,
      changedFields,
    })

    // If syncFromMaster flag is set, merge master data
    let syncPayload: any = {
      source: 'CHANNEL_LISTING_CHANGE',
      changedFields,
      listingData: {
        title: listing.title,
        description: listing.description,
        price: listing.price,
        quantity: listing.quantity,
        platformAttributes: listing.platformAttributes,
      },
    }

    if (payload.syncFromMaster) {
      syncPayload.masterData = {
        name: listing.product.name,
        basePrice: listing.product.basePrice,
        totalStock: listing.product.totalStock,
        bulletPoints: listing.product.bulletPoints,
      }
    }

    const queueRecord = await prisma.outboundSyncQueue.create({
      data: {
        channelListingId,
        productId: listing.productId,
        targetChannel: listing.channel,
        targetRegion: listing.region,
        syncStatus: 'PENDING',
        syncType,
        // ── PHASE 12a: Grace Period (Undo Sync) ─────────────────────────
        // Set holdUntil to 5 minutes in the future to allow cancellation
        holdUntil: new Date(Date.now() + 5 * 60 * 1000),
        payload: syncPayload,
      },
    })

    // ── PHASE 13: Push to BullMQ Queue ──────────────────────────────────
    // Schedule job with 5-minute delay (grace period)
    await outboundSyncQueue.add(
      'sync-job',
      {
        queueId: queueRecord.id,
        productId: listing.productId,
        channelListingId,
        targetChannel: listing.channel,
        syncType,
      },
      {
        delay: 5 * 60 * 1000, // 5 minute grace period
        jobId: queueRecord.id,
      }
    )

    logger.info('Queued channel listing sync', {
      queueId: queueRecord.id,
      listingId: channelListingId,
      channelMarket: listing.channelMarket,
      delayMs: 5 * 60 * 1000,
    })
  }

  /**
   * Handle Offer changes (Fulfillment-specific updates)
   * Queues sync for the parent channel listing
   */
  private async handleOfferChange(
    offerId: string,
    changeType: 'CREATE' | 'UPDATE' | 'DELETE',
    payload: Partial<any>
  ): Promise<void> {
    const offer = await prisma.offer.findUnique({
      where: { id: offerId },
      include: { channelListing: true },
    })

    if (!offer) return

    const changedFields = Object.keys(payload)
    const syncType = this.determineSyncType(changedFields)

    logger.info('Offer change detected', {
      offerId,
      fulfillmentMethod: offer.fulfillmentMethod,
      syncType,
      changedFields,
    })

    const queueRecord = await prisma.outboundSyncQueue.create({
      data: {
        channelListingId: offer.channelListingId,
        productId: offer.channelListing.productId,
        targetChannel: offer.channelListing.channel,
        targetRegion: offer.channelListing.region,
        syncStatus: 'PENDING',
        syncType,
        // ── PHASE 12a: Grace Period (Undo Sync) ─────────────────────────
        // Set holdUntil to 5 minutes in the future to allow cancellation
        holdUntil: new Date(Date.now() + 5 * 60 * 1000),
        payload: {
          source: 'OFFER_CHANGE',
          changedFields,
          offerData: {
            fulfillmentMethod: offer.fulfillmentMethod,
            sku: offer.sku,
            price: offer.price,
            quantity: offer.quantity,
            isActive: offer.isActive,
          },
        },
      },
    })

    // ── PHASE 13: Push to BullMQ Queue ──────────────────────────────────
    // Schedule job with 5-minute delay (grace period)
    await outboundSyncQueue.add(
      'sync-job',
      {
        queueId: queueRecord.id,
        productId: offer.channelListing.productId,
        channelListingId: offer.channelListingId,
        targetChannel: offer.channelListing.channel,
        syncType,
      },
      {
        delay: 5 * 60 * 1000, // 5 minute grace period
        jobId: queueRecord.id,
      }
    )

    logger.info('Queued offer sync', {
      queueId: queueRecord.id,
      offerId,
      channelListingId: offer.channelListingId,
      fulfillmentMethod: offer.fulfillmentMethod,
      delayMs: 5 * 60 * 1000,
    })
  }

  /**
   * Determine sync type based on changed fields
   */
  private determineSyncType(changedFields: string[]): string {
    if (changedFields.includes('price') || changedFields.includes('basePrice')) {
      return 'PRICE_UPDATE'
    }
    if (changedFields.includes('quantity') || changedFields.includes('totalStock')) {
      return 'QUANTITY_UPDATE'
    }
    if (changedFields.includes('title') || changedFields.includes('description')) {
      return 'LISTING_SYNC'
    }
    if (changedFields.includes('fulfillmentMethod') || changedFields.includes('sku')) {
      return 'OFFER_SYNC'
    }
    return 'FULL_SYNC'
  }

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
