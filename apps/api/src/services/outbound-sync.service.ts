import prisma from "../db.js";

// ── Data Structures ──────────────────────────────────────────────────────

interface SyncPayload {
  price?: number;
  quantity?: number;
  categoryAttributes?: Record<string, any>;
  title?: string;
  description?: string;
  images?: string[];
  [key: string]: any;
}

interface QueueResult {
  success: boolean;
  queueId?: string;
  message: string;
}

interface SyncResult {
  success: boolean;
  queueId: string;
  channel: string;
  status: string;
  message: string;
  error?: string;
}

interface ProcessingStats {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: Array<{ queueId: string; error: string }>;
}

// ── Outbound Sync Service ────────────────────────────────────────────────

export class OutboundSyncService {
  private stats = {
    queued: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
  };

  /**
   * Queue a product update for outbound sync to a specific channel
   */
  async queueProductUpdate(
    productId: string,
    targetChannel: "AMAZON" | "EBAY" | "SHOPIFY" | "WOOCOMMERCE",
    syncType: "PRICE_UPDATE" | "QUANTITY_UPDATE" | "ATTRIBUTE_UPDATE" | "FULL_SYNC",
    payload: SyncPayload
  ): Promise<QueueResult> {
    try {
      // Verify product exists
      const product = await prisma.product.findUnique({
        where: { id: productId },
      });

      if (!product) {
        return {
          success: false,
          message: `Product ${productId} not found`,
        };
      }

      // Create queue entry
      const queueEntry = await prisma.outboundSyncQueue.create({
        data: {
          productId,
          targetChannel,
          syncStatus: "PENDING",
          syncType,
          payload,
          retryCount: 0,
          maxRetries: 3,
          externalListingId: this.getExternalListingId(product, targetChannel),
        },
      });

      this.stats.queued++;

      return {
        success: true,
        queueId: queueEntry.id,
        message: `Product queued for ${targetChannel} sync`,
      };
    } catch (error) {
      console.error("Error queuing product update:", error);
      return {
        success: false,
        message: `Failed to queue product: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Process all pending syncs in the queue
   */
  async processPendingSyncs(): Promise<ProcessingStats> {
    const stats: ProcessingStats = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      errors: [],
    };

    try {
      // Get all pending syncs
      const pendingItems = await prisma.outboundSyncQueue.findMany({
        where: {
          syncStatus: "PENDING",
        },
        include: {
          product: true,
        },
        orderBy: {
          createdAt: "asc",
        },
      });

      console.log(`Processing ${pendingItems.length} pending syncs`);

      for (const item of pendingItems) {
        try {
          // Mark as in progress
          await prisma.outboundSyncQueue.update({
            where: { id: item.id },
            data: { syncStatus: "IN_PROGRESS" },
          });

          let result: SyncResult;

          // Route to appropriate sync method
          if (item.targetChannel === "AMAZON") {
            result = await this.syncToAmazon(item);
          } else if (item.targetChannel === "EBAY") {
            result = await this.syncToEbay(item);
          } else if (item.targetChannel === "SHOPIFY") {
            result = await this.syncToShopify(item);
          } else if (item.targetChannel === "WOOCOMMERCE") {
            result = await this.syncToWoocommerce(item);
          } else {
            throw new Error(`Unknown channel: ${item.targetChannel}`);
          }

          if (result.success) {
            // Mark as successful
            await prisma.outboundSyncQueue.update({
              where: { id: item.id },
              data: {
                syncStatus: "SUCCESS",
                syncedAt: new Date(),
              },
            });
            stats.succeeded++;
          } else {
            // Handle retry logic
            await this.handleSyncFailure(item, result.error || "Unknown error");
            stats.failed++;
            stats.errors.push({
              queueId: item.id,
              error: result.error || "Unknown error",
            });
          }

          stats.processed++;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          await this.handleSyncFailure(item, errorMessage);
          stats.failed++;
          stats.errors.push({
            queueId: item.id,
            error: errorMessage,
          });
          stats.processed++;
        }
      }

      // Get retry items
      const retryItems = await prisma.outboundSyncQueue.findMany({
        where: {
          syncStatus: "FAILED",
          nextRetryAt: {
            lte: new Date(),
          },
          retryCount: {
            lt: 3,
          },
        },
        include: {
          product: true,
        },
      });

      console.log(`Processing ${retryItems.length} retry items`);

      for (const item of retryItems) {
        try {
          // Mark as in progress
          await prisma.outboundSyncQueue.update({
            where: { id: item.id },
            data: { syncStatus: "IN_PROGRESS" },
          });

          let result: SyncResult;

          if (item.targetChannel === "AMAZON") {
            result = await this.syncToAmazon(item);
          } else if (item.targetChannel === "EBAY") {
            result = await this.syncToEbay(item);
          } else if (item.targetChannel === "SHOPIFY") {
            result = await this.syncToShopify(item);
          } else if (item.targetChannel === "WOOCOMMERCE") {
            result = await this.syncToWoocommerce(item);
          } else {
            throw new Error(`Unknown channel: ${item.targetChannel}`);
          }

          if (result.success) {
            await prisma.outboundSyncQueue.update({
              where: { id: item.id },
              data: {
                syncStatus: "SUCCESS",
                syncedAt: new Date(),
              },
            });
            stats.succeeded++;
          } else {
            await this.handleSyncFailure(item, result.error || "Unknown error");
            stats.failed++;
            stats.errors.push({
              queueId: item.id,
              error: result.error || "Unknown error",
            });
          }

          stats.processed++;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          await this.handleSyncFailure(item, errorMessage);
          stats.failed++;
          stats.errors.push({
            queueId: item.id,
            error: errorMessage,
          });
          stats.processed++;
        }
      }

      return stats;
    } catch (error) {
      console.error("Error processing pending syncs:", error);
      throw error;
    }
  }

  /**
   * Sync product to Amazon using SP-API
   * PATCH /listings/2021-08-01/items/{sellerId}/{sku}
   */
  private async syncToAmazon(queueItem: any): Promise<SyncResult> {
    try {
      const { product, payload, id: queueId } = queueItem;

      // Construct Amazon SP-API payload
      const amazonPayload = this.constructAmazonPayload(payload);

      // TODO: Call actual Amazon SP-API
      // For now, simulate the API call
      console.log(`[AMAZON] Syncing product ${product.sku}:`, amazonPayload);

      // Simulate API call
      const success = Math.random() > 0.1; // 90% success rate for demo

      if (!success) {
        throw new Error("Simulated Amazon API error");
      }

      return {
        success: true,
        queueId,
        channel: "AMAZON",
        status: "SUCCESS",
        message: `Product ${product.sku} synced to Amazon`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        success: false,
        queueId: queueItem.id,
        channel: "AMAZON",
        status: "FAILED",
        message: `Failed to sync to Amazon`,
        error: errorMessage,
      };
    }
  }

  /**
   * Sync product to eBay using Inventory API
   * PUT /sell/inventory/v1/inventory_item/{sku}
   */
  private async syncToEbay(queueItem: any): Promise<SyncResult> {
    try {
      const { product, payload, id: queueId } = queueItem;

      // Construct eBay Inventory API payload
      const ebayPayload = this.constructEbayPayload(payload);

      // TODO: Call actual eBay Inventory API
      // For now, simulate the API call
      console.log(`[EBAY] Syncing product ${product.sku}:`, ebayPayload);

      // Simulate API call
      const success = Math.random() > 0.1; // 90% success rate for demo

      if (!success) {
        throw new Error("Simulated eBay API error");
      }

      return {
        success: true,
        queueId,
        channel: "EBAY",
        status: "SUCCESS",
        message: `Product ${product.sku} synced to eBay`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        success: false,
        queueId: queueItem.id,
        channel: "EBAY",
        status: "FAILED",
        message: `Failed to sync to eBay`,
        error: errorMessage,
      };
    }
  }

  /**
   * Sync product to Shopify
   */
  private async syncToShopify(queueItem: any): Promise<SyncResult> {
    try {
      const { product, payload, id: queueId } = queueItem;

      // Construct Shopify payload
      const shopifyPayload = this.constructShopifyPayload(payload);

      console.log(`[SHOPIFY] Syncing product ${product.sku}:`, shopifyPayload);

      // Simulate API call
      const success = Math.random() > 0.1;

      if (!success) {
        throw new Error("Simulated Shopify API error");
      }

      return {
        success: true,
        queueId,
        channel: "SHOPIFY",
        status: "SUCCESS",
        message: `Product ${product.sku} synced to Shopify`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        success: false,
        queueId: queueItem.id,
        channel: "SHOPIFY",
        status: "FAILED",
        message: `Failed to sync to Shopify`,
        error: errorMessage,
      };
    }
  }

  /**
   * Sync product to WooCommerce
   */
  private async syncToWoocommerce(queueItem: any): Promise<SyncResult> {
    try {
      const { product, payload, id: queueId } = queueItem;

      // Construct WooCommerce payload
      const wooPayload = this.constructWoocommercePayload(payload);

      console.log(`[WOOCOMMERCE] Syncing product ${product.sku}:`, wooPayload);

      // Simulate API call
      const success = Math.random() > 0.1;

      if (!success) {
        throw new Error("Simulated WooCommerce API error");
      }

      return {
        success: true,
        queueId,
        channel: "WOOCOMMERCE",
        status: "SUCCESS",
        message: `Product ${product.sku} synced to WooCommerce`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        success: false,
        queueId: queueItem.id,
        channel: "WOOCOMMERCE",
        status: "FAILED",
        message: `Failed to sync to WooCommerce`,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle sync failure with retry logic
   */
  private async handleSyncFailure(queueItem: any, errorMessage: string): Promise<void> {
    const newRetryCount = queueItem.retryCount + 1;
    const maxRetries = queueItem.maxRetries || 3;

    if (newRetryCount >= maxRetries) {
      // Max retries exceeded, mark as failed
      await prisma.outboundSyncQueue.update({
        where: { id: queueItem.id },
        data: {
          syncStatus: "FAILED",
          errorMessage,
          errorCode: "MAX_RETRIES_EXCEEDED",
          retryCount: newRetryCount,
        },
      });
    } else {
      // Schedule retry with exponential backoff
      const backoffMs = Math.pow(2, newRetryCount) * 1000; // 2s, 4s, 8s
      const nextRetryAt = new Date(Date.now() + backoffMs);

      await prisma.outboundSyncQueue.update({
        where: { id: queueItem.id },
        data: {
          syncStatus: "FAILED",
          errorMessage,
          errorCode: "RETRY_SCHEDULED",
          retryCount: newRetryCount,
          nextRetryAt,
        },
      });
    }
  }

  /**
   * Construct Amazon SP-API payload
   * PATCH /listings/2021-08-01/items/{sellerId}/{sku}
   */
  private constructAmazonPayload(payload: SyncPayload): Record<string, any> {
    const amazonPayload: Record<string, any> = {
      attributes: {},
    };

    if (payload.price !== undefined) {
      amazonPayload.attributes.price = [
        {
          value: payload.price,
          marketplaceId: "ATVPDKIKX0DER", // US marketplace
        },
      ];
    }

    if (payload.quantity !== undefined) {
      amazonPayload.attributes.fulfillmentAvailability = [
        {
          fulfillmentChannelCode: "DEFAULT",
          quantity: payload.quantity,
        },
      ];
    }

    if (payload.title) {
      amazonPayload.attributes.title = [{ value: payload.title }];
    }

    if (payload.description) {
      amazonPayload.attributes.description = [{ value: payload.description }];
    }

    if (payload.categoryAttributes) {
      // Merge category-specific attributes
      Object.entries(payload.categoryAttributes).forEach(([key, value]) => {
        amazonPayload.attributes[key] = [{ value }];
      });
    }

    return amazonPayload;
  }

  /**
   * Construct eBay Inventory API payload
   * PUT /sell/inventory/v1/inventory_item/{sku}
   */
  private constructEbayPayload(payload: SyncPayload): Record<string, any> {
    const ebayPayload: Record<string, any> = {};

    if (payload.quantity !== undefined) {
      ebayPayload.availability = {
        availableQuantity: payload.quantity,
      };
    }

    if (payload.price !== undefined) {
      ebayPayload.price = {
        value: payload.price.toString(),
        currency: "USD",
      };
    }

    if (payload.title) {
      ebayPayload.title = payload.title;
    }

    if (payload.description) {
      ebayPayload.description = payload.description;
    }

    if (payload.images && payload.images.length > 0) {
      ebayPayload.images = payload.images.map((url) => ({
        imageUrl: url,
      }));
    }

    return ebayPayload;
  }

  /**
   * Construct Shopify payload
   */
  private constructShopifyPayload(payload: SyncPayload): Record<string, any> {
    const shopifyPayload: Record<string, any> = {
      product: {},
    };

    if (payload.title) {
      shopifyPayload.product.title = payload.title;
    }

    if (payload.description) {
      shopifyPayload.product.body_html = payload.description;
    }

    if (payload.price !== undefined || payload.quantity !== undefined) {
      shopifyPayload.product.variants = [
        {
          price: payload.price,
          inventory_quantity: payload.quantity,
        },
      ];
    }

    return shopifyPayload;
  }

  /**
   * Construct WooCommerce payload
   */
  private constructWoocommercePayload(payload: SyncPayload): Record<string, any> {
    const wooPayload: Record<string, any> = {};

    if (payload.title) {
      wooPayload.name = payload.title;
    }

    if (payload.description) {
      wooPayload.description = payload.description;
    }

    if (payload.price !== undefined) {
      wooPayload.regular_price = payload.price.toString();
    }

    if (payload.quantity !== undefined) {
      wooPayload.stock_quantity = payload.quantity;
    }

    if (payload.images && payload.images.length > 0) {
      wooPayload.images = payload.images.map((url) => ({
        src: url,
      }));
    }

    return wooPayload;
  }

  /**
   * Get external listing ID from product based on channel
   */
  private getExternalListingId(
    product: any,
    channel: "AMAZON" | "EBAY" | "SHOPIFY" | "WOOCOMMERCE"
  ): string | null {
    switch (channel) {
      case "AMAZON":
        return product.amazonAsin || null;
      case "EBAY":
        return product.ebayItemId || null;
      case "SHOPIFY":
        return product.shopifyProductId || null;
      case "WOOCOMMERCE":
        return product.woocommerceProductId || null;
      default:
        return null;
    }
  }

  /**
   * Get queue status
   */
  async getQueueStatus(
    filters?: {
      status?: string;
      channel?: string;
      productId?: string;
    }
  ): Promise<any[]> {
    const where: any = {};

    if (filters?.status) {
      where.syncStatus = filters.status;
    }

    if (filters?.channel) {
      where.targetChannel = filters.channel;
    }

    if (filters?.productId) {
      where.productId = filters.productId;
    }

    return prisma.outboundSyncQueue.findMany({
      where,
      include: {
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            basePrice: true,
            totalStock: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  }

  /**
   * Retry a specific queue item
   */
  async retryQueueItem(queueId: string): Promise<QueueResult> {
    try {
      const queueItem = await prisma.outboundSyncQueue.findUnique({
        where: { id: queueId },
      });

      if (!queueItem) {
        return {
          success: false,
          message: `Queue item ${queueId} not found`,
        };
      }

      // Reset for retry
      await prisma.outboundSyncQueue.update({
        where: { id: queueId },
        data: {
          syncStatus: "PENDING",
          retryCount: 0,
          errorMessage: null,
          errorCode: null,
          nextRetryAt: null,
        },
      });

      return {
        success: true,
        queueId,
        message: `Queue item reset for retry`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to retry queue item: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Get sync statistics
   */
  getStats() {
    return this.stats;
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      queued: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
    };
  }
}

export default new OutboundSyncService();
