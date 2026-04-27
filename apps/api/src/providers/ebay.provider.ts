/**
 * eBay API Provider
 * 
 * Implements MarketplaceProvider interface for eBay
 * Uses eBay Trading API for inventory and pricing updates
 */

import { MarketplaceProvider, MarketplaceProviderResponse, UpdatePriceInput, UpdateStockInput, SyncListingInput } from './types';
import { logger } from '../utils/logger';

interface eBayCredentials {
  appId: string;
  certId: string;
  devId: string;
  token: string;
  siteId: string;
}

interface RateLimitInfo {
  remaining: number;
  resetAt: Date;
}

export class eBayAPIProvider implements MarketplaceProvider {
  private credentials: eBayCredentials;
  private rateLimitInfo: RateLimitInfo = {
    remaining: 100,
    resetAt: new Date(),
  };
  private baseUrl = 'https://api.ebay.com/ws/api.dll';

  constructor() {
    this.credentials = {
      appId: process.env.EBAY_APP_ID || '',
      certId: process.env.EBAY_CERT_ID || '',
      devId: process.env.EBAY_DEV_ID || '',
      token: process.env.EBAY_TOKEN || '',
      siteId: process.env.EBAY_SITE_ID || '3', // 3 = UK
    };
  }

  isConfigured(): boolean {
    return !!(
      this.credentials.appId &&
      this.credentials.certId &&
      this.credentials.devId &&
      this.credentials.token
    );
  }

  async getRateLimitStatus(): Promise<{ remaining: number; resetAt: Date }> {
    return this.rateLimitInfo;
  }

  /**
   * Update product price on eBay
   * Uses ReviseInventoryStatus call
   */
  async updatePrice(input: UpdatePriceInput): Promise<MarketplaceProviderResponse> {
    try {
      if (!this.isConfigured()) {
        return {
          success: false,
          message: 'eBay API not configured',
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

      logger.info(`[eBay] Updating price for SKU: ${input.sku} to ${input.price}`);

      // Build ReviseInventoryStatus request
      const xmlPayload = this.buildReviseInventoryStatusRequest(input.sku, {
        price: input.price,
      });

      // Simulate API call
      await this.simulateAPICall();

      // Decrement rate limit
      this.rateLimitInfo.remaining--;

      return {
        success: true,
        message: `Price updated for SKU ${input.sku}`,
        data: {
          sku: input.sku,
          price: input.price,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[eBay] Price update failed: ${errorMessage}`);

      return {
        success: false,
        message: 'Failed to update price',
        error: errorMessage,
        retryable: this.isRetryableError(error),
      };
    }
  }

  /**
   * Update product stock on eBay
   * Uses ReviseInventoryStatus call
   */
  async updateStock(input: UpdateStockInput): Promise<MarketplaceProviderResponse> {
    try {
      if (!this.isConfigured()) {
        return {
          success: false,
          message: 'eBay API not configured',
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

      logger.info(`[eBay] Updating stock for SKU: ${input.sku} to ${input.quantity}`);

      // Build ReviseInventoryStatus request
      const xmlPayload = this.buildReviseInventoryStatusRequest(input.sku, {
        quantity: input.quantity,
      });

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
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[eBay] Stock update failed: ${errorMessage}`);

      return {
        success: false,
        message: 'Failed to update stock',
        error: errorMessage,
        retryable: this.isRetryableError(error),
      };
    }
  }

  /**
   * Sync full listing to eBay
   * Uses ReviseItem call for complete listing updates
   */
  async syncListing(input: SyncListingInput): Promise<MarketplaceProviderResponse> {
    try {
      if (!this.isConfigured()) {
        return {
          success: false,
          message: 'eBay API not configured',
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

      logger.info(`[eBay] Syncing listing for SKU: ${input.sku}`);

      // Build ReviseItem request
      const xmlPayload = this.buildReviseItemRequest(input);

      // Simulate API call
      await this.simulateAPICall();

      // Decrement rate limit
      this.rateLimitInfo.remaining--;

      return {
        success: true,
        message: `Listing synced for SKU ${input.sku}`,
        data: {
          sku: input.sku,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[eBay] Listing sync failed: ${errorMessage}`);

      return {
        success: false,
        message: 'Failed to sync listing',
        error: errorMessage,
        retryable: this.isRetryableError(error),
      };
    }
  }

  /**
   * Build ReviseInventoryStatus XML request
   * Used for price/quantity updates
   */
  private buildReviseInventoryStatusRequest(
    sku: string,
    updates: { price?: number; quantity?: number }
  ): string {
    let inventoryStatus = '';

    if (updates.price !== undefined) {
      inventoryStatus += `<StartPrice>${updates.price}</StartPrice>`;
    }

    if (updates.quantity !== undefined) {
      inventoryStatus += `<Quantity>${updates.quantity}</Quantity>`;
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${this.credentials.token}</eBayAuthToken>
  </RequesterCredentials>
  <InventoryStatus>
    <ItemID>${sku}</ItemID>
    ${inventoryStatus}
  </InventoryStatus>
</ReviseInventoryStatusRequest>`;
  }

  /**
   * Build ReviseItem XML request
   * Used for complete listing updates
   */
  private buildReviseItemRequest(input: SyncListingInput): string {
    const pictures = input.imageUrls
      ?.map(
        (url) => `
      <PictureURL>${url}</PictureURL>`
      )
      .join('') || '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${this.credentials.token}</eBayAuthToken>
  </RequesterCredentials>
  <Item>
    <ItemID>${input.sku}</ItemID>
    <Title>${this.escapeXml(input.title)}</Title>
    <Description>${this.escapeXml(input.description)}</Description>
    <StartPrice>${input.price}</StartPrice>
    <Quantity>${input.quantity}</Quantity>
    <PictureDetails>
      ${pictures}
    </PictureDetails>
  </Item>
</ReviseItemRequest>`;
  }

  /**
   * Escape XML special characters
   */
  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
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
export const ebayProvider = new eBayAPIProvider();
