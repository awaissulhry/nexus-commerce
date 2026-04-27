# Shopify, WooCommerce & Etsy Integration Plan
## Full Rithum Parent-Child Hierarchy Support

**Status**: Planning Phase  
**Last Updated**: 2026-04-23  
**Scope**: Complete marketplace integration with parent-child product sync, inventory management, and order handling

---

## Executive Summary

This document outlines the comprehensive design and implementation strategy for integrating **Shopify**, **WooCommerce**, and **Etsy** marketplaces into the Nexus Commerce platform with full support for the **Rithum parent-child product hierarchy**.

### Key Objectives
- Extend existing marketplace infrastructure (Amazon, eBay) to support 3 new platforms
- Implement parent-child product mapping for each marketplace's native structure
- Enable bidirectional inventory synchronization
- Support order fulfillment workflows
- Maintain data consistency across all channels
- Provide comprehensive API authentication and security

### Architecture Principles
1. **Unified Interface**: All marketplaces use consistent service patterns
2. **Rithum Compliance**: Parent-child hierarchy respected across all platforms
3. **Idempotent Operations**: Safe retry logic for all API calls
4. **Error Resilience**: Comprehensive error handling and recovery
5. **Audit Trail**: Full logging of all marketplace operations

---

## Part 1: Existing Architecture Analysis

### Current Marketplace Services Pattern

#### Service Structure
```
apps/api/src/services/marketplaces/
├── marketplace.service.ts      (Unified interface)
├── amazon.service.ts           (Implemented)
├── ebay.service.ts             (Implemented)
└── shopify.service.ts          (Partial - needs enhancement)
```

#### Unified Marketplace Service Interface
- **Purpose**: Provides consistent API for all marketplace operations
- **Key Methods**:
  - `updatePrice(updates: MarketplaceVariantUpdate[])` — Batch price updates
  - `updateInventory(updates: MarketplaceVariantUpdate[])` — Batch inventory updates
  - `batchUpdatePrices(updates, maxRetries)` — With exponential backoff
  - `batchUpdateInventory(updates, maxRetries)` — With exponential backoff
  - `getService(channel)` — Get specific marketplace service
  - `isMarketplaceAvailable(channel)` — Check marketplace status
  - `getAvailableMarketplaces()` — List all connected channels

#### Existing Service Patterns

**Amazon Service** (`amazon.service.ts`)
- Uses Selling Partner API (SP-API)
- OAuth2 authentication with refresh tokens
- Methods: `fetchActiveCatalog()`, `updateVariantPrice()`, `getProductDetails()`
- Handles: Product sync, pricing, inventory (via FBA)
- Parent-child: Uses parent ASIN for non-purchasable container

**eBay Service** (`ebay.service.ts`)
- Uses eBay REST API
- OAuth2 client credentials flow
- Methods: `updateInventory()`, `updateVariantPrice()`, `publishListing()`
- Handles: Inventory management, pricing, listing publication
- Parent-child: Uses variation specifications for parent-child relationships

**Shopify Service** (`shopify.service.ts`) — Partial Implementation
- Uses REST API (not GraphQL)
- Access token authentication
- Methods: `getProduct()`, `updateVariantPrice()`, `updateVariantInventory()`
- Handles: Basic product and variant operations
- **Gaps**: No parent-child sync, no order handling, no webhook support

### Database Schema (Rithum Pattern)

```typescript
// Parent Product (Non-purchasable container)
model Product {
  id: String @id
  sku: String @unique
  name: String
  basePrice: Decimal
  totalStock: Int
  
  // Rithum parent-child fields
  variationTheme: String?  // SIZE_COLOR, SIZE, COLOR, SIZE_MATERIAL, null=STANDALONE
  status: String           // DRAFT, ACTIVE, INACTIVE
  
  // Content (shared by all variants)
  bulletPoints: String[]
  keywords: String[]
  
  // Marketplace identifiers (parent-level)
  amazonAsin: String?      // Parent ASIN
  ebayItemId: String?      // Parent listing ID
  
  // Relations
  variations: ProductVariation[]
  listings: Listing[]
  marketplaceSyncs: MarketplaceSync[]
}

// Child Variant (Purchasable SKU)
model ProductVariation {
  id: String @id
  productId: String
  sku: String @unique
  
  // Rithum variation attributes
  variationAttributes: Json?  // { "Size": "Medium", "Color": "Black" }
  
  // Pricing (per-variant)
  price: Decimal
  costPrice: Decimal?
  
  // Inventory (per-variant)
  stock: Int
  
  // Marketplace identifiers (variant-level)
  amazonAsin: String?         // Child ASIN (buyable)
  ebayVariationId: String?    // eBay variation spec
  
  // Channel listings
  channelListings: VariantChannelListing[]
}

// Per-variant channel listing
model VariantChannelListing {
  id: String @id
  variantId: String
  channelId: String           // SHOPIFY, WOOCOMMERCE, ETSY, etc.
  channelSku: String?
  channelVariantId: String?   // Platform-specific variant ID
  channelPrice: Decimal
  channelQuantity: Int
  listingStatus: String       // PENDING, ACTIVE, INACTIVE, ERROR
  lastSyncedAt: DateTime?
  lastSyncStatus: String?     // SUCCESS, FAILED, PENDING
}
```

---

## Part 2: Shopify Integration Design

### 2.1 API Architecture

#### Authentication Strategy
```typescript
// Environment Variables
SHOPIFY_SHOP_NAME=mystore.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxx
SHOPIFY_API_VERSION=2024-01
SHOPIFY_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxx
```

**Authentication Flow**:
1. Store access token in encrypted vault (packages/shared/vault.ts)
2. Use X-Shopify-Access-Token header for all requests
3. Implement token refresh logic (if using OAuth)
4. Validate webhook signatures using HMAC-SHA256

#### API Endpoints Strategy

**Current REST API** (Partial)
- Base: `https://{shop}.myshopify.com/admin/api/{version}`
- Methods: GET, POST, PUT, DELETE
- Rate limit: 2 requests/second (40 points/minute)

**Recommended Approach**: Hybrid REST + GraphQL
- Use REST for simple CRUD operations
- Use GraphQL for complex queries (bulk operations, nested data)
- Implement request batching to optimize rate limits

### 2.2 Parent-Child Product Mapping

#### Mapping Strategy

| Nexus Commerce | Shopify | Notes |
|---|---|---|
| Parent Product | Shopify Product | Non-purchasable container |
| Parent SKU | Product handle | Derived from first variant SKU |
| variationTheme | Inferred from variant titles | SIZE_COLOR, SIZE, COLOR, etc. |
| Child Variant | ProductVariant | Purchasable SKU |
| Child SKU | variant.sku | Unique identifier |
| variationAttributes | Parsed from variant title | `{ "Size": "Medium", "Color": "Black" }` |
| Price | variant.price | Per-variant pricing |
| Stock | inventory_quantity | Per-location aggregation |
| channelVariantId | variant.id (gid) | Shopify variant ID |

### 2.3 Inventory Synchronization

#### Sync Strategy: Bidirectional

**Outbound (Nexus → Shopify)**
- When inventory changes in Nexus, update Shopify inventory levels
- Calculate adjustment (current - new) and apply to default location
- Update channel listing with sync status

**Inbound (Shopify → Nexus)**
- Webhook: `inventory_levels/update` triggers sync
- Aggregate inventory across all locations
- Update variant stock and parent aggregate
- Log marketplace sync

#### Multi-Location Inventory
- Shopify supports multiple fulfillment locations
- Strategy: Aggregate all locations for Nexus inventory
- When syncing to Shopify, update default location only

### 2.4 Order Synchronization

#### Order Sync Flow
1. Webhook: `orders/create` or `orders/updated`
2. Check if order already exists (idempotency)
3. Create order with line items
4. Deduct inventory from variants
5. Log marketplace sync

#### Fulfillment Tracking
- When order fulfilled in Nexus, create fulfillment in Shopify
- Include tracking number and carrier information
- Update order status to FULFILLED

---

## Part 3: WooCommerce Integration Design

### 3.1 API Architecture

#### Authentication Strategy
```typescript
// Environment Variables
WOOCOMMERCE_STORE_URL=https://mystore.com
WOOCOMMERCE_CONSUMER_KEY=ck_xxxxxxxxxxxxx
WOOCOMMERCE_CONSUMER_SECRET=cs_xxxxxxxxxxxxx
WOOCOMMERCE_API_VERSION=wc/v3
```

**Authentication Flow**:
1. Use OAuth 1.0a (consumer key/secret)
2. All requests signed with HMAC-SHA256
3. Store credentials in encrypted vault
4. Implement request signing middleware

#### API Endpoints Strategy

**REST API** (Primary)
- Base: `https://{store}/wp-json/wc/v3`
- Methods: GET, POST, PUT, DELETE
- Rate limit: 10 requests/second (configurable)
- Pagination: Cursor-based with per_page parameter

### 3.2 Parent-Child Product Mapping

#### WooCommerce Product Types

| Type | Nexus Mapping | Notes |
|---|---|---|
| **simple** | Standalone Product | Single SKU, no variations |
| **variable** | Parent Product | Container for variations |
| **variation** | Child Variant | Individual SKU within variable product |

#### Mapping Strategy

| Nexus Commerce | WooCommerce | Notes |
|---|---|---|
| Parent Product | variable product | Non-purchasable container |
| Parent SKU | product slug | Derived from first variation SKU |
| variationTheme | Inferred from attributes | SIZE_COLOR, SIZE, COLOR, etc. |
| Child Variant | variation | Purchasable SKU |
| Child SKU | variation.sku | Unique identifier |
| variationAttributes | variation.attributes | `{ "Size": "Medium", "Color": "Black" }` |
| Price | variation.price | Per-variation pricing |
| Stock | variation.stock_quantity | Per-variation inventory |
| channelVariantId | variation.id | WooCommerce variation ID |

### 3.3 Inventory Synchronization

#### Sync Strategy: Bidirectional

**Outbound (Nexus → WooCommerce)**
- Update variation stock_quantity
- Update stock_status (instock/outofstock)
- Aggregate parent product stock

**Inbound (WooCommerce → Nexus)**
- Webhook: `product.updated` triggers sync
- Update each variation stock
- Aggregate parent stock
- Log marketplace sync

### 3.4 Order Synchronization

#### Order Sync Flow
1. Webhook: `order.created` or `order.updated`
2. Check if order already exists
3. Create order with line items
4. Deduct inventory from variants
5. Log marketplace sync

---

## Part 4: Etsy Integration Design

### 4.1 API Architecture

#### Authentication Strategy
```typescript
// Environment Variables
ETSY_SHOP_ID=123456789
ETSY_API_KEY=xxxxxxxxxxxxx
ETSY_ACCESS_TOKEN=xxxxxxxxxxxxx
ETSY_REFRESH_TOKEN=xxxxxxxxxxxxx
```

**Authentication Flow**:
1. Use OAuth 2.0 with refresh tokens
2. Access token expires in 3600 seconds
3. Implement automatic token refresh
4. Store credentials in encrypted vault

#### API Endpoints Strategy

**REST API** (Primary)
- Base: `https://openapi.etsy.com/v3`
- Methods: GET, POST, PUT, DELETE
- Rate limit: 10 requests/second
- Pagination: Offset-based with limit parameter

### 4.2 Parent-Child Product Mapping

#### Mapping Strategy

| Nexus Commerce | Etsy | Notes |
|---|---|---|
| Parent Product | Etsy Listing | Container for variations |
| Parent SKU | listing_id | Etsy listing ID as parent identifier |
| variationTheme | Inferred from property names | SIZE_COLOR, SIZE, COLOR, etc. |
| Child Variant | inventory entry | Purchasable SKU with specific property values |
| Child SKU | inventory.sku | Unique identifier |
| variationAttributes | inventory.property_values | `{ "Size": "Medium", "Color": "Black" }` |
| Price | listing.price | Per-listing (Etsy doesn't support per-variant pricing) |
| Stock | inventory.quantity | Per-variant inventory |
| channelVariantId | inventory.sku | Etsy uses SKU as variant identifier |

### 4.3 Inventory Synchronization

#### Etsy Inventory Model
- **Quantity**: Per-inventory entry (variant)
- **State**: active, inactive, sold_out, deactivated
- **No multi-location**: Single inventory per listing

#### Sync Strategy: Bidirectional

**Outbound (Nexus → Etsy)**
- Update inventory by SKU
- Update listing state based on stock

**Inbound (Etsy → Nexus)**
- Webhook: `inventory/update` triggers sync
- Update variant stock
- Aggregate parent stock
- Log marketplace sync

### 4.4 Order Synchronization

#### Order Sync Flow
1. Webhook: `receipt/create` or `receipt/update`
2. Check if order already exists
3. Create order with line items
4. Deduct inventory from variants
5. Log marketplace sync

---

## Part 5: Implementation Roadmap

### Phase 1: Foundation & Infrastructure (Week 1-2)

#### 1.1 Database Schema Extensions
- [ ] Add marketplace-specific ID fields to ProductVariation
  - `shopifyVariantId: String?`
  - `woocommerceVariationId: Int?`
  - `etsyListingId: String?`
  - `etsySku: String?`
- [ ] Extend VariantChannelListing model
  - Add `channelSpecificData: Json?` for platform-specific metadata
  - Add `syncRetryCount: Int @default(0)`
  - Add `lastSyncError: String?`
- [ ] Create migration for new fields

#### 1.2 Service Infrastructure
- [ ] Create base marketplace service interface
  - Define common methods all services must implement
  - Create abstract class for shared logic
- [ ] Implement request signing/authentication middleware
  - OAuth 1.0a for WooCommerce
  - OAuth 2.0 for Etsy
  - Token refresh logic
- [ ] Create error handling and retry utilities
  - Exponential backoff implementation
  - Circuit breaker pattern for API failures
  - Comprehensive error logging

#### 1.3 Webhook Infrastructure
- [ ] Create webhook registration service
  - Register webhooks with each marketplace
  - Store webhook endpoints in database
  - Implement webhook signature verification
- [ ] Create webhook handler middleware
  - Validate webhook signatures
  - Implement idempotency checks
  - Queue webhook processing for async handling

### Phase 2: Shopify Integration (Week 3-4)

#### 2.1 Enhanced Shopify Service
- [ ] Implement GraphQL client for bulk operations
- [ ] Add product sync methods
  - `syncProductsFromShopify()` — Fetch and sync all products
  - `createProductInShopify()` — Create parent-child structure
  - `updateProductInShopify()` — Update product details
- [ ] Add inventory methods
  - `getInventoryLevels()` — Fetch inventory across locations
  - `updateInventoryLevel()` — Update inventory with adjustment
  - `aggregateInventory()` — Sum across locations
- [ ] Add order methods
  - `getOrder()`, `getOrdersByStatus()`
  - `createFulfillment()`, `updateFulfillment()`
- [ ] Add webhook methods
  - `registerWebhooks()` — Register all required webhooks
  - `validateWebhookSignature()` — HMAC-SHA256 validation

#### 2.2 Shopify Sync Service
- [ ] Create `ShopifySyncService`
  - Implement parent-child detection from Shopify products
  - Implement variant attribute extraction from titles
  - Implement bidirectional inventory sync
  - Implement order sync with webhook handlers
- [ ] Create sync job
  - Schedule periodic product sync
  - Schedule periodic inventory sync
  - Handle sync errors and retries

#### 2.3 Shopify Routes
- [ ] Create `/shopify/sync/products` — Trigger product sync
- [ ] Create `/shopify/sync/inventory` — Trigger inventory sync
- [ ] Create `/shopify/webhooks/inventory` — Webhook endpoint
- [ ] Create `/shopify/webhooks/orders` — Webhook endpoint
- [ ] Create `/shopify/status` — Check Shopify connection status

### Phase 3: WooCommerce Integration (Week 5-6)

#### 3.1 WooCommerce Service
- [ ] Implement OAuth 1.0a signing
- [ ] Add product sync methods
  - `getAllProducts()` — Fetch all variable products
  - `getVariations()` — Fetch variations for product
  - `createProduct()` — Create variable product
  - `updateVariation()` — Update variation stock/price
- [ ] Add order methods
  - `getOrder()`, `getOrdersByStatus()`
  - `updateOrderStatus()`
- [ ] Add webhook methods
  - `registerWebhooks()` — Register all required webhooks
  - `validateWebhookSignature()` — HMAC validation

#### 3.2 WooCommerce Sync Service
- [ ] Create `WooCommerceSyncService`
  - Implement parent-child detection from variable products
  - Implement attribute extraction from variation attributes
  - Implement bidirectional inventory sync
  - Implement order sync with webhook handlers
- [ ] Create sync job
  - Schedule periodic product sync
  - Schedule periodic inventory sync
  - Handle sync errors and retries

#### 3.3 WooCommerce Routes
- [ ] Create `/woocommerce/sync/products` — Trigger product sync
- [ ] Create `/woocommerce/sync/inventory` — Trigger inventory sync
- [ ] Create `/woocommerce/webhooks/product` — Webhook endpoint
- [ ] Create `/woocommerce/webhooks/orders` — Webhook endpoint
- [ ] Create `/woocommerce/status` — Check WooCommerce connection status

### Phase 4: Etsy Integration (Week 7-8)

#### 4.1 Etsy Service
- [ ] Implement OAuth 2.0 with token refresh
- [ ] Add listing sync methods
  - `getAllListings()` — Fetch all listings
  - `getListing()` — Fetch single listing
  - `createListing()` — Create listing with variations
  - `updateListing()` — Update listing details
- [ ] Add inventory methods
  - `getInventory()` — Fetch inventory entries
  - `updateInventory()` — Update inventory by SKU
- [ ] Add order methods
  - `getReceipt()`, `getReceiptsByShop()`
  - `updateShipment()` — Update tracking info
- [ ] Add webhook methods
  - `registerWebhooks()` — Register all required webhooks
  - `validateWebhookSignature()` — HMAC validation

#### 4.2 Etsy Sync Service
- [ ] Create `EtsySyncService`
  - Implement parent-child detection from listings
  - Implement attribute extraction from property values
  - Implement bidirectional inventory sync
  - Implement order sync with webhook handlers
- [ ] Create sync job
  - Schedule periodic listing sync
  - Schedule periodic inventory sync
  - Handle sync errors and retries

#### 4.3 Etsy Routes
- [ ] Create `/etsy/sync/listings` — Trigger listing sync
- [ ] Create `/etsy/sync/inventory` — Trigger inventory sync
- [ ] Create `/etsy/webhooks/inventory` — Webhook endpoint
- [ ] Create `/etsy/webhooks/orders` — Webhook endpoint
- [ ] Create `/etsy/status` — Check Etsy connection status

### Phase 5: Unified Marketplace Service Updates (Week 9)

#### 5.1 Extend Marketplace Service
- [ ] Add support for new channels
  - Update `MarketplaceChannel` type to include SHOPIFY, WOOCOMMERCE, ETSY
  - Update `getService()` to handle new channels
  - Update `getAvailableMarketplaces()` to detect new channels
- [ ] Add unified sync methods
  - `syncAllMarketplaces()` — Sync all connected channels
  - `syncProductsAcrossChannels()` — Sync specific products
  - `syncInventoryAcrossChannels()` — Sync inventory to all channels

#### 5.2 Update Marketplace Routes
- [ ] Extend `/marketplaces/status` to include new channels
- [ ] Extend `/marketplaces/prices/update` to support new channels
- [ ] Extend `/marketplaces/inventory/update` to support new channels
- [ ] Extend `/marketplaces/variants/sync` to support new channels
- [ ] Extend `/marketplaces/sync-all` to include new channels

### Phase 6: Testing & Documentation (Week 10)

#### 6.1 Unit Tests
- [ ] Test parent-child detection for each marketplace
- [ ] Test attribute extraction for each marketplace
- [ ] Test inventory sync logic (bidirectional)
- [ ] Test order sync logic
- [ ] Test webhook signature validation
- [ ] Test error handling and retries

#### 6.2 Integration Tests
- [ ] Test end-to-end product sync
- [ ] Test end-to-end inventory sync
- [ ] Test end-to-end order sync
- [ ] Test multi-channel sync
- [ ] Test webhook processing

#### 6.3 Documentation
- [ ] Create API documentation for new endpoints
- [ ] Create webhook documentation for each marketplace
- [ ] Create setup guides for each marketplace
- [ ] Create troubleshooting guides
- [ ] Create data mapping reference

---

## Part 6: Data Transformation Specifications

### 6.1 Product Data Transformation

#### Shopify → Nexus
```typescript
// Input: Shopify Product with variants
const shopifyProduct = {
  id: "gid://shopify/Product/123",
  title: "T-Shirt",
  handle: "t-shirt",
  variants: [
    {
      id: "gid://shopify/ProductVariant/789",
      sku: "TSHIRT-M-BLK",
      title: "Medium / Black",
      price: "29.99",
      inventory_quantity: 50
    }
  ]
}

// Output: Nexus Parent + Variants
const nexusParent = {
  sku: "TSHIRT",
  name: "T-Shirt",
  variationTheme: "SIZE_COLOR",
  shopifyProductId: "gid://shopify/Product/123"
}

const nexusVariant = {
  sku: "TSHIRT-M-BLK",
  variationAttributes: { Size: "Medium", Color: "Black" },
  price: 29.99,
  stock: 50,
  shopifyVariantId: "gid://shopify/ProductVariant/789"
}
```

#### WooCommerce → Nexus
```typescript
// Input: WooCommerce variable product with variations
const wooProduct = {
  id: 123,
  name: "T-Shirt",
  slug: "t-shirt",
  type: "variable",
  attributes: [
    { name: "Size", options: ["Small", "Medium", "Large"] },
    { name: "Color", options: ["Black", "White"] }
  ]
}

const wooVariation = {
  id: 456,
  product_id: 123,
  sku: "TSHIRT-M-BLK",
  price: "29.99",
  stock_quantity: 50,
  attributes: [
    { name: "Size", option: "Medium" },
    { name: "Color", option: "Black" }
  ]
}

// Output: Nexus Parent + Variants
const nexusParent = {
  sku: "TSHIRT",
  name: "T-Shirt",
  variationTheme: "SIZE_COLOR",
  woocommerceProductId: 123
}

const nexusVariant = {
  sku: "TSHIRT-M-BLK",
  variationAttributes: { Size: "Medium", Color: "Black" },
  price: 29.99,
  stock: 50,
  woocommerceVariationId: 456
}
```

#### Etsy → Nexus
```typescript
// Input: Etsy listing with inventory
const etsyListing = {
  listing_id: 789,
  title: "T-Shirt",
  price: 29.99,
  variations: [
    { property_id: 1, property_name: "Size", values: ["Small", "Medium", "Large"] },
    { property_id: 2, property_name: "Color", values: ["Black", "White"] }
  ],
  inventory: [
    {
      sku: "TSHIRT-M-BLK",
      quantity: 50,
      property_values: [
        { property_id: 1, property_name: "Size", value: "Medium" },
        { property_id: 2, property_name: "Color", value: "Black" }
      ]
    }
  ]
}

// Output: Nexus Parent + Variants
const nexusParent = {
  sku: "ETSY-789",
  name: "T-Shirt",
  variationTheme: "SIZE_COLOR",
  etsyListingId: 789
}

const nexusVariant = {
  sku: "TSHIRT-M-BLK",
  variationAttributes: { Size: "Medium", Color: "Black" },
  price: 29.99,
  stock: 50,
  etsySku: "TSHIRT-M-BLK"
}
```

### 6.2 Inventory Data Transformation

#### Nexus → Shopify
```typescript
// Input: Nexus variant with new stock
const nexusVariant = {
  id: "var-123",
  sku: "TSHIRT-M-BLK",
  stock: 75,
  shopifyVariantId: "gid://shopify/ProductVariant/789"
}

// Current Shopify inventory: 50
// Adjustment: 75 - 50 = 25

// Output: Shopify inventory update
const shopifyUpdate = {
  inventory_item_id: "gid://shopify/InventoryItem/456",
  location_id: "gid://shopify/Location/1",
  available_adjustment: 25
}
```

#### Nexus → WooCommerce
```typescript
// Input: Nexus variant with new stock
const nexusVariant = {
  id: "var-123",
  sku: "TSHIRT-M-BLK",
  stock: 75,
  woocommerceVariationId: 456
}

// Output: WooCommerce variation update
const wooUpdate = {
  stock_quantity: 75,
  stock_status: "instock"
}
```

#### Nexus → Etsy
```typescript
// Input: Nexus variant with new stock
const nexusVariant = {
  id: "var-123",
  sku: "TSHIRT-M-BLK",
  stock: 75,
  etsySku: "TSHIRT-M-BLK"
}

// Output: Etsy inventory update
const etsyUpdate = {
  sku: "TSHIRT-M-BLK",
  quantity: 75
}
```

### 6.3 Order Data Transformation

#### Shopify → Nexus
```typescript
// Input: Shopify order
const shopifyOrder = {
  id: "gid://shopify/Order/123",
  order_number: 1001,
  status: "pending",
  line_items: [
    {
      sku: "TSHIRT-M-BLK",
      quantity: 2,
      price: "29.99"
    }
  ],
  customer: {
    email: "customer@example.com",
    first_name: "John",
    last_name: "Doe"
  }
}

// Output: Nexus order
const nexusOrder = {
  channelId: "SHOPIFY",
  channelOrderId: "gid://shopify/Order/123",
  channelOrderNumber: "#1001",
  status: "PENDING",
  totalAmount: 59.98,
  buyerName: "John Doe",
  buyerEmail: "customer@example.com",
  items: [
    {
      sku: "TSHIRT-M-BLK",
      quantity: 2,
      price: 29.99
    }
  ]
}
```

#### WooCommerce → Nexus
```typescript
// Input: WooCommerce order
const wooOrder = {
  id: 456,
  order_key: "wc-order-key-123",
  status: "processing",
  line_items: [
    {
      sku: "TSHIRT-M-BLK",
      quantity: 2,
      total: "59.98"
    }
  ],
  customer: {
    email: "customer@example.com",
    first_name: "John",
    last_name: "Doe"
  }
}

// Output: Nexus order
const nexusOrder = {
  channelId: "WOOCOMMERCE",
  channelOrderId: 456,
  channelOrderNumber: "wc-order-key-123",
  status: "PROCESSING",
  totalAmount: 59.98,
  buyerName: "John Doe",
  buyerEmail: "customer@example.com",
  items: [
    {
      sku: "TSHIRT-M-BLK",
      quantity: 2,
      price: 29.99
    }
  ]
}
```

#### Etsy → Nexus
```typescript
// Input: Etsy receipt
const etsyReceipt = {
  receipt_id: 789,
  status: "paid",
  transactions: [
    {
      sku: "TSHIRT-M-BLK",
      quantity: 2,
      price: 29.99
    }
  ],
  buyer: {
    email: "customer@example.com",
    name: "John Doe"
  }
}

// Output: Nexus order
const nexusOrder = {
  channelId: "ETSY",
  channelOrderId: 789,
  channelOrderNumber: "ETSY-789",
  status: "PAID",
  totalAmount: 59.98,
  buyerName: "John Doe",
  buyerEmail: "customer@example.com",
  items: [
    {
      sku: "TSHIRT-M-BLK",
      quantity: 2,
      price: 29.99
    }
  ]
}
```

---

## Part 7: API Authentication Flows

### 7.1 Shopify Authentication

#### Access Token Flow
```
1. Admin creates Shopify app in partner dashboard
2. App receives API credentials (API key, API secret)
3. Admin installs app on store
4. App receives access token (valid indefinitely)
5. Store token in encrypted vault
6. Use token in X-Shopify-Access-Token header for all requests
```

#### Webhook Signature Validation
```typescript
// Shopify sends X-Shopify-Hmac-SHA256 header
// Validate using HMAC-SHA256 with API secret

import crypto from 'crypto'

function validateShopifyWebhook(body: string, hmacHeader: string, secret: string): boolean {
  const hash = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .