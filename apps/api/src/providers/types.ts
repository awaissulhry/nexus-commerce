/**
 * Marketplace Provider Interface
 * 
 * Standard interface for all marketplace integrations (Amazon, eBay, etc.)
 * Provides unified methods for price/stock updates and listing synchronization
 */

export interface UpdatePriceInput {
  sku: string;
  price: number;
  currency?: string;
}

export interface UpdateStockInput {
  sku: string;
  quantity: number;
}

export interface SyncListingInput {
  sku: string;
  title: string;
  description: string;
  price: number;
  quantity: number;
  imageUrls?: string[];
  attributes?: Record<string, any>;
}

export interface MarketplaceProviderResponse {
  success: boolean;
  message: string;
  data?: any;
  error?: string;
  retryable?: boolean; // true if error is temporary (429, 503, etc.)
}

export interface MarketplaceProvider {
  /**
   * Update product price on marketplace
   * @param input Price update details
   * @returns Response with success status
   */
  updatePrice(input: UpdatePriceInput): Promise<MarketplaceProviderResponse>;

  /**
   * Update product stock/inventory on marketplace
   * @param input Stock update details
   * @returns Response with success status
   */
  updateStock(input: UpdateStockInput): Promise<MarketplaceProviderResponse>;

  /**
   * Sync full listing to marketplace
   * @param input Complete listing details
   * @returns Response with success status
   */
  syncListing(input: SyncListingInput): Promise<MarketplaceProviderResponse>;

  /**
   * Get current rate limit status
   * @returns Remaining requests and reset time
   */
  getRateLimitStatus(): Promise<{
    remaining: number;
    resetAt: Date;
  }>;

  /**
   * Check if provider is properly configured
   * @returns true if all required credentials are set
   */
  isConfigured(): boolean;
}
