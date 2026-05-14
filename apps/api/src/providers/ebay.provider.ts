/**
 * eBay API Provider
 * 
 * Implements MarketplaceProvider interface for eBay
 * Uses eBay Trading API for inventory and pricing updates
 */

import { MarketplaceProvider, MarketplaceProviderResponse, UpdatePriceInput, UpdateStockInput, SyncListingInput } from './types.js';
import { logger } from '../utils/logger.js';

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

      // T.1 — real Trading API call when credentials + opt-in env are
      // both set. Otherwise honour the legacy simulate path locally
      // but FAIL LOUD in production so silent overselling can't
      // happen. See callTradingApi for the full discipline.
      await this.callTradingApi('ReviseInventoryStatus', xmlPayload);

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

      // T.1 — real Trading API call when credentials + opt-in env are
      // both set. Otherwise honour the legacy simulate path locally
      // but FAIL LOUD in production so silent overselling can't
      // happen. See callTradingApi for the full discipline.
      await this.callTradingApi('ReviseInventoryStatus', xmlPayload);

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

      await this.callTradingApi('ReviseItem', xmlPayload);

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
   * IM.9 — Revise only the images on an eBay listing.
   * Sends PictureDetails (gallery) and optionally VariationSpecificPictureSet
   * (colour sets). All other listing fields are left untouched.
   */
  async reviseItemImages(input: {
    itemId: string
    galleryUrls: string[]
    colorSets?: Array<{ axisName: string; value: string; urls: string[] }>
  }): Promise<{ success: boolean; error?: string }> {
    const pictures = input.galleryUrls
      .map((url) => `    <PictureURL>${this.escapeXml(url)}</PictureURL>`)
      .join('\n')

    const variationPictureSets = (input.colorSets ?? [])
      .filter((cs) => cs.urls.length > 0)
      .map((cs) => {
        const pics = cs.urls
          .map((u) => `      <PictureURL>${this.escapeXml(u)}</PictureURL>`)
          .join('\n')
        return `    <VariationSpecificPictureSet>
      <VariationSpecificName>${this.escapeXml(cs.axisName)}</VariationSpecificName>
      <VariationSpecificValue>${this.escapeXml(cs.value)}</VariationSpecificValue>
${pics}
    </VariationSpecificPictureSet>`
      })
      .join('\n')

    const variationsBlock = variationPictureSets
      ? `  <Variations>\n${variationPictureSets}\n  </Variations>`
      : ''

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${this.credentials.token}</eBayAuthToken>
  </RequesterCredentials>
  <Item>
    <ItemID>${this.escapeXml(input.itemId)}</ItemID>
    <PictureDetails>
${pictures}
    </PictureDetails>
${variationsBlock}
  </Item>
</ReviseItemRequest>`

    try {
      await this.callTradingApi('ReviseItem', xml)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
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
   * T.1 — eBay Trading API call discipline.
   *
   * Three modes by env:
   *   1. NEXUS_EBAY_REAL_API=true + credentials present
   *      → real HTTPS POST to api.ebay.com (or sandbox.ebay.com when
   *        EBAY_SANDBOX=true). Parses Ack/Errors from response;
   *        throws on Failure so the OutboundSyncQueue lands FAILED
   *        instead of silently COMPLETED.
   *   2. NODE_ENV !== 'production' (and not real-API mode)
   *      → simulated 100ms delay, succeeds. Local dev / CI.
   *   3. NODE_ENV === 'production' (and not real-API mode)
   *      → THROW. Silent fake-success in prod is the overselling
   *        bug we're closing. The OutboundSyncQueue will mark the
   *        row FAILED, which surfaces to operator dashboards.
   *
   * The opt-in (NEXUS_EBAY_REAL_API) lets ops cut over deliberately
   * once a sandbox-credential test has succeeded. Until then,
   * production-mode rows are loud-fail rather than silent-success.
   */
  private async callTradingApi(callName: string, xmlPayload: string): Promise<void> {
    const realApiOptIn = process.env.NEXUS_EBAY_REAL_API === 'true';
    const isProduction = process.env.NODE_ENV === 'production';

    if (realApiOptIn && this.isConfigured()) {
      const sandbox = process.env.EBAY_SANDBOX === 'true';
      const endpoint = sandbox
        ? 'https://api.sandbox.ebay.com/ws/api.dll'
        : this.baseUrl;
      const compatLevel = process.env.EBAY_COMPAT_LEVEL || '1193';

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'X-EBAY-API-CALL-NAME': callName,
          'X-EBAY-API-COMPATIBILITY-LEVEL': compatLevel,
          'X-EBAY-API-DEV-NAME': this.credentials.devId,
          'X-EBAY-API-APP-NAME': this.credentials.appId,
          'X-EBAY-API-CERT-NAME': this.credentials.certId,
          'X-EBAY-API-SITEID': this.credentials.siteId,
          'Content-Type': 'text/xml',
        },
        body: xmlPayload,
      });

      if (!res.ok) {
        throw new Error(`eBay ${callName} HTTP ${res.status}`);
      }
      const body = await res.text();
      // Lightweight Ack inspection — eBay returns <Ack>Success|Warning|Failure</Ack>.
      // Full XML parse deferred until we wire response-typed error
      // codes; today we just need to surface Failure as a thrown
      // error so the queue marks FAILED.
      const ackMatch = body.match(/<Ack>([^<]+)<\/Ack>/);
      const ack = ackMatch?.[1];
      if (ack === 'Failure') {
        const errMatch = body.match(/<ShortMessage>([^<]+)<\/ShortMessage>/);
        throw new Error(`eBay ${callName} Failure: ${errMatch?.[1] ?? 'unknown'}`);
      }
      return;
    }

    if (isProduction) {
      // The bug we're closing: silent fake-success in prod. Throw so
      // the queue marks FAILED and the operator sees the gap.
      throw new Error(
        `eBay ${callName} not invoked: NEXUS_EBAY_REAL_API not enabled in production. ` +
        `Refusing to fake-success — would cause overselling. Set the env or migrate adapter.`,
      );
    }

    // Dev / CI fall-through: simulate.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

// Export singleton instance
export const ebayProvider = new eBayAPIProvider();
