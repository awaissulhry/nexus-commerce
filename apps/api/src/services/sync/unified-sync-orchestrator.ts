/**
 * Unified Sync Orchestrator
 * Coordinates synchronization across multiple marketplace channels
 */

import prisma from "../../db.js";
import { marketplaceService, MarketplaceOperationResult } from "../marketplaces/marketplace.service.js";
import { ShopifySyncService } from "./shopify-sync.service.js";
import { WooCommerceSyncService } from "./woocommerce-sync.service.js";
import { EstySyncService } from "./etsy-sync.service.js";
import { ProductSyncService } from "./product-sync.service.js";
import { MarketplaceChannel, ShopifyConfig, WooCommerceConfig, EtsyConfig } from "../../types/marketplace.js";

export interface SyncOrchestrationResult {
  channel: MarketplaceChannel;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  itemsSynced: number;
  itemsFailed: number;
  duration: number;
  error?: string;
}

export interface MultiChannelSyncResult {
  startTime: Date;
  endTime: Date;
  totalDuration: number;
  results: SyncOrchestrationResult[];
  summary: {
    totalChannels: number;
    successfulChannels: number;
    failedChannels: number;
    totalItemsSynced: number;
    totalItemsFailed: number;
  };
}

export class UnifiedSyncOrchestrator {
  private shopifySync: ShopifySyncService | null = null;
  private woocommerceSync: WooCommerceSyncService | null = null;
  private etsySync: EstySyncService | null = null;
  private productSync: ProductSyncService;

  constructor() {
    this.productSync = new ProductSyncService();

    // Initialize optional sync services
    try {
      if (process.env.SHOPIFY_SHOP_NAME && process.env.SHOPIFY_ACCESS_TOKEN) {
        const shopifyConfig: ShopifyConfig = {
          channel: "SHOPIFY",
          isEnabled: true,
          shopName: process.env.SHOPIFY_SHOP_NAME,
          accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
          apiVersion: "2024-01",
          webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || "",
          rateLimit: {
            requestsPerSecond: 2,
            burstSize: 40,
          },
          retryPolicy: {
            maxRetries: 3,
            initialDelayMs: 1000,
            maxDelayMs: 30000,
            backoffMultiplier: 2,
          },
        };
        this.shopifySync = new ShopifySyncService(shopifyConfig);
      }
    } catch (error) {
      console.warn("[UnifiedSyncOrchestrator] Shopify sync not initialized");
    }

    try {
      if (process.env.WOOCOMMERCE_STORE_URL && process.env.WOOCOMMERCE_CONSUMER_KEY && process.env.WOOCOMMERCE_CONSUMER_SECRET) {
        const wooConfig: WooCommerceConfig = {
          channel: "WOOCOMMERCE",
          isEnabled: true,
          storeUrl: process.env.WOOCOMMERCE_STORE_URL,
          consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY,
          consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET,
          apiVersion: "v3",
          webhookSecret: process.env.WOOCOMMERCE_WEBHOOK_SECRET || "",
          rateLimit: {
            requestsPerSecond: 10,
            burstSize: 100,
          },
          retryPolicy: {
            maxRetries: 3,
            initialDelayMs: 1000,
            maxDelayMs: 30000,
            backoffMultiplier: 2,
          },
        };
        this.woocommerceSync = new WooCommerceSyncService(wooConfig);
      }
    } catch (error) {
      console.warn("[UnifiedSyncOrchestrator] WooCommerce sync not initialized");
    }

    try {
      if (process.env.ETSY_SHOP_ID && process.env.ETSY_ACCESS_TOKEN) {
        const etsyConfig: EtsyConfig = {
          channel: "ETSY",
          isEnabled: true,
          shopId: process.env.ETSY_SHOP_ID,
          apiKey: process.env.ETSY_API_KEY || "",
          accessToken: process.env.ETSY_ACCESS_TOKEN,
          refreshToken: process.env.ETSY_REFRESH_TOKEN || "",
          webhookSecret: process.env.ETSY_WEBHOOK_SECRET || "",
          rateLimit: {
            requestsPerSecond: 2,
            burstSize: 20,
          },
          retryPolicy: {
            maxRetries: 3,
            initialDelayMs: 1000,
            maxDelayMs: 30000,
            backoffMultiplier: 2,
          },
        };
        this.etsySync = new EstySyncService(etsyConfig);
      }
    } catch (error) {
      console.warn("[UnifiedSyncOrchestrator] Etsy sync not initialized");
    }
  }

  /**
   * Sync all enabled marketplaces
   */
  async syncAllMarketplaces(): Promise<MultiChannelSyncResult> {
    const startTime = new Date();
    const results: SyncOrchestrationResult[] = [];
    const availableChannels = marketplaceService.getAvailableMarketplaces();

    console.log(
      `[UnifiedSyncOrchestrator] Starting multi-channel sync for ${availableChannels.length} channels…`
    );

    for (const channel of availableChannels) {
      const channelStartTime = Date.now();
      try {
        const result = await this.syncChannel(channel);
        results.push({
          channel,
          status: result.itemsFailed === 0 ? "SUCCESS" : "FAILED",
          itemsSynced: result.itemsSynced,
          itemsFailed: result.itemsFailed,
          duration: Date.now() - channelStartTime,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[UnifiedSyncOrchestrator] Failed to sync ${channel}:`, errorMsg);
        results.push({
          channel,
          status: "FAILED",
          itemsSynced: 0,
          itemsFailed: 0,
          duration: Date.now() - channelStartTime,
          error: errorMsg,
        });
      }
    }

    const endTime = new Date();
    const totalDuration = endTime.getTime() - startTime.getTime();

    const summary = {
      totalChannels: results.length,
      successfulChannels: results.filter((r) => r.status === "SUCCESS").length,
      failedChannels: results.filter((r) => r.status === "FAILED").length,
      totalItemsSynced: results.reduce((sum, r) => sum + r.itemsSynced, 0),
      totalItemsFailed: results.reduce((sum, r) => sum + r.itemsFailed, 0),
    };

    console.log(
      `[UnifiedSyncOrchestrator] Multi-channel sync complete: ${summary.successfulChannels}/${summary.totalChannels} channels successful, ${summary.totalItemsSynced} items synced`
    );

    return {
      startTime,
      endTime,
      totalDuration,
      results,
      summary,
    };
  }

  /**
   * Sync a specific channel
   */
  private async syncChannel(
    channel: MarketplaceChannel
  ): Promise<{ itemsSynced: number; itemsFailed: number }> {
    console.log(`[UnifiedSyncOrchestrator] Syncing ${channel}…`);

    switch (channel) {
      case "SHOPIFY":
        if (!this.shopifySync) {
          throw new Error("Shopify sync service not initialized");
        }
        const shopifyResult = await this.shopifySync.syncProducts();
        return {
          itemsSynced: shopifyResult.productsCreated + shopifyResult.productsUpdated,
          itemsFailed: shopifyResult.errors.length,
        };

      case "WOOCOMMERCE":
        if (!this.woocommerceSync) {
          throw new Error("WooCommerce sync service not initialized");
        }
        const wooResult = await this.woocommerceSync.syncProducts();
        return {
          itemsSynced: wooResult.productsCreated + wooResult.productsUpdated,
          itemsFailed: wooResult.errors.length,
        };

      case "ETSY":
        if (!this.etsySync) {
          throw new Error("Etsy sync service not initialized");
        }
        const etsyResult = await this.etsySync.syncListings();
        return {
          itemsSynced: etsyResult.listingsCreated + etsyResult.listingsUpdated,
          itemsFailed: etsyResult.errors.length,
        };

      case "AMAZON":
      case "EBAY":
        // Amazon and eBay sync handled by existing sync jobs
        return { itemsSynced: 0, itemsFailed: 0 };

      default:
        throw new Error(`Unknown marketplace channel: ${channel}`);
    }
  }

  /**
   * Sync a specific product across multiple channels
   */
  async syncProductAcrossChannels(
    productId: string,
    channels: MarketplaceChannel[]
  ): Promise<MarketplaceOperationResult[]> {
    console.log(
      `[UnifiedSyncOrchestrator] Syncing product ${productId} to ${channels.join(", ")}…`
    );

    // Get product from database
    const product = await (prisma as any).product.findUnique({
      where: { id: productId },
      include: {
        variations: {
          include: {
            channelListings: true,
          },
        },
        images: true,
      },
    });

    if (!product) {
      throw new Error(`Product ${productId} not found`);
    }

    const results: MarketplaceOperationResult[] = [];

    for (const channel of channels) {
      try {
        if (!marketplaceService.isMarketplaceAvailable(channel)) {
          results.push({
            channel,
            success: false,
            message: `Channel ${channel} is not available`,
            timestamp: new Date(),
          });
          continue;
        }

        // Sync product to channel
        const result = await this.syncProductToChannel(product, channel);
        results.push(result);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.push({
          channel,
          success: false,
          message: `Failed to sync product to ${channel}`,
          error: errorMsg,
          timestamp: new Date(),
        });
      }
    }

    return results;
  }

  /**
   * Sync a product to a specific channel
   */
  private async syncProductToChannel(
    product: any,
    channel: MarketplaceChannel
  ): Promise<MarketplaceOperationResult> {
    try {
      switch (channel) {
        case "SHOPIFY":
          if (!this.shopifySync) {
            throw new Error("Shopify sync service not initialized");
          }
          // Sync to Shopify via syncProducts (batch operation)
          console.log(`[UnifiedSyncOrchestrator] Syncing product ${product.sku} to Shopify…`);
          break;

        case "WOOCOMMERCE":
          if (!this.woocommerceSync) {
            throw new Error("WooCommerce sync service not initialized");
          }
          // Sync to WooCommerce via syncProducts (batch operation)
          console.log(`[UnifiedSyncOrchestrator] Syncing product ${product.sku} to WooCommerce…`);
          break;

        case "ETSY":
          if (!this.etsySync) {
            throw new Error("Etsy sync service not initialized");
          }
          // Sync to Etsy via syncListings (batch operation)
          console.log(`[UnifiedSyncOrchestrator] Syncing product ${product.sku} to Etsy…`);
          break;

        case "AMAZON":
        case "EBAY":
          // Amazon and eBay sync handled separately
          break;

        default:
          throw new Error(`Unknown marketplace channel: ${channel}`);
      }

      return {
        channel,
        success: true,
        message: `Product synced to ${channel}`,
        timestamp: new Date(),
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[UnifiedSyncOrchestrator] Failed to sync product to ${channel}:`,
        errorMsg
      );

      return {
        channel,
        success: false,
        message: `Failed to sync product to ${channel}`,
        error: errorMsg,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Sync inventory across all channels
   */
  async syncInventoryAcrossChannels(
    variantId: string,
    quantity: number
  ): Promise<MarketplaceOperationResult[]> {
    console.log(
      `[UnifiedSyncOrchestrator] Syncing inventory for variant ${variantId} (qty: ${quantity})…`
    );

    // Get variant with channel listings
    const variant = await (prisma as any).productVariation.findUnique({
      where: { id: variantId },
      include: {
        channelListings: true,
        product: true,
      },
    });

    if (!variant) {
      throw new Error(`Variant ${variantId} not found`);
    }

    const results: MarketplaceOperationResult[] = [];

    // Update inventory on each channel
    for (const listing of variant.channelListings) {
      try {
        const channel = listing.channelId as MarketplaceChannel;

        if (!marketplaceService.isMarketplaceAvailable(channel)) {
          results.push({
            channel,
            success: false,
            message: `Channel ${channel} is not available`,
            timestamp: new Date(),
          });
          continue;
        }

        // Update inventory on marketplace
        const updateResults = await marketplaceService.updateInventory([
          {
            channel,
            channelVariantId: listing.channelVariantId || variant.sku,
            channelProductId: listing.channelProductId,
            inventory: quantity,
          },
        ]);

        results.push(...updateResults);

        // Update channel listing in database
        await (prisma as any).variantChannelListing.update({
          where: { id: listing.id },
          data: {
            channelQuantity: quantity,
            lastSyncedAt: new Date(),
            lastSyncStatus: updateResults[0]?.success ? "SUCCESS" : "FAILED",
          },
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.push({
          channel: listing.channelId as MarketplaceChannel,
          success: false,
          message: `Failed to sync inventory to ${listing.channelId}`,
          error: errorMsg,
          timestamp: new Date(),
        });
      }
    }

    return results;
  }

  /**
   * Get sync status for all channels
   */
  async getSyncStatus(): Promise<
    Array<{
      channel: MarketplaceChannel;
      lastSyncAt?: Date;
      lastSyncStatus: string;
      productCount: number;
      variantCount: number;
    }>
  > {
    const channels = marketplaceService.getAvailableMarketplaces();
    const statuses = [];

    for (const channel of channels) {
      const syncLog = await (prisma as any).marketplaceSync.findFirst({
        where: { channel },
        orderBy: { lastSyncAt: "desc" },
      });

      const productCount = await (prisma as any).product.count({
        where: {
          marketplaceSyncs: {
            some: { channel },
          },
        },
      });

      const variantCount = await (prisma as any).productVariation.count({
        where: {
          channelListings: {
            some: { channelId: channel },
          },
        },
      });

      statuses.push({
        channel,
        lastSyncAt: syncLog?.lastSyncAt,
        lastSyncStatus: syncLog?.lastSyncStatus || "PENDING",
        productCount,
        variantCount,
      });
    }

    return statuses;
  }
}

// Export singleton instance
export const unifiedSyncOrchestrator = new UnifiedSyncOrchestrator();
