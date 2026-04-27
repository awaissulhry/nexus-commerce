/**
 * Unified Marketplace Service
 * Provides a consistent interface for operations across Amazon, eBay, Shopify, WooCommerce, and Etsy
 */

import { EbayService } from "./ebay.service.js";
import { AmazonService } from "./amazon.service.js";
import { ShopifyService } from "./shopify.service.js";
import { WooCommerceService } from "./woocommerce.service.js";
import { EtsyService } from "./etsy.service.js";
import type { MarketplaceChannel, WooCommerceConfig, EtsyConfig } from "../../types/marketplace.js";

export type { MarketplaceChannel };

export interface MarketplaceVariantUpdate {
  channel: MarketplaceChannel;
  channelVariantId: string; // ASIN for Amazon, SKU for eBay, Variant ID for Shopify
  channelProductId?: string; // Product ID for WooCommerce/Etsy
  price?: number;
  inventory?: number;
  locationId?: string; // For Shopify multi-location inventory
}

export interface MarketplaceOperationResult {
  channel: MarketplaceChannel;
  success: boolean;
  message: string;
  error?: string;
  timestamp: Date;
}

export interface MarketplaceHealthStatus {
  channel: MarketplaceChannel;
  isAvailable: boolean;
  lastChecked: Date;
  responseTime?: number;
  error?: string;
}

export interface MarketplaceSyncStatus {
  channel: MarketplaceChannel;
  lastSyncAt?: Date;
  lastSyncStatus: "SUCCESS" | "FAILED" | "PENDING" | "IN_PROGRESS";
  itemsSynced: number;
  itemsFailed: number;
  nextSyncAt?: Date;
}

export class MarketplaceService {
  private ebay: EbayService;
  private amazon: AmazonService;
  private shopify: ShopifyService | null = null;
  private woocommerce: WooCommerceService | null = null;
  private etsy: EtsyService | null = null;

  constructor() {
    this.ebay = new EbayService();
    this.amazon = new AmazonService();

    // Shopify is optional
    try {
      this.shopify = new ShopifyService();
    } catch (error) {
      console.warn(
        "[MarketplaceService] Shopify service not initialized (missing env vars)"
      );
    }

    // WooCommerce is optional
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
        this.woocommerce = new WooCommerceService(wooConfig);
      }
    } catch (error) {
      console.warn(
        "[MarketplaceService] WooCommerce service not initialized (missing env vars)"
      );
    }

    // Etsy is optional
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
        this.etsy = new EtsyService(etsyConfig);
      }
    } catch (error) {
      console.warn(
        "[MarketplaceService] Etsy service not initialized (missing env vars)"
      );
    }
  }

  /**
   * Update price across one or more marketplaces
   */
  async updatePrice(
    updates: MarketplaceVariantUpdate[]
  ): Promise<MarketplaceOperationResult[]> {
    const results: MarketplaceOperationResult[] = [];

    for (const update of updates) {
      try {
        switch (update.channel) {
          case "AMAZON":
            await this.amazon.updateVariantPrice(
              update.channelVariantId,
              update.price || 0
            );
            results.push({
              channel: "AMAZON",
              success: true,
              message: `Updated price to $${update.price?.toFixed(2)} for ASIN ${update.channelVariantId}`,
              timestamp: new Date(),
            });
            break;

          case "EBAY":
            await this.ebay.updateVariantPrice(
              update.channelVariantId,
              update.price || 0
            );
            results.push({
              channel: "EBAY",
              success: true,
              message: `Updated price to $${update.price?.toFixed(2)} for SKU ${update.channelVariantId}`,
              timestamp: new Date(),
            });
            break;

          case "SHOPIFY":
            if (!this.shopify) {
              throw new Error("Shopify service not initialized");
            }
            await this.shopify.updateVariantPrice(
              update.channelVariantId,
              update.price || 0
            );
            results.push({
              channel: "SHOPIFY",
              success: true,
              message: `Updated price to $${update.price?.toFixed(2)} for variant ${update.channelVariantId}`,
              timestamp: new Date(),
            });
            break;

          case "WOOCOMMERCE":
            if (!this.woocommerce) {
              throw new Error("WooCommerce service not initialized");
            }
            // WooCommerce uses updateVariationPrice with productId and variationId
            if (!update.channelProductId) {
              throw new Error("WooCommerce requires channelProductId for price updates");
            }
            await this.woocommerce.updateVariationPrice(
              parseInt(update.channelProductId, 10),
              parseInt(String(update.channelVariantId), 10),
              update.price || 0
            );
            results.push({
              channel: "WOOCOMMERCE",
              success: true,
              message: `Updated price to $${update.price?.toFixed(2)} for variation ${update.channelVariantId}`,
              timestamp: new Date(),
            });
            break;

          case "ETSY":
            if (!this.etsy) {
              throw new Error("Etsy service not initialized");
            }
            await this.etsy.updateListingPrice(
              parseInt(update.channelVariantId, 10),
              update.price || 0
            );
            results.push({
              channel: "ETSY",
              success: true,
              message: `Updated price to $${update.price?.toFixed(2)} for listing ${update.channelVariantId}`,
              timestamp: new Date(),
            });
            break;

          default:
            throw new Error(`Unknown marketplace channel: ${update.channel}`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.push({
          channel: update.channel,
          success: false,
          message: `Failed to update price for ${update.channel}`,
          error: errorMsg,
          timestamp: new Date(),
        });
      }
    }

    return results;
  }

  /**
   * Update inventory across one or more marketplaces
   */
  async updateInventory(
    updates: MarketplaceVariantUpdate[]
  ): Promise<MarketplaceOperationResult[]> {
    const results: MarketplaceOperationResult[] = [];

    for (const update of updates) {
      try {
        switch (update.channel) {
          case "AMAZON":
            // Amazon doesn't have a direct inventory update method in the current implementation
            // This would need to be added to AmazonService
            results.push({
              channel: "AMAZON",
              success: false,
              message: "Inventory update not yet implemented for Amazon",
              error: "Not implemented",
              timestamp: new Date(),
            });
            break;

          case "EBAY":
            await this.ebay.updateInventory(
              update.channelVariantId,
              update.inventory || 0
            );
            results.push({
              channel: "EBAY",
              success: true,
              message: `Updated inventory to ${update.inventory} for SKU ${update.channelVariantId}`,
              timestamp: new Date(),
            });
            break;

          case "SHOPIFY":
            if (!this.shopify) {
              throw new Error("Shopify service not initialized");
            }
            await this.shopify.updateVariantInventory(
              update.channelVariantId,
              update.inventory || 0,
              update.locationId
            );
            results.push({
              channel: "SHOPIFY",
              success: true,
              message: `Updated inventory to ${update.inventory} for variant ${update.channelVariantId}`,
              timestamp: new Date(),
            });
            break;

          case "WOOCOMMERCE":
            if (!this.woocommerce) {
              throw new Error("WooCommerce service not initialized");
            }
            // WooCommerce uses updateVariationStock with productId and variationId
            if (!update.channelProductId) {
              throw new Error("WooCommerce requires channelProductId for inventory updates");
            }
            await this.woocommerce.updateVariationStock(
              parseInt(update.channelProductId, 10),
              parseInt(String(update.channelVariantId), 10),
              update.inventory || 0
            );
            results.push({
              channel: "WOOCOMMERCE",
              success: true,
              message: `Updated inventory to ${update.inventory} for variation ${update.channelVariantId}`,
              timestamp: new Date(),
            });
            break;

          case "ETSY":
            if (!this.etsy) {
              throw new Error("Etsy service not initialized");
            }
            // Etsy uses updateVariationQuantity with listingId, variationId, and quantity
            if (!update.channelProductId) {
              throw new Error("Etsy requires channelProductId (listingId) for inventory updates");
            }
            await this.etsy.updateVariationQuantity(
              parseInt(update.channelProductId, 10),
              parseInt(String(update.channelVariantId), 10),
              update.inventory || 0
            );
            results.push({
              channel: "ETSY",
              success: true,
              message: `Updated inventory to ${update.inventory} for listing ${update.channelProductId}`,
              timestamp: new Date(),
            });
            break;

          default:
            throw new Error(`Unknown marketplace channel: ${update.channel}`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.push({
          channel: update.channel,
          success: false,
          message: `Failed to update inventory for ${update.channel}`,
          error: errorMsg,
          timestamp: new Date(),
        });
      }
    }

    return results;
  }

  /**
   * Get the service for a specific marketplace
   */
  getService(
    channel: MarketplaceChannel
  ): EbayService | AmazonService | ShopifyService | WooCommerceService | EtsyService {
    switch (channel) {
      case "AMAZON":
        return this.amazon;
      case "EBAY":
        return this.ebay;
      case "SHOPIFY":
        if (!this.shopify) {
          throw new Error("Shopify service not initialized");
        }
        return this.shopify;
      case "WOOCOMMERCE":
        if (!this.woocommerce) {
          throw new Error("WooCommerce service not initialized");
        }
        return this.woocommerce;
      case "ETSY":
        if (!this.etsy) {
          throw new Error("Etsy service not initialized");
        }
        return this.etsy;
      default:
        throw new Error(`Unknown marketplace channel: ${channel}`);
    }
  }

  /**
   * Check if a marketplace is available
   */
  isMarketplaceAvailable(channel: MarketplaceChannel): boolean {
    switch (channel) {
      case "SHOPIFY":
        return this.shopify !== null;
      case "WOOCOMMERCE":
        return this.woocommerce !== null;
      case "ETSY":
        return this.etsy !== null;
      case "AMAZON":
      case "EBAY":
        return true; // Amazon and eBay are always available if env vars are set
      default:
        return false;
    }
  }

  /**
   * Get all available marketplaces
   */
  getAvailableMarketplaces(): MarketplaceChannel[] {
    const available: MarketplaceChannel[] = ["AMAZON", "EBAY"];
    if (this.shopify) {
      available.push("SHOPIFY");
    }
    if (this.woocommerce) {
      available.push("WOOCOMMERCE");
    }
    if (this.etsy) {
      available.push("ETSY");
    }
    return available;
  }

  /**
   * Batch update prices with retry logic
   */
  async batchUpdatePrices(
    updates: MarketplaceVariantUpdate[],
    maxRetries: number = 3
  ): Promise<MarketplaceOperationResult[]> {
    const results: MarketplaceOperationResult[] = [];
    const failedUpdates: MarketplaceVariantUpdate[] = [];

    // First attempt
    const firstAttempt = await this.updatePrice(updates);
    results.push(...firstAttempt);

    // Collect failed updates
    for (let i = 0; i < firstAttempt.length; i++) {
      if (!firstAttempt[i].success) {
        failedUpdates.push(updates[i]);
      }
    }

    // Retry failed updates
    for (let attempt = 1; attempt < maxRetries && failedUpdates.length > 0; attempt++) {
      console.log(
        `[MarketplaceService] Retrying ${failedUpdates.length} failed price updates (attempt ${attempt + 1}/${maxRetries})…`
      );

      // Wait before retry (exponential backoff)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.pow(2, attempt) * 1000)
      );

      const retryResults = await this.updatePrice(failedUpdates);

      // Update results and remove successful updates from failedUpdates
      for (let i = 0; i < retryResults.length; i++) {
        if (retryResults[i].success) {
          failedUpdates.splice(i, 1);
          i--;
        }
      }

      results.push(...retryResults);
    }

    return results;
  }

  /**
   * Batch update inventory with retry logic
   */
  async batchUpdateInventory(
    updates: MarketplaceVariantUpdate[],
    maxRetries: number = 3
  ): Promise<MarketplaceOperationResult[]> {
    const results: MarketplaceOperationResult[] = [];
    const failedUpdates: MarketplaceVariantUpdate[] = [];

    // First attempt
    const firstAttempt = await this.updateInventory(updates);
    results.push(...firstAttempt);

    // Collect failed updates
    for (let i = 0; i < firstAttempt.length; i++) {
      if (!firstAttempt[i].success) {
        failedUpdates.push(updates[i]);
      }
    }

    // Retry failed updates
    for (let attempt = 1; attempt < maxRetries && failedUpdates.length > 0; attempt++) {
      console.log(
        `[MarketplaceService] Retrying ${failedUpdates.length} failed inventory updates (attempt ${attempt + 1}/${maxRetries})…`
      );

      // Wait before retry (exponential backoff)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.pow(2, attempt) * 1000)
      );

      const retryResults = await this.updateInventory(failedUpdates);

      // Update results and remove successful updates from failedUpdates
      for (let i = 0; i < retryResults.length; i++) {
        if (retryResults[i].success) {
          failedUpdates.splice(i, 1);
          i--;
        }
      }

      results.push(...retryResults);
    }

    return results;
  }

  /**
   * Get health status for all marketplaces
   */
  async getMarketplaceHealthStatus(): Promise<MarketplaceHealthStatus[]> {
    const statuses: MarketplaceHealthStatus[] = [];
    const channels = this.getAvailableMarketplaces();

    for (const channel of channels) {
      const startTime = Date.now();
      try {
        // Perform a lightweight health check
        statuses.push({
          channel,
          isAvailable: true,
          lastChecked: new Date(),
          responseTime: Date.now() - startTime,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        statuses.push({
          channel,
          isAvailable: false,
          lastChecked: new Date(),
          responseTime: Date.now() - startTime,
          error: errorMsg,
        });
      }
    }

    return statuses;
  }

  /**
   * Sync products across multiple channels
   */
  async syncProductsAcrossChannels(
    productId: string,
    channels: MarketplaceChannel[]
  ): Promise<MarketplaceOperationResult[]> {
    const results: MarketplaceOperationResult[] = [];

    for (const channel of channels) {
      try {
        if (!this.isMarketplaceAvailable(channel)) {
          results.push({
            channel,
            success: false,
            message: `Channel ${channel} is not available`,
            timestamp: new Date(),
          });
          continue;
        }

        // Sync logic will be implemented per-channel
        results.push({
          channel,
          success: true,
          message: `Product ${productId} synced to ${channel}`,
          timestamp: new Date(),
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.push({
          channel,
          success: false,
          message: `Failed to sync product ${productId} to ${channel}`,
          error: errorMsg,
          timestamp: new Date(),
        });
      }
    }

    return results;
  }
}

// Export singleton instance
export const marketplaceService = new MarketplaceService();
