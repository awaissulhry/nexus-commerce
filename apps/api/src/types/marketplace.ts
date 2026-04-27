/**
 * Marketplace Integration Types
 * Defines types for Shopify, WooCommerce, and Etsy integrations
 */

// ── Marketplace Channels ───────────────────────────────────────────

export type MarketplaceChannel = "AMAZON" | "EBAY" | "SHOPIFY" | "WOOCOMMERCE" | "ETSY";

export interface MarketplaceConfig {
  channel: MarketplaceChannel;
  isEnabled: boolean;
  rateLimit: {
    requestsPerSecond: number;
    burstSize: number;
  };
  retryPolicy: {
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
  };
  webhookSecret?: string;
}

// ── Shopify Types ──────────────────────────────────────────────────

export interface ShopifyConfig extends MarketplaceConfig {
  channel: "SHOPIFY";
  shopName: string;
  accessToken: string;
  apiVersion: string;
  webhookSecret: string;
}

export interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  vendor?: string;
  productType?: string;
  variants: ShopifyVariant[];
  images?: ShopifyImage[];
}

export interface ShopifyVariant {
  id: string;
  productId: string;
  title: string;
  sku: string;
  price: string;
  inventoryQuantity: number;
  inventoryItemId?: string;
}

export interface ShopifyImage {
  id: string;
  src: string;
  alt?: string;
}

export interface ShopifyWebhookPayload {
  id: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

// ── WooCommerce Types ──────────────────────────────────────────────

export interface WooCommerceConfig extends MarketplaceConfig {
  channel: "WOOCOMMERCE";
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  apiVersion: string;
  webhookSecret: string;
}

export interface WooCommerceProduct {
  id: number;
  name: string;
  slug: string;
  type: "simple" | "variable" | "variation";
  variations?: number[];
  attributes?: WooCommerceAttribute[];
}

export interface WooCommerceVariation {
  id: number;
  productId: number;
  sku: string;
  price: string;
  stockQuantity: number;
  attributes: WooCommerceVariationAttribute[];
}

export interface WooCommerceAttribute {
  id: number;
  name: string;
  options: string[];
}

export interface WooCommerceVariationAttribute {
  id: number;
  name: string;
  option: string;
}

export interface WooCommerceWebhookPayload {
  id: number;
  created: string;
  modified: string;
  [key: string]: unknown;
}

// ── Etsy Types ─────────────────────────────────────────────────────

export interface EtsyConfig extends MarketplaceConfig {
  channel: "ETSY";
  shopId: string;
  apiKey: string;
  accessToken: string;
  refreshToken: string;
  webhookSecret: string;
}

export interface EtsyListing {
  listingId: string;
  title: string;
  price: number;
  quantity: number;
  variations?: EtsyVariation[];
  inventory?: EtsyInventory[];
}

export interface EtsyVariation {
  propertyId: number;
  propertyName: string;
  values: string[];
}

export interface EtsyInventory {
  sku: string;
  quantity: number;
  propertyValues: EtsyPropertyValue[];
}

export interface EtsyPropertyValue {
  propertyId: number;
  propertyName: string;
  value: string;
}

export interface EtsyWebhookPayload {
  listingId?: string;
  receiptId?: string;
  timestamp: number;
  [key: string]: unknown;
}

// ── Webhook Types ──────────────────────────────────────────────────

export interface WebhookSignatureValidation {
  isValid: boolean;
  error?: string;
}

export interface WebhookEventPayload {
  channel: MarketplaceChannel;
  eventType: string;
  externalId: string;
  payload: unknown;
  signature?: string;
  timestamp: number;
}

export interface ProcessedWebhookEvent {
  id: string;
  channel: MarketplaceChannel;
  eventType: string;
  externalId: string;
  isProcessed: boolean;
  processedAt?: Date;
  error?: string;
}

// ── Error Types ────────────────────────────────────────────────────

export type SyncErrorType =
  | "RATE_LIMIT"
  | "AUTHENTICATION"
  | "VALIDATION"
  | "NETWORK"
  | "TIMEOUT"
  | "CONFLICT"
  | "NOT_FOUND"
  | "UNKNOWN";

export interface SyncErrorContext {
  productId?: string;
  variantId?: string;
  channelId?: string;
  endpoint?: string;
  [key: string]: unknown;
}

export interface MarketplaceSyncError {
  id: string;
  channel: MarketplaceChannel;
  errorType: SyncErrorType;
  errorMessage: string;
  errorStack?: string;
  context?: SyncErrorContext;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: Date;
  resolvedAt?: Date;
}

// ── Rate Limit Types ───────────────────────────────────────────────

export interface RateLimitState {
  channel: MarketplaceChannel;
  endpoint: string;
  requestCount: number;
  resetAt: Date;
  isLimited: boolean;
  retryAfter?: number;
}

export interface RateLimitConfig {
  requestsPerSecond: number;
  burstSize: number;
  windowMs: number;
}

// ── Data Transformation Types ──────────────────────────────────────

export interface VariationTheme {
  theme: string; // e.g., "SIZE_COLOR", "SIZE", "COLOR"
  attributes: string[]; // e.g., ["Size", "Color"]
}

export interface NexusVariantMapping {
  sku: string;
  variationAttributes: Record<string, string>;
  price: number;
  stock: number;
  channelVariantId?: string;
}

export interface NexusProductMapping {
  sku: string;
  name: string;
  variationTheme?: VariationTheme;
  variants: NexusVariantMapping[];
  channelProductId?: string;
}

// ── Credential Types ───────────────────────────────────────────────

export type CredentialType =
  | "ACCESS_TOKEN"
  | "REFRESH_TOKEN"
  | "API_KEY"
  | "API_SECRET"
  | "CONSUMER_KEY"
  | "CONSUMER_SECRET"
  | "WEBHOOK_SECRET";

export interface MarketplaceCredential {
  id: string;
  channel: MarketplaceChannel;
  credentialType: CredentialType;
  encryptedValue: string;
  expiresAt?: Date;
  isActive: boolean;
}

// ── Batch Operation Types ──────────────────────────────────────────

export interface BatchOperationResult<T> {
  successful: T[];
  failed: Array<{
    item: T;
    error: string;
  }>;
  totalProcessed: number;
  totalFailed: number;
}

export interface InventoryUpdate {
  channel: MarketplaceChannel;
  channelVariantId: string;
  quantity: number;
  locationId?: string;
}

export interface PriceUpdate {
  channel: MarketplaceChannel;
  channelVariantId: string;
  price: number;
}
