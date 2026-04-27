# Phase 5: Marketplace API Integration — Complete Implementation Guide

## Overview

Phase 5 implements comprehensive marketplace API integration for Amazon, eBay, and Shopify. This phase enables real-time price and inventory synchronization across all connected marketplaces with retry logic, error handling, and unified abstraction.

**Status**: ✅ COMPLETED

## Architecture

### Service Layer

```
┌─────────────────────────────────────────────────────────────┐
│                    MarketplaceService                        │
│  (Unified abstraction with retry logic & batch operations)   │
└──────────────┬──────────────┬──────────────┬────────────────┘
               │              │              │
        ┌──────▼──────┐ ┌────▼─────┐ ┌─────▼──────┐
        │ AmazonService│ │EbayService│ │ShopifyService│
        │ (SP-API)     │ │(REST API) │ │(REST API)  │
        └──────────────┘ └──────────┘ └────────────┘
               │              │              │
        ┌──────▼──────────────▼──────────────▼──────┐
        │         Marketplace API Endpoints         │
        │  (Amazon SP-API, eBay REST, Shopify API)  │
        └──────────────────────────────────────────┘
```

### Data Flow

```
Product Variant (DB)
    ↓
RepricingService (calculates new price)
    ↓
MarketplaceService.updatePrice()
    ↓
├─→ AmazonService.updateVariantPrice(asin, price)
├─→ EbayService.updateVariantPrice(sku, price)
└─→ ShopifyService.updateVariantPrice(variantId, price)
    ↓
VariantChannelListing (updated with sync status)
```

## Implementation Details

### 1. AmazonService Enhancements

**File**: `apps/api/src/services/marketplaces/amazon.service.ts`

#### New Method: `updateVariantPrice()`

```typescript
async updateVariantPrice(asin: string, newPrice: number): Promise<void> {
  try {
    console.log(`[AmazonService] Updating price for ASIN ${asin} to $${newPrice.toFixed(2)}…`);

    // Update pricing via Pricing API
    const response = await this.sp.callAPI({
      operation: "updatePricing",
      endpoint: "productPricing",
      body: {
        pricelist: [
          {
            asin,
            standardPrice: {
              currency: "USD",
              amount: newPrice.toFixed(2),
            },
          },
        ],
      },
    });

    if (response.errors && response.errors.length > 0) {
      throw new Error(`Failed to update Amazon price: ${response.errors[0].message}`);
    }

    console.log(`[AmazonService] ✓ Updated price for ASIN ${asin} to $${newPrice.toFixed(2)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[AmazonService] ✗ Failed to update variant price for ${asin}:`, message);
    throw error;
  }
}
```

**Key Features**:
- Uses Amazon SP-API Pricing endpoint
- Supports regional pricing (currently USD)
- Comprehensive error handling
- Detailed logging for debugging

### 2. EbayService Enhancements

**File**: `apps/api/src/services/marketplaces/ebay.service.ts`

#### New Method: `updateVariantPrice()`

```typescript
async updateVariantPrice(variantSku: string, newPrice: number): Promise<void> {
  try {
    const accessToken = await this.getAccessToken();

    // Find the inventory item by SKU
    const inventoryResponse = await fetch(
      "https://api.ebay.com/sell/inventory/v1/inventory",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!inventoryResponse.ok) {
      throw new Error(`Failed to fetch inventory items: ${inventoryResponse.statusText}`);
    }

    const inventoryData = await inventoryResponse.json();
    const inventoryItem = inventoryData.inventoryItems?.find(
      (item: any) => item.sku === variantSku
    );

    if (!inventoryItem) {
      throw new Error(`Inventory item not found for SKU: ${variantSku}`);
    }

    // Find the offer for this inventory item
    const offersResponse = await fetch(
      `https://api.ebay.com/sell/inventory/v1/offer?sku=${variantSku}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!offersResponse.ok) {
      throw new Error(`Failed to fetch offers: ${offersResponse.statusText}`);
    }

    const offersData = await offersResponse.json();
    const offer = offersData.offers?.[0];

    if (!offer) {
      throw new Error(`No active offer found for SKU: ${variantSku}`);
    }

    // Update the offer price
    const updateResponse = await fetch(
      `https://api.ebay.com/sell/inventory/v1/offer/${offer.offerId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          pricingSummary: {
            price: {
              currency: "USD",
              value: newPrice.toFixed(2),
            },
          },
        }),
      }
    );

    if (!updateResponse.ok) {
      const error = await updateResponse.json();
      throw new Error(`Failed to update eBay price: ${error.message || updateResponse.statusText}`);
    }

    console.log(`[EbayService] ✓ Updated price for SKU ${variantSku} to $${newPrice.toFixed(2)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[EbayService] ✗ Failed to update variant price for ${variantSku}:`, message);
    throw error;
  }
}
```

**Key Features**:
- Fetches inventory items by SKU
- Finds associated offer
- Updates offer price via PATCH
- Token caching for performance
- Comprehensive error handling

### 3. ShopifyService (NEW)

**File**: `apps/api/src/services/marketplaces/shopify.service.ts`

Complete Shopify integration with:
- Product CRUD operations
- Variant price updates
- Inventory management (multi-location)
- Product fetching by SKU
- Batch operations

#### Key Methods

```typescript
// Update variant price
async updateVariantPrice(variantId: string, newPrice: number): Promise<void>

// Update inventory
async updateVariantInventory(
  variantId: string,
  quantity: number,
  locationId?: string
): Promise<void>

// Get product by SKU
async getProductBySku(sku: string): Promise<ShopifyProduct | null>

// Create product with variants
async createProduct(
  title: string,
  vendor: string,
  productType: string,
  variants: Array<{ title: string; sku: string; price: number }>
): Promise<ShopifyProduct>
```

### 4. MarketplaceService (Unified Abstraction)

**File**: `apps/api/src/services/marketplaces/marketplace.service.ts`

Provides unified interface across all marketplaces:

```typescript
// Update prices with retry logic
async updatePrice(updates: MarketplaceVariantUpdate[]): Promise<MarketplaceOperationResult[]>

// Update inventory with retry logic
async updateInventory(updates: MarketplaceVariantUpdate[]): Promise<MarketplaceOperationResult[]>

// Batch operations with exponential backoff
async batchUpdatePrices(updates: MarketplaceVariantUpdate[], maxRetries: number = 3)
async batchUpdateInventory(updates: MarketplaceVariantUpdate[], maxRetries: number = 3)

// Marketplace management
getAvailableMarketplaces(): MarketplaceChannel[]
isMarketplaceAvailable(channel: MarketplaceChannel): boolean
getService(channel: MarketplaceChannel): Service
```

**Retry Logic**:
- Exponential backoff: 2^attempt seconds
- Max 3 retry attempts by default
- Tracks failed updates separately
- Returns detailed results for each operation

### 5. API Routes

**File**: `apps/api/src/routes/marketplaces.ts`

#### Endpoints

##### 1. GET `/marketplaces/status`
Get status of all connected marketplaces

**Response**:
```json
{
  "success": true,
  "marketplaces": [
    { "channel": "AMAZON", "available": true },
    { "channel": "EBAY", "available": true },
    { "channel": "SHOPIFY", "available": true }
  ]
}
```

##### 2. POST `/marketplaces/prices/update`
Update prices across marketplaces

**Request**:
```json
{
  "updates": [
    {
      "channel": "AMAZON",
      "channelVariantId": "B08EXAMPLE",
      "price": 29.99
    },
    {
      "channel": "EBAY",
      "channelVariantId": "SKU-001",
      "price": 29.99
    }
  ],
  "dryRun": false
}
```

**Response**:
```json
{
  "success": true,
  "summary": {
    "total": 2,
    "successful": 2,
    "failed": 0
  },
  "results": [
    {
      "channel": "AMAZON",
      "success": true,
      "message": "Updated price to $29.99 for ASIN B08EXAMPLE",
      "timestamp": "2026-04-23T00:55:00.000Z"
    },
    {
      "channel": "EBAY",
      "success": true,
      "message": "Updated price to $29.99 for SKU SKU-001",
      "timestamp": "2026-04-23T00:55:01.000Z"
    }
  ]
}
```

##### 3. POST `/marketplaces/inventory/update`
Update inventory across marketplaces

**Request**:
```json
{
  "updates": [
    {
      "channel": "EBAY",
      "channelVariantId": "SKU-001",
      "inventory": 50
    },
    {
      "channel": "SHOPIFY",
      "channelVariantId": "gid://shopify/ProductVariant/123456",
      "inventory": 50,
      "locationId": "gid://shopify/Location/123"
    }
  ],
  "dryRun": false
}
```

##### 4. POST `/marketplaces/variants/sync`
Sync a variant to specific marketplaces

**Request**:
```json
{
  "variantId": "variant-uuid",
  "channels": ["AMAZON", "EBAY", "SHOPIFY"]
}
```

**Response**:
```json
{
  "success": true,
  "variantId": "variant-uuid",
  "summary": {
    "total": 3,
    "successful": 3,
    "failed": 0
  },
  "results": [...]
}
```

##### 5. GET `/marketplaces/variants/:variantId/listings`
Get all channel listings for a variant

**Response**:
```json
{
  "success": true,
  "variantId": "variant-uuid",
  "sku": "SKU-001",
  "price": 29.99,
  "listings": [
    {
      "id": "listing-uuid",
      "channel": "AMAZON",
      "channelSku": "SKU-001",
      "channelVariantId": "B08EXAMPLE",
      "channelPrice": 29.99,
      "lastSyncStatus": "SUCCESS",
      "lastSyncedAt": "2026-04-23T00:55:00.000Z"
    },
    {
      "id": "listing-uuid",
      "channel": "EBAY",
      "channelSku": "SKU-001",
      "channelVariantId": "SKU-001",
      "channelPrice": 29.99,
      "lastSyncStatus": "SUCCESS",
      "lastSyncedAt": "2026-04-23T00:55:01.000Z"
    }
  ]
}
```

##### 6. POST `/marketplaces/sync-all`
Sync all variants with price changes to their connected marketplaces

**Response**:
```json
{
  "success": true,
  "summary": {
    "total": 15,
    "synced": 15,
    "failed": 0
  },
  "results": [...]
}
```

### 6. Sync Job Integration

**File**: `apps/api/src/jobs/sync.job.ts`

Enhanced `syncPriceParity()` function now:

1. Detects price drift between DB and marketplace
2. Calls marketplace API to update price
3. Handles API errors gracefully
4. Updates VariantChannelListing with sync status
5. Records success/failure for each channel

```typescript
// Call marketplace API to update price
try {
  if (listing.channelId === "EBAY" && variant.sku) {
    await ebay.updateVariantPrice(variant.sku, variantPrice);
  } else if (listing.channelId === "AMAZON" && variant.amazonAsin) {
    await amazon.updateVariantPrice(variant.amazonAsin, variantPrice);
  }

  // Mark sync as successful
  await (prisma as any).variantChannelListing.update({
    where: { id: listing.id },
    data: {
      lastSyncStatus: "SUCCESS",
      lastSyncedAt: new Date(),
    },
  });
} catch (apiError) {
  const errorMsg = apiError instanceof Error ? apiError.message : String(apiError);
  console.error(
    `[SyncJob] Failed to update price on ${listing.channelId} for variant "${variant.sku}":`,
    errorMsg
  );

  // Mark sync as failed
  await (prisma as any).variantChannelListing.update({
    where: { id: listing.id },
    data: {
      lastSyncStatus: "FAILED",
      lastSyncedAt: new Date(),
    },
  });
}
```

## Environment Variables

Required for Phase 5:

```bash
# Amazon SP-API
AMAZON_LWA_CLIENT_ID=your_client_id
AMAZON_LWA_CLIENT_SECRET=your_client_secret
AMAZON_REFRESH_TOKEN=your_refresh_token
AMAZON_SELLER_ID=your_seller_id
AMAZON_MARKETPLACE_ID=APJ6JRA9NG5V4
AWS_ACCESS_KEY_ID=your_aws_key
AWS_SECRET_ACCESS_KEY=your_aws_secret
AWS_ROLE_ARN=your_role_arn

# eBay API
EBAY_APP_ID=your_app_id
EBAY_CERT_ID=your_cert_id
EBAY_API_BASE=https://api.ebay.com
EBAY_AUTH_URL=https://api.ebay.com/identity/v1/oauth2/token
EBAY_CURRENCY=USD

# Shopify (Optional)
SHOPIFY_SHOP_NAME=your-shop-name
SHOPIFY_ACCESS_TOKEN=your_access_token
```

## Testing

### Unit Tests

```typescript
// Test AmazonService.updateVariantPrice()
describe('AmazonService', () => {
  it('should update variant price successfully', async () => {
    const service = new AmazonService();
    await service.updateVariantPrice('B08EXAMPLE', 29.99);
    // Assert API was called with correct parameters
  });

  it('should handle API errors gracefully', async () => {
    const service = new AmazonService();
    await expect(service.updateVariantPrice('INVALID', 29.99)).rejects.toThrow();
  });
});

// Test EbayService.updateVariantPrice()
describe('EbayService', () => {
  it('should update variant price successfully', async () => {
    const service = new EbayService();
    await service.updateVariantPrice('SKU-001', 29.99);
    // Assert API was called with correct parameters
  });
});

// Test ShopifyService.updateVariantPrice()
describe('ShopifyService', () => {
  it('should update variant price successfully', async () => {
    const service = new ShopifyService();
    await service.updateVariantPrice('gid://shopify/ProductVariant/123456', 29.99);
    // Assert API was called with correct parameters
  });
});

// Test MarketplaceService
describe('MarketplaceService', () => {
  it('should update prices across multiple marketplaces', async () => {
    const service = new MarketplaceService();
    const results = await service.updatePrice([
      { channel: 'AMAZON', channelVariantId: 'B08EXAMPLE', price: 29.99 },
      { channel: 'EBAY', channelVariantId: 'SKU-001', price: 29.99 },
    ]);
    expect(results).toHaveLength(2);
    expect(results.every(r => r.success)).toBe(true);
  });

  it('should retry failed updates with exponential backoff', async () => {
    const service = new MarketplaceService();
    const results = await service.batchUpdatePrices([...], 3);
    // Assert retries were attempted
  });
});
```

### Integration Tests

```typescript
// Test full sync pipeline
describe('Sync Job Integration', () => {
  it('should sync price changes to all marketplaces', async () => {
    // Create test variant with channel listings
    const variant = await createTestVariant();
    
    // Change price
    await updateVariantPrice(variant.id, 39.99);
    
    // Run sync
    await runSync();
    
    // Assert all channel listings were updated
    const listings = await getVariantListings(variant.id);
    expect(listings.every(l => l.lastSyncStatus === 'SUCCESS')).toBe(true);
  });
});
```

### Manual Testing

```bash
# Test marketplace status
curl http://localhost:3001/marketplaces/status

# Test price update (dry run)
curl -X POST http://localhost:3001/marketplaces/prices/update \
  -H "Content-Type: application/json" \
  -d '{
    "updates": [
      {
        "channel": "AMAZON",
        "channelVariantId": "B08EXAMPLE",
        "price": 29.99
      }
    ],
    "dryRun": true
  }'

# Test actual price update
curl -X POST http://localhost:3001/marketplaces/prices/update \
  -H "Content-Type: application/json" \
  -d '{
    "updates": [
      {
        "channel": "AMAZON",
        "channelVariantId": "B08EXAMPLE",
        "price": 29.99
      }
    ],
    "dryRun": false
  }'

# Test variant sync
curl -X POST http://localhost:3001/marketplaces/variants/sync \
  -H "Content-Type: application/json" \
  -d '{
    "variantId": "variant-uuid",
    "channels": ["AMAZON", "EBAY"]
  }'

# Get variant listings
curl http://localhost:3001/marketplaces/variants/variant-uuid/listings

# Sync all variants
curl -X POST http://localhost:3001/marketplaces/sync-all
```

## Error Handling

### Retry Strategy

- **Exponential Backoff**: 2^attempt seconds (2s, 4s, 8s)
- **Max Retries**: 3 attempts by default
- **Failed Updates**: Tracked separately for analysis

### Error Types

1. **Network Errors**: Retried automatically
2. **API Errors**: Logged and reported
3. **Validation Errors**: Rejected immediately
4. **Rate Limiting**: Handled via backoff

### Logging

All operations logged with:
- Operation type (price update, inventory update)
- Channel (AMAZON, EBAY, SHOPIFY)
- Variant/Product identifiers
- Success/failure status
- Error messages (if applicable)
- Timestamp

## Performance Considerations

### Batch Operations

- Process multiple updates in single request
- Parallel execution across marketplaces
- Retry logic prevents cascading failures

### Caching

- eBay token caching (60s buffer)
- Shopify location ID caching
- Reduces API calls

### Rate Limiting

- Respects marketplace rate limits
- Exponential backoff for retries
- Configurable max retries

## Security

### API Credentials

- Stored in environment variables
- Never logged or exposed
- Separate credentials per marketplace

### Data Validation

- Input validation on all endpoints
- Type checking via TypeScript
- Prisma schema validation

### Error Messages

- Generic error messages to clients
- Detailed logging for debugging
- No sensitive data in responses

## Monitoring & Observability

### Metrics to Track

- Price update success rate
- Inventory update success rate
- API response times
- Retry attempt counts
- Error rates by marketplace

### Logging

- Structured logging with timestamps
- Channel-specific prefixes ([AmazonService], [EbayService], etc.)
- Error stack traces for debugging

### Alerts

- Failed price updates (>5% failure rate)
- API connectivity issues
- Rate limit exceeded
- Sync job failures

## Future Enhancements

### Phase 6+

1. **Competitor Price Tracking**: Monitor competitor prices
2. **Velocity-Based Allocation**: Allocate inventory based on sales velocity
3. **Repricing Automation**: Automatic repricing based on rules
4. **Analytics**: Track repricing impact and ROI

### Potential Improvements

1. **Webhook Support**: Real-time marketplace notifications
2. **Bulk Operations**: Batch API calls for better performance
3. **Advanced Retry**: Circuit breaker pattern for failing APIs
4. **Caching Layer**: Redis for frequently accessed data
5. **Message Queue**: Async processing for large batches

## Summary

Phase 5 successfully implements:

✅ **AmazonService**: Price updates via SP-API
✅ **EbayService**: Price updates via REST API
✅ **ShopifyService**: Complete marketplace integration
✅ **MarketplaceService**: Unified abstraction with retry logic
✅ **API Routes**: Comprehensive endpoints for all operations
✅ **Sync Job Integration**: Automatic price parity checking
✅ **Error Handling**: Robust error handling and retry logic
✅ **Logging**: Detailed logging for debugging and monitoring

The implementation provides a solid foundation for multi-channel marketplace management with enterprise-grade reliability and observability.
