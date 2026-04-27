/**
 * Variation Sync Processor Service
 * Phase 12f: Live Amazon SP-API Connection
 *
 * Processes LISTING_SYNC queue items for parent products with variations.
 * Builds Amazon SP-API payloads and submits them to production.
 */

import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';
import { amazonMapperService } from './amazon-mapper.service.js';
import { amazonSpApiClient } from '../clients/amazon-sp-api.client.js';
import { outboundSyncServicePhase9 } from './outbound-sync-phase9.service.js';

const prisma = new PrismaClient();

export class VariationSyncProcessor {
  /**
   * Process a LISTING_SYNC queue item for a variation parent
   * 
   * @param queueItem - The outbound sync queue item
   * @returns true if successful, false otherwise
   */
  async processVariationSync(queueItem: any): Promise<boolean> {
    try {
      const { id: queueItemId, productId, channelListingId, payload } = queueItem;

      logger.info('Processing variation sync', {
        queueItemId,
        productId,
        channelListingId,
        source: payload?.source,
      });

      // Fetch the product to verify it's a parent with variations
      const product = await (prisma as any).product.findUnique({
        where: { id: productId },
      });

      if (!product) {
        throw new Error(`Product not found: ${productId}`);
      }

      if (!product.isParent) {
        logger.warn('Product is not a parent - skipping variation sync', {
          productId,
          sku: product.sku,
        });
        await outboundSyncServicePhase9.markSyncSuccess(queueItemId);
        return true;
      }

      // Fetch the channel listing
      const channelListing = await (prisma as any).channelListing.findUnique({
        where: { id: channelListingId },
      });

      if (!channelListing) {
        throw new Error(`ChannelListing not found: ${channelListingId}`);
      }

      if (!channelListing.variationTheme) {
        throw new Error(
          `ChannelListing has no variation theme: ${channelListingId}`
        );
      }

      // Build the Amazon variation payload
      logger.info('Building Amazon variation payload', {
        productId,
        channelListingId,
        variationTheme: channelListing.variationTheme,
      });

      const variationPayload = await amazonMapperService.buildVariationPayload(
        channelListingId,
        productId
      );

      // ── PHASE 12f: Submit to live Amazon SP-API ────────────────────────────
      logger.info('🚀 Submitting variation payload to Amazon SP-API', {
        productId,
        productSku: product.sku,
        channelMarket: channelListing.channelMarket,
        variationTheme: variationPayload.variationTheme,
        parentSku: variationPayload.parentSku,
        childCount: variationPayload.childCount,
      });

      // Get seller ID from environment
      const sellerId = process.env.AMAZON_SELLER_ID;
      if (!sellerId) {
        throw new Error('AMAZON_SELLER_ID not configured in environment');
      }

      // Submit each item (parent + children) to SP-API
      const submitResults = [];
      for (const item of variationPayload.items) {
        const result = await amazonSpApiClient.submitListingPayload({
          sellerId,
          sku: item.sku,
          payload: {
            attributes: {
              item_name: [{ value: item.title || product.name }],
              ...(item.parentage === 'parent' && {
                item_type: [{ value: channelListing.variationTheme }],
              }),
              ...(item.parentage === 'child' && item.variationAttributes && {
                ...Object.entries(item.variationAttributes).reduce(
                  (acc, [key, value]) => ({
                    ...acc,
                    [key]: [{ value: String(value) }],
                  }),
                  {}
                ),
              }),
              price: [{ currency: 'USD', value: item.price }],
              quantity: [{ value: item.quantity }],
              fulfillment_channel: [{ value: item.fulfillmentChannel || 'DEFAULT' }],
            },
          },
        });

        submitResults.push(result);

        if (!result.success) {
          logger.warn('Failed to submit item to Amazon SP-API', {
            sku: item.sku,
            error: result.error,
          });
        }
      }

      // Check if all submissions were successful
      const allSuccessful = submitResults.every((r) => r.success);
      const failedCount = submitResults.filter((r) => !r.success).length;

      if (!allSuccessful) {
        const errorMessages = submitResults
          .filter((r) => !r.success)
          .map((r) => `${r.sku}: ${r.error}`)
          .join(' | ');

        throw new Error(`Failed to submit ${failedCount} items to Amazon: ${errorMessages}`);
      }

      // Mark as successful
      await outboundSyncServicePhase9.markSyncSuccess(queueItemId);

      logger.info('✅ Variation sync completed successfully', {
        queueItemId,
        productId,
        productSku: product.sku,
        channelMarket: channelListing.channelMarket,
        itemsSubmitted: submitResults.length,
        successCount: submitResults.filter((r) => r.success).length,
      });

      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      logger.error('❌ Variation sync failed', {
        queueItemId: queueItem.id,
        productId: queueItem.productId,
        error: errorMessage,
      });

      // Mark as failed with retry
      await outboundSyncServicePhase9.markSyncFailed(
        queueItem.id,
        errorMessage
      );

      return false;
    }
  }

  /**
   * Check if a queue item is a variation sync
   * 
   * @param queueItem - The queue item to check
   * @returns true if this is a variation sync
   */
  isVariationSync(queueItem: any): boolean {
    const { syncType, payload } = queueItem;

    // Check if it's a LISTING_SYNC with variation-related source
    if (syncType === 'LISTING_SYNC') {
      const source = payload?.source;
      return (
        source === 'CHILD_VARIATION_CHANGE' ||
        source === 'VARIATION_THEME_UPDATE'
      );
    }

    return false;
  }

  /**
   * Get all pending variation syncs
   * 
   * @returns Array of pending variation sync queue items
   */
  async getPendingVariationSyncs(): Promise<any[]> {
    const items = await (prisma as any).outboundSyncQueue.findMany({
      where: {
        syncStatus: 'PENDING',
        syncType: 'LISTING_SYNC',
        OR: [
          { 'payload.source': 'CHILD_VARIATION_CHANGE' },
          { 'payload.source': 'VARIATION_THEME_UPDATE' },
        ],
      },
      include: {
        product: true,
        channelListing: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return items.filter((item) => this.isVariationSync(item));
  }
}

export const variationSyncProcessor = new VariationSyncProcessor();
