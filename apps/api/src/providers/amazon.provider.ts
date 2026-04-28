/**
 * Amazon SP-API Provider
 *
 * Implements MarketplaceProvider interface for Amazon Seller Central
 * Uses JSON Listings Feed for modern price/stock updates
 */

import { MarketplaceProvider, MarketplaceProviderResponse, UpdatePriceInput, UpdateStockInput, SyncListingInput } from './types.js';
import { logger } from '../utils/logger.js';

interface AmazonCredentials {
  appId: string;
  appSecret: string;
  refreshToken: string;
  sellingPartnerId: string;
  region: string;
}

interface RateLimitInfo {
  remaining: number;
  resetAt: Date;
}

export class AmazonSPAPIProvider implements MarketplaceProvider {
  private credentials: AmazonCredentials;
  private rateLimitInfo: RateLimitInfo = {
    remaining: 100,
    resetAt: new Date(),
  };

  constructor() {
    this.credentials = {
      appId: process.env.AMAZON_APP_ID || '',
      appSecret: process.env.AMAZON_SECRET || '',
      refreshToken: process.env.AMAZON_REFRESH_TOKEN || '',
      sellingPartnerId: process.env.AMAZON_SELLER_ID || '',
      region: process.env.AMAZON_REGION || 'EU',
    };
  }

  isConfigured(): boolean {
    return !!(
      this.credentials.appId &&
      this.credentials.appSecret &&
      this.credentials.refreshToken &&
      this.credentials.sellingPartnerId
    );
  }

  async getRateLimitStatus(): Promise<{ remaining: number; resetAt: Date }> {
    return this.rateLimitInfo;
  }

  /**
   * Update product price using JSON Listings Feed
   * Modern approach: submits a feed with price updates
   */
  async updatePrice(input: UpdatePriceInput): Promise<MarketplaceProviderResponse> {
    try {
      if (!this.isConfigured()) {
        return {
          success: false,
          message: 'Amazon SP-API not configured',
          error: 'Missing credentials',
        };
      }

      // Check rate limit
      if (this.rateLimitInfo.remaining <= 0) {
        return {
          success: false,
          message: 'Rate limit exceeded',
          error: 'Too many requests',
          retryable: true,
        };
      }

      logger.info(`[Amazon] Updating price for SKU: ${input.sku} to ${input.price}`);

      // In production, this would call the actual Amazon SP-API
      // For now, we simulate the API call
      const feedPayload = this.buildPriceFeed(input);
      
      // Simulate API call with rate limit handling
      await this.simulateAPICall();

      // Decrement rate limit
      this.rateLimitInfo.remaining--;

      return {
        success: true,
        message: `Price updated for SKU ${input.sku}`,
        data: {
          sku: input.sku,
          price: input.price,
          feedId: `amz-feed-${Date.now()}`,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Amazon] Price update failed: ${errorMessage}`);

      return {
        success: false,
        message: 'Failed to update price',
        error: errorMessage,
        retryable: this.isRetryableError(error),
      };
    }
  }

  /**
   * Update product stock using JSON Listings Feed
   */
  async updateStock(input: UpdateStockInput): Promise<MarketplaceProviderResponse> {
    try {
      if (!this.isConfigured()) {
        return {
          success: false,
          message: 'Amazon SP-API not configured',
          error: 'Missing credentials',
        };
      }

      // Check rate limit
      if (this.rateLimitInfo.remaining <= 0) {
        return {
          success: false,
          message: 'Rate limit exceeded',
          error: 'Too many requests',
          retryable: true,
        };
      }

      logger.info(`[Amazon] Updating stock for SKU: ${input.sku} to ${input.quantity}`);

      // Build stock update feed
      const feedPayload = this.buildStockFeed(input);

      // Simulate API call
      await this.simulateAPICall();

      // Decrement rate limit
      this.rateLimitInfo.remaining--;

      return {
        success: true,
        message: `Stock updated for SKU ${input.sku}`,
        data: {
          sku: input.sku,
          quantity: input.quantity,
          feedId: `amz-feed-${Date.now()}`,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Amazon] Stock update failed: ${errorMessage}`);

      return {
        success: false,
        message: 'Failed to update stock',
        error: errorMessage,
        retryable: this.isRetryableError(error),
      };
    }
  }

  /**
   * Sync full listing to Amazon
   */
  async syncListing(input: SyncListingInput): Promise<MarketplaceProviderResponse> {
    try {
      if (!this.isConfigured()) {
        return {
          success: false,
          message: 'Amazon SP-API not configured',
          error: 'Missing credentials',
        };
      }

      // Check rate limit
      if (this.rateLimitInfo.remaining <= 0) {
        return {
          success: false,
          message: 'Rate limit exceeded',
          error: 'Too many requests',
          retryable: true,
        };
      }

      logger.info(`[Amazon] Syncing listing for SKU: ${input.sku}`);

      // Build complete listing feed
      const feedPayload = this.buildListingFeed(input);

      // Simulate API call
      await this.simulateAPICall();

      // Decrement rate limit
      this.rateLimitInfo.remaining--;

      return {
        success: true,
        message: `Listing synced for SKU ${input.sku}`,
        data: {
          sku: input.sku,
          feedId: `amz-feed-${Date.now()}`,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Amazon] Listing sync failed: ${errorMessage}`);

      return {
        success: false,
        message: 'Failed to sync listing',
        error: errorMessage,
        retryable: this.isRetryableError(error),
      };
    }
  }

  /**
   * Build JSON Listings Feed for price update
   * Format: Amazon's JSON Listings Feed specification
   */
  private buildPriceFeed(input: UpdatePriceInput): Record<string, any> {
    return {
      header: {
        sellerId: this.credentials.sellingPartnerId,
        feedType: 'JSON_LISTINGS_FEED',
        feedVersion: '2.0',
      },
      messages: [
        {
          messageId: 1,
          operationType: 'Update',
          productType: 'PRODUCT',
          attributes: {
            sku: input.sku,
            price: {
              currency: input.currency || 'EUR',
              value: input.price,
            },
          },
        },
      ],
    };
  }

  /**
   * Build JSON Listings Feed for stock update
   */
  private buildStockFeed(input: UpdateStockInput): Record<string, any> {
    return {
      header: {
        sellerId: this.credentials.sellingPartnerId,
        feedType: 'JSON_LISTINGS_FEED',
        feedVersion: '2.0',
      },
      messages: [
        {
          messageId: 1,
          operationType: 'Update',
          productType: 'PRODUCT',
          attributes: {
            sku: input.sku,
            fulfillmentAvailability: [
              {
                fulfillmentChannelCode: 'DEFAULT',
                quantity: input.quantity,
              },
            ],
          },
        },
      ],
    };
  }

  /**
   * Build complete JSON Listings Feed
   */
  private buildListingFeed(input: SyncListingInput): Record<string, any> {
    return {
      header: {
        sellerId: this.credentials.sellingPartnerId,
        feedType: 'JSON_LISTINGS_FEED',
        feedVersion: '2.0',
      },
      messages: [
        {
          messageId: 1,
          operationType: 'Update',
          productType: 'PRODUCT',
          attributes: {
            sku: input.sku,
            title: input.title,
            description: input.description,
            price: {
              currency: 'EUR',
              value: input.price,
            },
            fulfillmentAvailability: [
              {
                fulfillmentChannelCode: 'DEFAULT',
                quantity: input.quantity,
              },
            ],
            images: input.imageUrls?.map((url, idx) => ({
              imageUrl: url,
              imageType: idx === 0 ? 'MAIN' : 'ALTERNATE',
            })) || [],
            ...input.attributes,
          },
        },
      ],
    };
  }

  /**
   * Determine if error is retryable (429, 503, etc.)
   */
  private isRetryableError(error: any): boolean {
    if (error?.response?.status) {
      const status = error.response.status;
      return status === 429 || status === 503 || status === 504;
    }
    return false;
  }

  /**
   * Simulate API call with delay
   */
  private async simulateAPICall(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
}

// Export singleton instance
export const amazonProvider = new AmazonSPAPIProvider();
