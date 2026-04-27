# Shopify Marketplace Integration Plan
## Full Rithum Parent-Child Hierarchy Support

**Status**: Planning Phase  
**Last Updated**: 2026-04-23  
**Scope**: Complete Shopify integration with parent-child product sync, inventory management, and order handling

---

## Executive Summary

This document provides a comprehensive design and implementation strategy for integrating **Shopify** into the Nexus Commerce platform with full support for the **Rithum parent-child product hierarchy**.

### Key Objectives
1. Extend existing marketplace infrastructure to support Shopify
2. Implement parent-child product mapping for Shopify's native structure
3. Enable bidirectional inventory synchronization
4. Support order fulfillment workflows
5. Maintain data consistency across channels
6. Provide comprehensive API authentication and security

### Architecture Principles
1. **Unified Interface**: Shopify service follows existing marketplace patterns
2. **Rithum Compliance**: Parent-child hierarchy respected throughout
3. **Idempotent Operations**: Safe retry logic for all API calls
4. **Error Resilience**: Comprehensive error handling and recovery
5. **Audit Trail**: Full logging of all marketplace operations

---

## Part 1: Existing Architecture Context

### Current Marketplace Infrastructure

#### Service Pattern
```
apps/api/src/services/marketplaces/
├── marketplace.service.ts      (Unified interface)
├── amazon.service.ts           (Implemented - SP-API)
├── ebay.service.ts             (Implemented - REST API)
└── shopify.service.ts          (Partial - needs enhancement)
```

#### Unified Marketplace Service
The `MarketplaceService` provides a consistent interface for all marketplace operations:

```typescript
export type MarketplaceChannel = "AMAZON" | "EBAY" | "SHOPIFY"

export interface MarketplaceVariantUpdate {
  channel: MarketplaceChannel
  channelVariantId: string
  price?: number
  inventory?: number
  locationId?: string
}

export class MarketplaceService {
  async updatePrice(updates: MarketplaceVariantUpdate[]): Promise<MarketplaceOperationResult[]>
  async updateInventory(updates: MarketplaceVariantUpdate[]): Promise<MarketplaceOperationResult[]>
  async batchUpdatePrices(updates, maxRetries): Promise<MarketplaceOperationResult[]>
  async batchUpdateInventory(updates, maxRetries): Promise<MarketplaceOperationResult[]>
  getService(channel): MarketplaceServiceInterface
  isMarketplaceAvailable(channel): boolean
  getAvailableMarketplaces(): MarketplaceChannel[]
}
```

#### Rithum Parent-Child Database Schema

```typescript
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
  
  // Marketplace identifiers
  amazonAsin: String?
  ebayItemId: String?
  
  variations: ProductVariation[]
  listings: Listing[]
  marketplaceSyncs: MarketplaceSync[]
}

model ProductVariation {
  id: String @id
  productId: String
  sku: String @unique
  
  // Rithum variation attributes
  variationAttributes: Json?  // { "Size": "Medium", "Color": "Black" }
  
  price: Decimal
  stock: Int
  
  // Marketplace identifiers
  amazonAsin: String?
  ebayVariationId: String?
  
  channelListings: VariantChannelListing[]
}

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

## Part 2: Shopify API Architecture

### 2.1 Authentication Strategy

#### Environment Configuration
```bash
# Shopify Configuration
SHOPIFY_SHOP_NAME=mystore.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxx
SHOPIFY_API_VERSION=2024-01
SHOPIFY_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxx
```

#### Authentication Flow

**Step 1: Create Shopify App**
- Admin creates custom app in Shopify Partner Dashboard
- App receives API credentials (API key, API secret)
- Admin installs app on store
- App receives access token (valid indefinitely)

**Step 2: Store Credentials**
```typescript
// Use encrypted vault for credential storage
import { vault } from '@nexus/shared'

await vault.set('shopify_access_token', accessToken)
await vault.set('shopify_webhook_secret', webhookSecret)
```

**Step 3: API Requests**
```typescript
// All requests use X-Shopify-Access-Token header
const headers = {
  'X-Shopify-Access-Token': accessToken,
  'Content-Type': 'application/json'
}

const response = await fetch(
  `https://${shopName}.myshopify.com/admin/api/${apiVersion}/products.json`,
  { method: 'GET', headers }
)
```

#### Webhook Signature Validation

```typescript
import crypto from 'crypto'

function validateShopifyWebhook(
  body: string,
  hmacHeader: string,
  secret: string
): boolean {
  const hash = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64')
  
  return hash === hmacHeader
}

// Usage in webhook handler
app.post('/shopify/webhooks/products/update', (request, reply) => {
  const hmac = request.headers['x-shopify-hmac-sha256']
  const body = request.rawBody
  
  if (!validateShopifyWebhook(body, hmac, webhookSecret)) {
    return reply.status(401).send({ error: 'Invalid signature' })
  }
  
  // Process webhook
})
```

### 2.2 API Endpoints & Rate Limits

#### REST API Endpoints
```
Base URL: https://{shop}.myshopify.com/admin/api/{version}

Products:
  GET    /products.json                    - List all products
  GET    /products/{id}.json               - Get single product
  POST   /products.json                    - Create product
  PUT    /products/{id}.json               - Update product
  DELETE /products/{id}.json               - Delete product

Variants:
  GET    /products/{id}/variants.json      - List variants
  GET    /variants/{id}.json               - Get single variant
  POST   /products/{id}/variants.json      - Create variant
  PUT    /variants/{id}.json               - Update variant
  DELETE /variants/{id}.json               - Delete variant

Inventory:
  GET    /inventory_levels.json            - List inventory levels
  POST   /inventory_levels/adjust.json     - Adjust inventory
  POST   /inventory_levels/connect.json    - Connect inventory item to location

Orders:
  GET    /orders.json                      - List orders
  GET    /orders/{id}.json                 - Get single order
  POST   /orders/{id}/fulfillments.json    - Create fulfillment
  PUT    /fulfillments/{id}.json           - Update fulfillment

Locations:
  GET    /locations.json                   - List fulfillment locations
```

#### Rate Limits
- **Leaky Bucket Algorithm**: 2 requests/second (40 points/minute)
- **Burst Capacity**: Up to 40 points
- **Point Cost**: Most operations = 1 point, bulk operations = variable
- **Rate Limit Headers**:
  - `X-Shopify-Shop-Api-Call-Limit: 32/40` (current/max)
  - `Retry-After: 1` (seconds to wait if rate limited)

#### Rate Limiting Implementation
```typescript
import RateLimit from 'bottleneck'

const shopifyLimiter = new RateLimit({
  minTime: 500,              // 2 requests/second
  maxConcurrent: 1,
  reservoir: 40,             // 40 points
  reservoirRefreshAmount: 40,
  reservoirRefreshInterval: 60 * 1000  // per minute
})

// Use limiter for all API calls
async function getProduct(productId: string) {
  return shopifyLimiter.schedule(() => 
    makeRequest('GET', `/products/${productId}.json`)
  )
}
```

---

## Part 3: Parent-Child Product Mapping

### 3.1 Shopify Product Structure

#### Shopify Product Model
```typescript
interface ShopifyProduct {
  id: string                    // gid://shopify/Product/123456
  title: string
  handle: string                // URL-friendly slug
  vendor: string
  product_type: string
  created_at: string
  updated_at: string
  published_at: string
  status: string                // active, archived, draft
  tags: string
  
  variants: ShopifyVariant[]
  images: ShopifyImage[]
  options: ShopifyOption[]
}

interface ShopifyVariant {
  id: string                    // gid://shopify/ProductVariant/789
  product_id: string
  title: string                 // e.g., "Medium / Black"
  sku: string
  position: number
  inventory_quantity: number
  inventory_management: string  // shopify, external, fulfillment_service
  inventory_policy: string      // deny, continue
  barcode: string
  compare_at_price: string
  fulfillment_service: string
  weight: number
  weight_unit: string
  created_at: string
  updated_at: string
  taxable: boolean
  image_id: string | null
  inventory_item_id: string     // gid://shopify/InventoryItem/456
}

interface ShopifyOption {
  id: string
  product_id: string
  name: string                  // e.g., "Size", "Color"
  position: number
  values: string[]              // e.g., ["Small", "Medium", "Large"]
}

interface ShopifyImage {
  id: string
  product_id: string
  position: number
  created_at: string
  updated_at: string
  alt: string | null
  width: number
  height: number
  src: string
  variant_ids: string[]
}
```

### 3.2 Mapping Strategy

#### Shopify → Nexus Commerce Mapping

| Nexus Commerce | Shopify | Notes |
|---|---|---|
| **Parent Product** | Shopify Product | Non-purchasable container |
| **Parent SKU** | Product handle | Derived from first variant SKU |
| **variationTheme** | Inferred from option names | SIZE_COLOR, SIZE, COLOR, etc. |
| **Child Variant** | ProductVariant | Purchasable SKU |
| **Child SKU** | variant.sku | Unique identifier |
| **variationAttributes** | Parsed from variant title | `{ "Size": "Medium", "Color": "Black" }` |
| **Price** | variant.price | Per-variant pricing |
| **Stock** | inventory_quantity | Per-location aggregation |
| **channelVariantId** | variant.id (gid) | Shopify variant ID |

#### Example Mapping

**Shopify Product:**
```json
{
  "id": "gid://shopify/Product/123456",
  "title": "Classic T-Shirt",
  "handle": "classic-t-shirt",
  "options": [
    { "name": "Size", "values": ["Small", "Medium", "Large"] },
    { "name": "Color", "values": ["Black", "White"] }
  ],
  "variants": [
    {
      "id": "gid://shopify/ProductVariant/789",
      "sku": "TSHIRT-S-BLK",
      "title": "Small / Black",
      "price": "29.99",
      "inventory_quantity": 50
    },
    {
      "id": "gid://shopify/ProductVariant/790",
      "sku": "TSHIRT-M-BLK",
      "title": "Medium / Black",
      "price": "29.99",
      "inventory_quantity": 75
    }
  ]
}
```

**Nexus Commerce Parent:**
```typescript
{
  sku: "TSHIRT",
  name: "Classic T-Shirt",
  variationTheme: "SIZE_COLOR",
  status: "ACTIVE",
  shopifyProductId: "gid://shopify/Product/123456",
  bulletPoints: [],
  keywords: []
}
```

**Nexus Commerce Variants:**
```typescript
[
  {
    sku: "TSHIRT-S-BLK",
    variationAttributes: { Size: "Small", Color: "Black" },
    price: 29.99,
    stock: 50,
    shopifyVariantId: "gid://shopify/ProductVariant/789"
  },
  {
    sku: "TSHIRT-M-BLK",
    variationAttributes: { Size: "Medium", Color: "Black" },
    price: 29.99,
    stock: 75,
    shopifyVariantId: "gid://shopify/ProductVariant/790"
  }
]
```

### 3.3 Parent-Child Detection Algorithm

```typescript
async function detectAndMapShopifyProducts(products: ShopifyProduct[]) {
  const results = []
  
  for (const product of products) {
    // 1. Extract parent SKU from first variant
    if (!product.variants || product.variants.length === 0) {
      console.warn(`Product ${product.id} has no variants, skipping`)
      continue
    }
    
    const firstVariantSku = product.variants[0].sku
    const parentSku = extractParentSku(firstVariantSku)
    
    // 2. Detect variation theme from option names
    const optionNames = product.options.map(opt => opt.name)
    const theme = detectVariationTheme(optionNames, product.variants)
    
    // 3. Create/update parent product
    const parent = await createOrUpdateParent({
      sku: parentSku,
      name: product.title,
      variationTheme: theme,
      shopifyProductId: product.id,
      status: product.status === 'active' ? 'ACTIVE' : 'INACTIVE',
      bulletPoints: [],
      keywords: product.tags.split(',').map(t => t.trim())
    })
    
    // 4. Create/update child variants
    const variants = []
    for (const variant of product.variants) {
      // Parse variant title to extract attributes
      const attributes = parseVariantTitle(variant.title, theme, product.options)
      
      const childVariant = await createOrUpdateVariant({
        parentId: parent.id,
        sku: variant.sku,
        variationAttributes: attributes,
        shopifyVariantId: variant.id,
        price: parseFloat(variant.price),
        stock: variant.inventory_quantity
      })
      
      variants.push(childVariant)
    }
    
    results.push({
      parentId: parent.id,
      parentSku: parentSku,
      theme: theme,
      variantCount: variants.length,
      status: 'success'
    })
  }
  
  return results
}

// Helper: Extract parent SKU from variant SKU
function extractParentSku(variantSku: string): string {
  // Remove variation codes (size, color, etc.)
  // TSHIRT-S-BLK → TSHIRT
  // SHIRT-M → SHIRT
  
  const parts = variantSku.split('-')
  
  // Keep removing parts until we find a reasonable parent
  for (let i = parts.length - 1; i > 0; i--) {
    const candidate = parts.slice(0, i).join('-')
    
    // Check if this looks like a valid parent SKU
    if (candidate.length >= 3 && !isVariationCode(parts[i])) {
      return candidate
    }
  }
  
  return parts[0]
}

// Helper: Detect variation theme
function detectVariationTheme(
  optionNames: string[],
  variants: ShopifyVariant[]
): string {
  const names = optionNames.map(n => n.toUpperCase())
  
  if (names.includes('SIZE') && names.includes('COLOR')) {
    return 'SIZE_COLOR'
  } else if (names.includes('SIZE') && names.includes('MATERIAL')) {
    return 'SIZE_MATERIAL'
  } else if (names.includes('SIZE')) {
    return 'SIZE'
  } else if (names.includes('COLOR')) {
    return 'COLOR'
  }
  
  return 'STANDALONE'
}

// Helper: Parse variant title to extract attributes
function parseVariantTitle(
  title: string,
  theme: string,
  options: ShopifyOption[]
): Record<string, string> {
  const attributes: Record<string, string> = {}
  
  // Title format: "Size / Color" or "Size - Color"
  const parts = title.split(/\s*[\/\-]\s*/)
  
  for (let i = 0; i < parts.length && i < options.length; i++) {
    const optionName = options[i].name
    const value = parts[i].trim()
    
    if (value && options[i].values.includes(value)) {
      attributes[optionName] = value
    }
  }
  
  return attributes
}
```

---

## Part 4: Inventory Synchronization

### 4.1 Shopify Inventory Model

#### Inventory Structure
```typescript
interface ShopifyInventoryLevel {
  inventory_item_id: string    // gid://shopify/InventoryItem/456
  location_id: string          // gid://shopify/Location/1
  available: number
  updated_at: string
}

interface ShopifyLocation {
  id: string                   // gid://shopify/Location/1
  name: string                 // e.g., "Main Warehouse"
  address1: string
  address2: string
  city: string
  zip: string
  province: string
  country: string
  phone: string
  created_at: string
  updated_at: string
  legacy: boolean
  active: boolean
}
```

#### Multi-Location Inventory
- Shopify supports multiple fulfillment locations
- Each variant has inventory at each location
- Strategy: Aggregate all locations for Nexus inventory
- When syncing to Shopify, update default location only

### 4.2 Bidirectional Inventory Sync

#### Outbound: Nexus → Shopify

```typescript
async function syncInventoryToShopify(variantId: string, newQuantity: number) {
  // 1. Get variant with channel listing
  const variant = await prisma.productVariation.findUnique({
    where: { id: variantId },
    include: {
      product: true,
      channelListings: {
        where: { channelId: 'SHOPIFY' }
      }
    }
  })
  
  if (!variant || !variant.channelListings[0]) {
    throw new Error(`Variant ${variantId} not found or not listed on Shopify`)
  }
  
  const shopifyListing = variant.channelListings[0]
  
  // 2. Get Shopify variant details
  const shopifyVariant = await shopifyService.getVariant(shopifyListing.channelVariantId)
  
  // 3. Get default location
  const defaultLocation = await shopifyService.getDefaultLocationId()
  
  // 4. Get current inventory level
  const currentLevel = await shopifyService.getInventoryLevel(
    shopifyVariant.inventory_item_id,
    defaultLocation
  )
  
  // 5. Calculate adjustment
  const adjustment = newQuantity - currentLevel.available
  
  // 6. Update inventory level
  if (adjustment !== 0) {
    await shopifyService.updateInventoryLevel(
      shopifyVariant.inventory_item_id,
      defaultLocation,
      adjustment
    )
  }
  
  // 7. Update channel listing
  await prisma.variantChannelListing.update({
    where: { id: shopifyListing.id },
    data: {
      channelQuantity: newQuantity,
      lastSyncedAt: new Date(),
      lastSyncStatus: 'SUCCESS'
    }
  })
  
  // 8. Log sync
  await logMarketplaceSync({
    productId: variant.productId,
    channel: 'SHOPIFY',
    lastSyncStatus: 'SUCCESS',
    lastSyncAt: new Date()
  })
}
```

#### Inbound: Shopify → Nexus

```typescript
// Webhook: inventory_levels/update
async function handleShopifyInventoryWebhook(payload: {
  inventory_item_id: string
  location_id: string
  available: number
  updated_at: string
}) {
  // 1. Find variant by Shopify inventory item ID
  const variant = await prisma.productVariation.findFirst({
    where: {
      channelListings: {
        some: {
          channelId: 'SHOPIFY',
          channelSpecificData: {
            path: ['inventory_item_id'],
            equals: payload.inventory_item_id
          }
        }
      }
    },
    include: { product: true }
  })
  
  if (!variant) {
    console.warn(`Variant not found for inventory item ${payload.inventory_item_id}`)
    return
  }
  
  // 2. Get all inventory levels for this variant
  const allLevels = await shopifyService.getInventoryLevels(
    variant.channelListings[0].channelVariantId
  )
  
  // 3. Aggregate inventory across all locations
  const totalInventory = allLevels.reduce((sum, level) => sum + level.available, 0)
  
  // 4. Update variant stock
  await prisma.productVariation.update({
    where: { id: variant.id },
    data: { stock: totalInventory }
  })
  
  // 5. Aggregate parent stock
  const parent = await aggregateParentStock(variant.productId)
  
  // 6. Update channel listing
  const shopifyListing = variant.channelListings.find(cl => cl.channelId === 'SHOPIFY')
  if (shopifyListing) {
    await prisma.variantChannelListing.update({
      where: { id: shopifyListing.id },
      data: {
        channelQuantity: totalInventory,
        lastSyncedAt: new Date(),
        lastSyncStatus: 'SUCCESS'
      }
    })
  }
  
  // 7. Log sync
  await logMarketplaceSync({
    productId: variant.productId,
    channel: 'SHOPIFY',
    lastSyncStatus: 'SUCCESS',
    lastSyncAt: new Date()
  })
}

// Helper: Aggregate parent stock
async function aggregateParentStock(productId: string): Promise<number> {
  const variants = await prisma.productVariation.findMany({
    where: { productId },
    select: { stock: true }
  })
  
  const totalStock = variants.reduce((sum, v) => sum + v.stock, 0)
  
  await prisma.product.update({
    where: { id: productId },
    data: { totalStock }
  })
  
  return totalStock
}
```

---

## Part 5: Order Synchronization

### 5.1 Shopify Order Structure

```typescript
interface ShopifyOrder {
  id: string                    // gid://shopify/Order/123
  order_number: number          // #1001
  created_at: string
  updated_at: string
  status: string                // pending, fulfilled, cancelled, etc.
  financial_status: string      // authorized, paid, refunded, etc.
  fulfillment_status: string    // fulfilled, partial, unshipped, etc.
  
  customer: {
    id: string
    email: string
    first_name: string
    last_name: string
    phone: string
  }
  
  line_items: Array<{
    id: string
    product_id: string
    variant_id: string
    sku: string
    title: string
    quantity: number
    price: string
    total_discount: string
  }>
  
  shipping_address: {
    first_name: string
    last_name: string
    address1: string
    address2: string
    city: string
    province: string
    postal_code: string
    country: string
    phone: string
  }
  
  fulfillments: Array<{
    id: string
    status: string
    tracking_info: {
      number: string
      company: string
      url: string
    }
  }>
  
  total_price: string
  subtotal_price: string
  total_tax: string
  total_shipping: string
}
```

### 5.2 Order Sync Flow

```typescript
// Webhook: orders/create
async function handleShopifyOrderWebhook(order: ShopifyOrder) {
  // 1. Check if order already exists (idempotency)
  const existingOrder = await prisma.order.findFirst({
    where: {
      amazonOrderId: order.id  // Using amazonOrderId field for all channels
    }
  })
  
  if (existingOrder) {
    console.log(`Order ${order.id} already processed, skipping`)
    return
  }
  
  try {
    // 2. Create order in Nexus
    const nexusOrder = await prisma.order.create({
      data: {
        amazonOrderId: order.id,  // Store Shopify order ID here
        status: mapShopifyStatus(order.status),
        totalAmount: new Decimal(order.total_price),
        channelId: 'SHOPIFY',  // Store channel in a new field
        buyerName: `${order.customer.first_name} ${order.customer.last_name}`,
        shippingAddress: order.shipping_address
      }
    })
    
    // 3. Create order items
    for (const lineItem of order.line_items) {
      // Find variant by SKU
      const variant = await prisma.productVariation.findUnique({
        where: { sku: lineItem.sku },
        include: { product: true }
      })
      
      if (!variant) {
        console.warn(`Variant not found for SKU ${lineItem.sku}`)
        continue
      }
      
      await prisma.orderItem.create({
        data: {
          orderId: nexusOrder.id,
          sku: lineItem.sku,
          quantity: lineItem.quantity,
          price: new Decimal(lineItem.price)
        }
      })
      
      // 4. Deduct from inventory
      const newStock = variant.stock - lineItem.quantity
      await prisma.productVariation.update({
        where: { id: variant.id },
        data: { stock: Math.max(0, newStock) }
      })
      
      // 5. Aggregate parent stock
      await aggregateParentStock(variant.productId)
    }
    
    // 6. Log sync
    await logMarketplaceSync({
      productId: order.line_items[0].product_id,
      channel: 'SHOPIFY',
      lastSyncStatus: 'SUCCESS',
      lastSyncAt: new Date()
    })
    
  } catch (error) {
    console.error(`Failed to process Shopify order ${order.id}:`, error)
    throw error
  }
}

// Helper: Map Shopify status to Nexus status
function mapShopifyStatus(shopifyStatus: string): string {
  const statusMap: Record<string, string> = {
    'pending': 'PENDING',
    'fulfilled': 'FULFILLED',
    'cancelled': 'CANCELLED',
    'partial': 'PARTIAL'
  }
  
  return statusMap[shopifyStatus] || 'PENDING'
}
```

### 5.3 Fulfillment Tracking

```typescript
// When order is fulfilled in Nexus, update Shopify
async function updateShopifyFulfillment(
  orderId: string,
  trackingNumber: string,
  carrier: string = 'UPS'
) {
  // 1. Get order with Shopify mapping
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true }
  })
  
  if (!order) {
    throw new Error(`Order ${orderId} not found`)
  }
  
  const shopifyOrderId = order.amazonOrderId  // Shopify order ID stored here
  
  // 2. Get Shopify order details
  const shopifyOrder = await shopifyService.getOrder(shopifyOrderId)
  
  // 3. Create fulfillment in Shopify
  await shopifyService.createFulfillment(shopifyOrderId, {
    line_items_by_fulfillment_order: shopifyOrder.fulfillment_orders.map(fo => ({
      fulfillment_order_id: fo.id,
      fulfillment_order_line_items: fo.line_items.map(li => ({
        id: li.id,
        quantity: li.quantity
      }))
    })),
    tracking_info: {
      number: trackingNumber,
      company: carrier,
      url: generateTrackingUrl(carrier, trackingNumber)
    }
  })
  
  // 4. Update order status
  await prisma.order.update({
    where: { id: orderId },
    data: {
      status: 'FULFILLED',
      trackingNumber,
      shippedAt: new Date()
    }
  })
}

// Helper: Generate tracking URL
function generateTrackingUrl(carrier: string, trackingNumber: string): string {
  const urls: Record<string, string> = {
    'UPS': `https://www.ups.com/track?tracknum=${trackingNumber}`,
    'FedEx': `https://tracking.fedex.com/en/tracking/${trackingNumber}`,
    'USPS': `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
    'DHL': `https://www.dhl.com/en/en/express/tracking.html?AWB=${trackingNumber}`
  }
  
  return urls[carrier] || ''
}
```

---

## Part 6: Enhanced Shopify Service Implementation

### 6.1 Service Methods

```typescript
export class ShopifyService {
  private shopName: string
  private accessToken: string
  private apiVersion: string = '2024-01'
  private limiter: RateLimit
  
  constructor() {
    this.shopName = process.env.SHOPIFY_SHOP_NAME || ''
    this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN || ''
    
    if (!this.shopName || !this.accessToken) {
      throw new Error('Missing Shopify environment variables')
    }
    
    //