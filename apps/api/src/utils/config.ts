/**
 * Marketplace Configuration Manager
 * Centralized configuration for all marketplace integrations
 */

import {
  MarketplaceChannel,
  MarketplaceConfig,
  ShopifyConfig,
  WooCommerceConfig,
  EtsyConfig,
} from "../types/marketplace.js";

/**
 * Load and validate marketplace configurations from environment variables
 */
export class ConfigManager {
  private static configs: Map<MarketplaceChannel, MarketplaceConfig> = new Map();

  /**
   * Initialize all marketplace configurations
   */
  static initialize(): void {
    this.loadShopifyConfig();
    this.loadWooCommerceConfig();
    this.loadEtsyConfig();
    this.loadAmazonConfig();
    this.loadEbayConfig();
  }

  /**
   * Load Shopify configuration
   */
  private static loadShopifyConfig(): void {
    const shopName = process.env.SHOPIFY_SHOP_NAME;
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;

    if (shopName && accessToken && webhookSecret) {
      const config: ShopifyConfig = {
        channel: "SHOPIFY",
        isEnabled: true,
        shopName,
        accessToken,
        apiVersion: process.env.SHOPIFY_API_VERSION || "2024-01",
        webhookSecret,
        rateLimit: {
          requestsPerSecond: 2,
          burstSize: 40,
        },
        retryPolicy: {
          maxRetries: 3,
          initialDelayMs: 1000,
          maxDelayMs: 32000,
          backoffMultiplier: 2,
        },
      };

      this.configs.set("SHOPIFY", config);
      console.log("[ConfigManager] ✓ Shopify configuration loaded");
    } else {
      console.warn("[ConfigManager] ⚠ Shopify configuration incomplete (missing env vars)");
    }
  }

  /**
   * Load WooCommerce configuration
   */
  private static loadWooCommerceConfig(): void {
    const storeUrl = process.env.WOOCOMMERCE_STORE_URL;
    const consumerKey = process.env.WOOCOMMERCE_CONSUMER_KEY;
    const consumerSecret = process.env.WOOCOMMERCE_CONSUMER_SECRET;
    const webhookSecret = process.env.WOOCOMMERCE_WEBHOOK_SECRET;

    if (storeUrl && consumerKey && consumerSecret && webhookSecret) {
      const config: WooCommerceConfig = {
        channel: "WOOCOMMERCE",
        isEnabled: true,
        storeUrl,
        consumerKey,
        consumerSecret,
        apiVersion: process.env.WOOCOMMERCE_API_VERSION || "wc/v3",
        webhookSecret,
        rateLimit: {
          requestsPerSecond: 10,
          burstSize: 100,
        },
        retryPolicy: {
          maxRetries: 3,
          initialDelayMs: 1000,
          maxDelayMs: 32000,
          backoffMultiplier: 2,
        },
      };

      this.configs.set("WOOCOMMERCE", config);
      console.log("[ConfigManager] ✓ WooCommerce configuration loaded");
    } else {
      console.warn("[ConfigManager] ⚠ WooCommerce configuration incomplete (missing env vars)");
    }
  }

  /**
   * Load Etsy configuration
   */
  private static loadEtsyConfig(): void {
    const shopId = process.env.ETSY_SHOP_ID;
    const apiKey = process.env.ETSY_API_KEY;
    const accessToken = process.env.ETSY_ACCESS_TOKEN;
    const refreshToken = process.env.ETSY_REFRESH_TOKEN;
    const webhookSecret = process.env.ETSY_WEBHOOK_SECRET;

    if (shopId && apiKey && accessToken && refreshToken && webhookSecret) {
      const config: EtsyConfig = {
        channel: "ETSY",
        isEnabled: true,
        shopId,
        apiKey,
        accessToken,
        refreshToken,
        webhookSecret,
        rateLimit: {
          requestsPerSecond: 10,
          burstSize: 100,
        },
        retryPolicy: {
          maxRetries: 3,
          initialDelayMs: 1000,
          maxDelayMs: 32000,
          backoffMultiplier: 2,
        },
      };

      this.configs.set("ETSY", config);
      console.log("[ConfigManager] ✓ Etsy configuration loaded");
    } else {
      console.warn("[ConfigManager] ⚠ Etsy configuration incomplete (missing env vars)");
    }
  }

  /**
   * Load Amazon configuration
   */
  private static loadAmazonConfig(): void {
    const region = process.env.AMAZON_REGION;
    const sellerId = process.env.AMAZON_SELLER_ID;

    if (region && sellerId) {
      const config: MarketplaceConfig = {
        channel: "AMAZON",
        isEnabled: true,
        rateLimit: {
          requestsPerSecond: 2,
          burstSize: 40,
        },
        retryPolicy: {
          maxRetries: 3,
          initialDelayMs: 1000,
          maxDelayMs: 32000,
          backoffMultiplier: 2,
        },
      };

      this.configs.set("AMAZON", config);
      console.log("[ConfigManager] ✓ Amazon configuration loaded");
    } else {
      console.warn("[ConfigManager] ⚠ Amazon configuration incomplete (missing env vars)");
    }
  }

  /**
   * Load eBay configuration
   */
  private static loadEbayConfig(): void {
    const clientId = process.env.EBAY_CLIENT_ID;
    const clientSecret = process.env.EBAY_CLIENT_SECRET;

    if (clientId && clientSecret) {
      const config: MarketplaceConfig = {
        channel: "EBAY",
        isEnabled: true,
        rateLimit: {
          requestsPerSecond: 10,
          burstSize: 100,
        },
        retryPolicy: {
          maxRetries: 3,
          initialDelayMs: 1000,
          maxDelayMs: 32000,
          backoffMultiplier: 2,
        },
      };

      this.configs.set("EBAY", config);
      console.log("[ConfigManager] ✓ eBay configuration loaded");
    } else {
      console.warn("[ConfigManager] ⚠ eBay configuration incomplete (missing env vars)");
    }
  }

  /**
   * Get configuration for a specific marketplace
   */
  static getConfig(channel: MarketplaceChannel): MarketplaceConfig | null {
    return this.configs.get(channel) || null;
  }

  /**
   * Get all enabled marketplace configurations
   */
  static getEnabledConfigs(): MarketplaceConfig[] {
    return Array.from(this.configs.values()).filter((c) => c.isEnabled);
  }

  /**
   * Get all enabled marketplace channels
   */
  static getEnabledChannels(): MarketplaceChannel[] {
    return Array.from(this.configs.keys()).filter((channel) => {
      const config = this.configs.get(channel);
      return config?.isEnabled;
    });
  }

  /**
   * Check if a marketplace is enabled
   */
  static isEnabled(channel: MarketplaceChannel): boolean {
    const config = this.configs.get(channel);
    return config?.isEnabled || false;
  }

  /**
   * Get retry policy for a marketplace
   */
  static getRetryPolicy(channel: MarketplaceChannel) {
    const config = this.configs.get(channel);
    return config?.retryPolicy || {
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 32000,
      backoffMultiplier: 2,
    };
  }

  /**
   * Get rate limit config for a marketplace
   */
  static getRateLimitConfig(channel: MarketplaceChannel) {
    const config = this.configs.get(channel);
    return config?.rateLimit || {
      requestsPerSecond: 10,
      burstSize: 100,
    };
  }

  /**
   * Clear all configurations
   */
  static clear(): void {
    this.configs.clear();
  }
}

/**
 * Initialize configuration on module load
 */
ConfigManager.initialize();
