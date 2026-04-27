# Phase 1: Foundation & Infrastructure
## Marketplace Integration - Shopify, WooCommerce, and Etsy

**Status**: ✅ Complete  
**Date**: 2026-04-23  
**Scope**: Database schema, rate limiting, webhooks, error handling, and configuration

---

## Overview

Phase 1 establishes the foundational infrastructure for integrating Shopify, WooCommerce, and Etsy marketplaces into Nexus Commerce. This phase includes:

1. **Database Schema Extensions** - New tables and fields for marketplace-specific data
2. **Rate Limiting Utilities** - Token bucket algorithm with exponential backoff
3. **Webhook Infrastructure** - Signature validation and event processing
4. **Error Handling Framework** - Comprehensive error classification and retry logic
5. **Configuration Management** - Centralized marketplace configuration
6. **Data Transformation Utilities** - Convert between Nexus and marketplace formats

---

## Database Schema Changes

### New Tables

#### `WebhookEvent`
Tracks incoming webhook events for idempotency and audit purposes.

```sql
CREATE TABLE "WebhookEvent" (
  "id" TEXT PRIMARY KEY,
  "channel" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "signature" TEXT,
  "isProcessed" BOOLEAN DEFAULT false,
  "processedAt" TIMESTAMP,
  "error" TEXT,
  "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Purpose**: Ensures webhook idempotency and provides audit trail  
**Indexes**: `(channel, externalId)` unique, `(isProcessed)`, `(channel)`

#### `MarketplaceCredential`
Securely stores encrypted marketplace API credentials.

```sql
CREATE TABLE "MarketplaceCredential" (
  "id" TEXT PRIMARY KEY,
  "channel" TEXT NOT NULL,
  "credentialType" TEXT NOT NULL,
  "encryptedValue" TEXT NOT NULL,
  "expiresAt" TIMESTAMP,
  "isActive" BOOLEAN DEFAULT true,
  "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Purpose**: Centralized credential management with encryption  
**Indexes**: `(channel, credentialType)` unique, `(channel)`

#### `RateLimitLog`
Tracks API rate limit state for each marketplace endpoint.

```sql
CREATE TABLE "RateLimitLog" (
  "id" TEXT PRIMARY KEY,
  "channel" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "requestCount" INTEGER DEFAULT 0,
  "resetAt" TIMESTAMP NOT NULL,
  "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Purpose**: Monitors rate limit consumption and reset times  
**Indexes**: `(channel, endpoint, resetAt)` unique, `(channel)`, `(resetAt)`

#### `SyncError`
Detailed error tracking for marketplace sync operations.

```sql
CREATE TABLE "SyncError" (
  "id" TEXT PRIMARY KEY,
  "channel" TEXT NOT NULL,
  "errorType" TEXT NOT NULL,
  "errorMessage" TEXT NOT NULL,
  "errorStack" TEXT,
  "context" JSONB,
  "retryCount" INTEGER DEFAULT 0,
  "maxRetries" INTEGER DEFAULT 3,
  "nextRetryAt" TIMESTAMP,
  "resolvedAt" TIMESTAMP,
  "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Purpose**: Comprehensive error logging and retry tracking  
**Indexes**: `(channel)`, `(errorType)`, `(nextRetryAt)`, `(resolvedAt)`

### Extended Tables

#### `Product`
Added marketplace-specific product IDs:
- `shopifyProductId: String?`
- `woocommerceProductId: Int?`

#### `ProductVariation`
Added marketplace-specific variant IDs:
- `shopifyVariantId: String?`
- `woocommerceVariationId: Int?`
- `etsyListingId: String?`
- `etsySku: String?`

#### `VariantChannelListing`
Added sync retry tracking:
- `syncRetryCount: Int @default(0)`
- `lastSyncError: String?`

---

## Core Utilities

### 1. Rate Limiter (`apps/api/src/utils/rate-limiter.ts`)

**Token Bucket Algorithm** with per-marketplace configuration:

```typescript
// Shopify: 2 req/sec, 40 burst
// WooCommerce: 10 req/sec, 100 burst
// Etsy: 10 req/sec, 100 burst
```

**Key Classes**:
- `RateLimiter` - Token bucket implementation
- `ExponentialBackoff` - Backoff calculator with jitter
- `retryWithBackoff()` - Retry helper function

**Usage**:
```typescript
import { rateLimiter } from "./utils/rate-limiter.js";

// Check if request can be made
if (rateLimiter.canMakeRequest("SHOPIFY")) {
  // Make request
}

// Consume token and get wait time if rate limited
const waitMs = await rateLimiter.consumeToken("SHOPIFY", "/products");
if (waitMs > 0) {
  await new Promise(r => setTimeout(r, waitMs));
}

// Get current state
const state = rateLimiter.getState("SHOPIFY");
console.log(`Rate limited: ${state.isLimited}, Retry after: ${state.retryAfter}ms`);
```

### 2. Webhook Infrastructure (`apps/api/src/utils/webhook.ts`)

**Signature Validation** for all marketplaces:

```typescript
// Shopify: HMAC-SHA256 (base64)
// WooCommerce: HMAC-SHA256 (base64)
// Etsy: HMAC-SHA256 (hex)
```

**Key Classes**:
- `WebhookValidator` - Signature validation
- `WebhookProcessor` - Event extraction and idempotency
- `WebhookSignatureGenerator` - Generate signatures for testing

**Usage**:
```typescript
import { WebhookValidator, WebhookProcessor } from "./utils/webhook.js";

// Validate webhook signature
const validation = WebhookValidator.validateSignature(
  "SHOPIFY",
  body,
  hmacHeader,
  secret
);

if (!validation.isValid) {
  throw new Error(validation.error);
}

// Check if webhook already processed
const isProcessed = await WebhookProcessor.isWebhookProcessed(
  "SHOPIFY",
  externalId,
  db
);

if (!isProcessed) {
  // Process webhook
  await processWebhook(payload);
  
  // Mark as processed
  await WebhookProcessor.markWebhookProcessed(
    "SHOPIFY",
    externalId,
    db
  );
}
```

### 3. Error Handling Framework (`apps/api/src/utils/error-handler.ts`)

**Error Classification** and retry logic:

```typescript
// Error Types:
// - RATE_LIMIT: Aggressive retry (5 attempts, 2-60s delay)
// - AUTHENTICATION: No retry
// - VALIDATION: No retry
// - NETWORK: Standard retry (3 attempts, 1-32s delay)
// - TIMEOUT: Standard retry
// - CONFLICT: No retry
// - NOT_FOUND: No retry
// - UNKNOWN: Standard retry
```

**Key Classes**:
- `MarketplaceSyncError` - Custom error class
- `ErrorHandler` - Error classification and handling
- `RetryExecutor` - Retry execution with policies
- `CircuitBreaker` - Circuit breaker pattern
- `ErrorLogger` - Persistent error logging

**Usage**:
```typescript
import { 
  RetryExecutor, 
  DEFAULT_RETRY_POLICIES,
  ErrorHandler 
} from "./utils/error-handler.js";

// Execute with retry
const executor = new RetryExecutor(DEFAULT_RETRY_POLICIES.TRANSIENT);

try {
  const result = await executor.execute(
    async () => {
      // Make API call
      return await shopifyService.getProduct(productId);
    },
    { productId, channelId: "SHOPIFY" },
    (attempt, error, delay) => {
      console.log(`Retry attempt ${attempt} after ${delay}ms: ${error.message}`);
    }
  );
} catch (error) {
  if (error instanceof MarketplaceSyncError) {
    console.error(`[${error.channel}] ${error.errorType}: ${error.message}`);
  }
}

// Log error to database
await ErrorLogger.logError(
  db,
  "SHOPIFY",
  "NETWORK",
  "Connection timeout",
  { productId: "123" }
);
```

### 4. Data Transformation (`apps/api/src/utils/data-transformer.ts`)

**Convert between Nexus and marketplace formats**:

```typescript
// Shopify → Nexus
const nexusProduct = ShopifyTransformer.toNexusProduct(shopifyProduct);

// WooCommerce → Nexus
const nexusProduct = WooCommerceTransformer.toNexusProduct(
  wooProduct,
  variations
);

// Etsy → Nexus
const nexusProduct = EtsyTransformer.toNexusProduct(etsyListing);

// Inventory transformations
const shopifyUpdate = InventoryTransformer.toShopifyInventoryUpdate(50, 75);
const wooUpdate = InventoryTransformer.toWooCommerceInventoryUpdate(75);
const etsyUpdate = InventoryTransformer.toEtsyInventoryUpdate(75);
```

**Key Classes**:
- `VariationThemeDetector` - Detect variation themes from marketplace data
- `ShopifyTransformer` - Shopify ↔ Nexus transformation
- `WooCommerceTransformer` - WooCommerce ↔ Nexus transformation
- `EtsyTransformer` - Etsy ↔ Nexus transformation
- `InventoryTransformer` - Inventory format conversion
- `PriceTransformer` - Price format conversion
- `SKUUtilities` - SKU manipulation utilities

### 5. Configuration Manager (`apps/api/src/utils/config.ts`)

**Centralized marketplace configuration**:

```typescript
import { ConfigManager } from "./utils/config.js";

// Get configuration for a marketplace
const shopifyConfig = ConfigManager.getConfig("SHOPIFY");

// Get all enabled marketplaces
const enabledChannels = ConfigManager.getEnabledChannels();

// Check if marketplace is enabled
if (ConfigManager.isEnabled("WOOCOMMERCE")) {
  // Use WooCommerce
}

// Get retry policy
const policy = ConfigManager.getRetryPolicy("ETSY");

// Get rate limit config
const rateLimit = ConfigManager.getRateLimitConfig("SHOPIFY");
```

---

## Environment Variables

### Shopify
```env
SHOPIFY_SHOP_NAME=mystore.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxx
SHOPIFY_API_VERSION=2024-01
SHOPIFY_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxx
```

### WooCommerce
```env
WOOCOMMERCE_STORE_URL=https://mystore.com
WOOCOMMERCE_CONSUMER_KEY=ck_xxxxxxxxxxxxx
WOOCOMMERCE_CONSUMER_SECRET=cs_xxxxxxxxxxxxx
WOOCOMMERCE_API_VERSION=wc/v3
WOOCOMMERCE_WEBHOOK_SECRET=wc_webhook_secret_xxxxxxxxxxxxx
```

### Etsy
```env
ETSY_SHOP_ID=123456789
ETSY_API_KEY=xxxxxxxxxxxxx
ETSY_ACCESS_TOKEN=xxxxxxxxxxxxx
ETSY_REFRESH_TOKEN=xxxxxxxxxxxxx
ETSY_WEBHOOK_SECRET=etsy_webhook_secret_xxxxxxxxxxxxx
```

---

## Type Definitions

All marketplace types are defined in `apps/api/src/types/marketplace.ts`:

- `MarketplaceChannel` - Union type of all channels
- `MarketplaceConfig` - Base configuration interface
- `ShopifyConfig`, `WooCommerceConfig`, `EtsyConfig` - Channel-specific configs
- `WebhookEventPayload` - Webhook event structure
- `SyncErrorType` - Error classification
- `NexusProductMapping` - Nexus product format
- `VariationTheme` - Variation theme structure
- And many more...

---

## Migration Instructions

### 1. Apply Database Migration

```bash
cd packages/database
npx prisma migrate deploy
```

### 2. Update Environment Variables

Copy `.env.example` to `.env` and fill in marketplace credentials:

```bash
cp apps/api/.env.example apps/api/.env
# Edit .env with your marketplace credentials
```

### 3. Verify Build

```bash
cd apps/api
npm run build
```

---

## Testing

### Unit Tests (Phase 6)

- Rate limiter token bucket algorithm
- Webhook signature validation
- Error classification
- Data transformation
- SKU utilities

### Integration Tests (Phase 6)

- End-to-end webhook processing
- Rate limit enforcement
- Error retry logic
- Configuration loading

---

## Next Steps

### Phase 2: Shopify Integration (Week 3-4)
- Enhanced Shopify service with parent-child support
- Shopify sync service
- Shopify API routes and webhooks

### Phase 3: WooCommerce Integration (Week 5-6)
- WooCommerce service implementation
- WooCommerce sync service
- WooCommerce API routes and webhooks

### Phase 4: Etsy Integration (Week 7-8)
- Etsy service implementation
- Etsy sync service
- Etsy API routes and webhooks

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Marketplace APIs                          │
│  (Shopify, WooCommerce, Etsy, Amazon, eBay)                │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│              Webhook Infrastructure                          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ WebhookValidator (Signature Validation)             │  │
│  │ WebhookProcessor (Event Extraction & Idempotency)   │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│              Error Handling & Retry Logic                    │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ ErrorHandler (Classification)                        │  │
│  │ RetryExecutor (Retry with Policies)                 │  │
│  │ CircuitBreaker (Failure Detection)                  │  │
│  │ ErrorLogger (Persistent Logging)                    │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│              Rate Limiting & Backoff                         │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ RateLimiter (Token Bucket)                           │  │
│  │ ExponentialBackoff (Backoff Calculator)             │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│              Data Transformation                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ ShopifyTransformer                                   │  │
│  │ WooCommerceTransformer                               │  │
│  │ EtsyTransformer                                      │  │
│  │ InventoryTransformer                                 │  │
│  │ PriceTransformer                                     │  │
│  │ SKUUtilities                                         │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│              Nexus Commerce Database                         │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Product, ProductVariation, VariantChannelListing    │  │
│  │ WebhookEvent, MarketplaceCredential                 │  │
│  │ RateLimitLog, SyncError                             │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Files Created/Modified

### New Files
- `apps/api/src/types/marketplace.ts` - Type definitions
- `apps/api/src/utils/rate-limiter.ts` - Rate limiting
- `apps/api/src/utils/webhook.ts` - Webhook infrastructure
- `apps/api/src/utils/error-handler.ts` - Error handling
- `apps/api/src/utils/data-transformer.ts` - Data transformation
- `apps/api/src/utils/config.ts` - Configuration management
- `apps/api/.env.example` - Environment variables template
- `packages/database/prisma/migrations/20260423_add_marketplace_integration_phase1/migration.sql` - Database migration

### Modified Files
- `packages/database/prisma/schema.prisma` - Added new models and fields
- `apps/api/src/services/marketplaces/marketplace.service.ts` - Updated to support new channels

---

## Success Criteria

✅ Database schema extended with marketplace-specific fields  
✅ Rate limiting utility implemented with exponential backoff  
✅ Webhook infrastructure with signature validation  
✅ Error handling framework with retry logic  
✅ Marketplace configuration types defined  
✅ Environment variables configured  
✅ Data transformation utilities created  
✅ Build passes without errors  

---

**Status**: Phase 1 Foundation & Infrastructure Complete ✅
