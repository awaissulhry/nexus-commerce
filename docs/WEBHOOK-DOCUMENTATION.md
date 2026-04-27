# Webhook Documentation

**Version**: 1.0.0  
**Last Updated**: 2026-04-23

---

## Table of Contents

1. [Overview](#overview)
2. [Webhook Security](#webhook-security)
3. [Shopify Webhooks](#shopify-webhooks)
4. [WooCommerce Webhooks](#woocommerce-webhooks)
5. [Etsy Webhooks](#etsy-webhooks)
6. [Webhook Delivery](#webhook-delivery)
7. [Error Handling](#error-handling)
8. [Testing Webhooks](#testing-webhooks)

---

## Overview

Webhooks allow marketplaces to notify your application of real-time events. This enables automatic synchronization of products, inventory, orders, and other data across channels.

### Webhook Flow

```
Marketplace Event → Webhook Payload → Your API Endpoint → Process & Update Database
```

### Webhook Characteristics

- **Real-time**: Events are delivered immediately
- **Asynchronous**: Your endpoint should respond quickly
- **Retryable**: Failed deliveries are retried
- **Signed**: Payloads are cryptographically signed for security

---

## Webhook Security

### Signature Verification

All webhooks include a signature that you must verify to ensure the payload came from the marketplace.

#### Shopify Signature Verification

Shopify uses HMAC-SHA256 signatures:

```typescript
import crypto from 'crypto';

function verifyShopifyWebhook(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('base64');
  
  return hmac === signature;
}

// Usage in Express middleware
app.post('/webhooks/shopify/products', (req, res) => {
  const signature = req.headers['x-shopify-hmac-sha256'] as string;
  const payload = req.rawBody; // Raw request body as string
  
  if (!verifyShopifyWebhook(payload, signature, process.env.SHOPIFY_WEBHOOK_SECRET!)) {
    return res.status(401).send('Unauthorized');
  }
  
  // Process webhook
  res.status(200).send('OK');
});
```

#### WooCommerce Signature Verification

WooCommerce uses HMAC-SHA256 with base64 encoding:

```typescript
function verifyWooCommerceWebhook(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('base64');
  
  return hmac === signature;
}

// Usage in Express middleware
app.post('/webhooks/woocommerce/products', (req, res) => {
  const signature = req.headers['x-wc-webhook-signature'] as string;
  const payload = req.rawBody;
  
  if (!verifyWooCommerceWebhook(payload, signature, process.env.WOOCOMMERCE_WEBHOOK_SECRET!)) {
    return res.status(401).send('Unauthorized');
  }
  
  // Process webhook
  res.status(200).send('OK');
});
```

#### Etsy Signature Verification

Etsy uses HMAC-SHA256 with hex encoding:

```typescript
function verifyEtsyWebhook(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');
  
  return hmac === signature;
}

// Usage in Express middleware
app.post('/webhooks/etsy/listings', (req, res) => {
  const signature = req.headers['x-etsy-webhook-signature'] as string;
  const payload = req.rawBody;
  
  if (!verifyEtsyWebhook(payload, signature, process.env.ETSY_WEBHOOK_SECRET!)) {
    return res.status(401).send('Unauthorized');
  }
  
  // Process webhook
  res.status(200).send('OK');
});
```

### Best Practices

1. **Always verify signatures** - Never trust unsigned webhooks
2. **Use HTTPS** - All webhook URLs must use HTTPS
3. **Rotate secrets** - Periodically rotate webhook secrets
4. **Log all webhooks** - Keep audit trail of all webhook events
5. **Idempotent processing** - Handle duplicate deliveries gracefully

---

## Shopify Webhooks

### Webhook Topics

#### Product Events

**Topic**: `products/create`
```json
{
  "id": 632910392,
  "title": "IPod Nano - 8GB",
  "handle": "ipod-nano-8gb",
  "vendor": "Apple",
  "product_type": "Portable Audio",
  "created_at": "2023-01-01T12:00:00-05:00",
  "updated_at": "2023-01-01T12:00:00-05:00",
  "published_at": "2023-01-01T12:00:00-05:00",
  "tags": "Portable, Audio",
  "status": "active",
  "variants": [
    {
      "id": 808950810,
      "product_id": 632910392,
      "title": "Black",
      "price": "199.99",
      "sku": "IPOD2008BLACK",
      "position": 1,
      "inventory_quantity": 10,
      "inventory_management": "shopify",
      "inventory_policy": "deny",
      "barcode": "1234567890",
      "compare_at_price": "249.99",
      "weight": 0.2,
      "weight_unit": "kg"
    }
  ],
  "images": [
    {
      "id": 850703190,
      "product_id": 632910392,
      "position": 1,
      "created_at": "2023-01-01T12:00:00-05:00",
      "updated_at": "2023-01-01T12:00:00-05:00",
      "alt": "Black iPod",
      "width": 1024,
      "height": 768,
      "src": "https://cdn.shopify.com/s/files/1/0006/9093/3384/products/ipod.jpg"
    }
  ]
}
```

**Topic**: `products/update`
```json
{
  "id": 632910392,
  "title": "IPod Nano - 8GB (Updated)",
  "handle": "ipod-nano-8gb",
  "vendor": "Apple",
  "product_type": "Portable Audio",
  "created_at": "2023-01-01T12:00:00-05:00",
  "updated_at": "2023-01-02T12:00:00-05:00",
  "published_at": "2023-01-01T12:00:00-05:00",
  "tags": "Portable, Audio, Updated",
  "status": "active",
  "variants": [
    {
      "id": 808950810,
      "product_id": 632910392,
      "title": "Black",
      "price": "189.99",
      "sku": "IPOD2008BLACK",
      "position": 1,
      "inventory_quantity": 15,
      "inventory_management": "shopify",
      "inventory_policy": "deny",
      "barcode": "1234567890",
      "compare_at_price": "239.99",
      "weight": 0.2,
      "weight_unit": "kg"
    }
  ]
}
```

**Topic**: `products/delete`
```json
{
  "id": 632910392,
  "title": "IPod Nano - 8GB",
  "handle": "ipod-nano-8gb",
  "vendor": "Apple",
  "product_type": "Portable Audio",
  "created_at": "2023-01-01T12:00:00-05:00",
  "updated_at": "2023-01-02T12:00:00-05:00",
  "published_at": "2023-01-01T12:00:00-05:00",
  "tags": "Portable, Audio",
  "status": "active"
}
```

#### Inventory Events

**Topic**: `inventory_levels/update`
```json
{
  "inventory_item_id": 808950810,
  "location_id": 905684977,
  "available": 15,
  "updated_at": "2023-01-02T12:00:00-05:00"
}
```

#### Order Events

**Topic**: `orders/create`
```json
{
  "id": 1234567890,
  "email": "john@example.com",
  "created_at": "2023-01-02T12:00:00-05:00",
  "updated_at": "2023-01-02T12:00:00-05:00",
  "number": 1001,
  "note": "Customer note",
  "token": "abc123",
  "gateway": "bogus",
  "test": false,
  "total_price": "199.99",
  "subtotal_price": "199.99",
  "total_weight": 0,
  "currency": "USD",
  "financial_status": "authorized",
  "fulfillment_status": "unshipped",
  "line_items": [
    {
      "id": 1234567890,
      "variant_id": 808950810,
      "title": "IPod Nano - 8GB",
      "quantity": 1,
      "sku": "IPOD2008BLACK",
      "variant_title": "Black",
      "vendor": "Apple",
      "fulfillment_service": "manual",
      "product_id": 632910392,
      "requires_shipping": true,
      "taxable": true,
      "gift_card": false,
      "name": "IPod Nano - 8GB - Black",
      "variant_inventory_management": "shopify",
      "properties": [],
      "product_exists": true,
      "fulfillment_status": "unshipped",
      "grams": 200,
      "price": "199.99",
      "total_discount": "0.00"
    }
  ]
}
```

### Processing Shopify Webhooks

```typescript
import { Router } from 'express';
import { ShopifyService } from '../services/marketplaces/shopify.service';

const router = Router();
const shopifyService = new ShopifyService();

// Product Update Handler
router.post('/webhooks/shopify/products', async (req, res) => {
  try {
    const product = req.body;
    
    // Update product in database
    await db.product.upsert({
      where: { shopifyId: product.id },
      update: {
        title: product.title,
        description: product.body_html,
        vendor: product.vendor,
        productType: product.product_type,
        tags: product.tags,
        images: product.images,
        variants: product.variants,
        lastSyncedAt: new Date(),
      },
      create: {
        shopifyId: product.id,
        title: product.title,
        description: product.body_html,
        vendor: product.vendor,
        productType: product.product_type,
        tags: product.tags,
        images: product.images,
        variants: product.variants,
        channel: 'SHOPIFY',
      },
    });
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing Shopify product webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Inventory Update Handler
router.post('/webhooks/shopify/inventory', async (req, res) => {
  try {
    const { inventory_item_id, location_id, available } = req.body;
    
    // Update inventory in database
    await db.inventory.update({
      where: { shopifyInventoryItemId: inventory_item_id },
      data: {
        quantity: available,
        lastSyncedAt: new Date(),
      },
    });
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing Shopify inventory webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Order Update Handler
router.post('/webhooks/shopify/orders', async (req, res) => {
  try {
    const order = req.body;
    
    // Update order in database
    await db.order.upsert({
      where: { shopifyOrderId: order.id },
      update: {
        status: order.financial_status,
        fulfillmentStatus: order.fulfillment_status,
        totalPrice: parseFloat(order.total_price),
        lineItems: order.line_items,
        lastSyncedAt: new Date(),
      },
      create: {
        shopifyOrderId: order.id,
        orderNumber: order.number,
        email: order.email,
        status: order.financial_status,
        fulfillmentStatus: order.fulfillment_status,
        totalPrice: parseFloat(order.total_price),
        lineItems: order.line_items,
        channel: 'SHOPIFY',
      },
    });
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing Shopify order webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
```

---

## WooCommerce Webhooks

### Webhook Topics

#### Product Events

**Topic**: `product.created`
```json
{
  "id": 794,
  "name": "Beanie with Logo",
  "slug": "beanie-with-logo",
  "type": "simple",
  "status": "publish",
  "description": "<p>This is a simple product.</p>",
  "short_description": "<p>A simple beanie</p>",
  "sku": "BEANIE-LOGO",
  "price": "18.00",
  "regular_price": "18.00",
  "sale_price": "",
  "date_created": "2023-01-01T12:00:00",
  "date_modified": "2023-01-01T12:00:00",
  "parent_id": 0,
  "images": [
    {
      "id": 1234,
      "src": "https://example.com/wp-content/uploads/2023/01/beanie.jpg",
      "alt": "Beanie with Logo"
    }
  ]
}
```

**Topic**: `product.updated`
```json
{
  "id": 794,
  "name": "Beanie with Logo (Updated)",
  "slug": "beanie-with-logo",
  "type": "simple",
  "status": "publish",
  "description": "<p>Updated description</p>",
  "short_description": "<p>A simple beanie</p>",
  "sku": "BEANIE-LOGO",
  "price": "19.99",
  "regular_price": "19.99",
  "sale_price": "",
  "date_created": "2023-01-01T12:00:00",
  "date_modified": "2023-01-02T12:00:00",
  "parent_id": 0
}
```

**Topic**: `product.deleted`
```json
{
  "id": 794,
  "name": "Beanie with Logo",
  "slug": "beanie-with-logo",
  "type": "simple",
  "status": "trash"
}
```

#### Order Events

**Topic**: `order.created`
```json
{
  "id": 12345,
  "number": "12345",
  "status": "processing",
  "date_created": "2023-01-01T12:00:00",
  "date_modified": "2023-01-01T12:00:00",
  "total": "100.00",
  "total_tax": "10.00",
  "shipping_total": "5.00",
  "currency": "USD",
  "billing": {
    "first_name": "John",
    "last_name": "Doe",
    "email": "john@example.com",
    "phone": "555-1234",
    "address_1": "123 Main St",
    "city": "New York",
    "state": "NY",
    "postcode": "10001",
    "country": "US"
  },
  "line_items": [
    {
      "id": 1,
      "product_id": 794,
      "variation_id": 1234,
      "quantity": 2,
      "subtotal": "36.00",
      "total": "36.00",
      "sku": "BEANIE-LOGO"
    }
  ]
}
```

### Processing WooCommerce Webhooks

```typescript
import { Router } from 'express';

const router = Router();

// Product Update Handler
router.post('/webhooks/woocommerce/products', async (req, res) => {
  try {
    const product = req.body;
    
    // Update product in database
    await db.product.upsert({
      where: { woocommerceId: product.id },
      update: {
        title: product.name,
        description: product.description,
        shortDescription: product.short_description,
        sku: product.sku,
        price: parseFloat(product.price),
        regularPrice: parseFloat(product.regular_price),
        salePrice: product.sale_price ? parseFloat(product.sale_price) : null,
        images: product.images,
        lastSyncedAt: new Date(),
      },
      create: {
        woocommerceId: product.id,
        title: product.name,
        description: product.description,
        shortDescription: product.short_description,
        sku: product.sku,
        price: parseFloat(product.price),
        regularPrice: parseFloat(product.regular_price),
        salePrice: product.sale_price ? parseFloat(product.sale_price) : null,
        images: product.images,
        channel: 'WOOCOMMERCE',
      },
    });
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing WooCommerce product webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Order Update Handler
router.post('/webhooks/woocommerce/orders', async (req, res) => {
  try {
    const order = req.body;
    
    // Update order in database
    await db.order.upsert({
      where: { woocommerceOrderId: order.id },
      update: {
        orderNumber: order.number,
        status: order.status,
        totalPrice: parseFloat(order.total),
        totalTax: parseFloat(order.total_tax),
        shippingTotal: parseFloat(order.shipping_total),
        lineItems: order.line_items,
        lastSyncedAt: new Date(),
      },
      create: {
        woocommerceOrderId: order.id,
        orderNumber: order.number,
        status: order.status,
        totalPrice: parseFloat(order.total),
        totalTax: parseFloat(order.total_tax),
        shippingTotal: parseFloat(order.shipping_total),
        lineItems: order.line_items,
        channel: 'WOOCOMMERCE',
      },
    });
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing WooCommerce order webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
```

---

## Etsy Webhooks

### Webhook Topics

#### Listing Events

**Topic**: `listing.created`
```json
{
  "listing_id": 1234567890,
  "user_id": 123456,
  "shop_id": 654321,
  "title": "Handmade Ceramic Mug",
  "description": "Beautiful handmade ceramic mug",
  "state": "active",
  "creation_tsz": 1609459200,
  "price": "25.00",
  "currency_code": "USD",
  "quantity": 10,
  "sku": "MUG-CERAMIC-001",
  "tags": ["handmade", "ceramic", "mug"],
  "category_id": 69150473,
  "images": [
    {
      "listing_image_id": 1234567890,
      "url_570xN": "https://i.etsystatic.com/image.jpg",
      "is_primary": true
    }
  ],
  "has_variations": false,
  "should_auto_renew": true,
  "is_supply": false,
  "non_taxable": false
}
```

**Topic**: `listing.updated`
```json
{
  "listing_id": 1234567890,
  "user_id": 123456,
  "shop_id": 654321,
  "title": "Handmade Ceramic Mug (Updated)",
  "description": "Beautiful handmade ceramic mug with custom design",
  "state": "active",
  "creation_tsz": 1609459200,
  "price": "29.99",
  "currency_code": "USD",
  "quantity": 15,
  "sku": "MUG-CERAMIC-001",
  "tags": ["handmade", "ceramic", "mug", "custom"],
  "category_id": 69150473,
  "has_variations": false,
  "should_auto_renew": true,
  "is_supply": false,
  "non_taxable": false
}
```

**Topic**: `inventory.updated`
```json
{
  "listing_id": 1234567890,
  "products": [
    {
      "product_id": 1234567890,
      "sku": "MUG-CERAMIC-001",
      "offerings": [
        {
          "offering_id": 1234567890,
          "quantity": 15,
          "price": 29.99
        }
      ]
    }
  ]
}
```

#### Order Events

**Topic**: `order.created`
```json
{
  "order_id": 1234567890,
  "receipt_id": 1234567890,
  "seller_user_id": 123456,
  "buyer_user_id": 654321,
  "status": "completed",
  "creation_tsz": 1609459200,
  "last_modified_tsz": 1609545600,
  "total_price": 50.00,
  "total_shipping_cost": 5.00,
  "total_tax_cost": 0.00,
  "currency_code": "USD",
  "transactions": [
    {
      "transaction_id": 1234567890,
      "listing_id": 1234567890,
      "product_id": 1234567890,
      "sku": "MUG-CERAMIC-001",
      "quantity": 2,
      "price": 25.00,
      "creation_tsz": 1609459200
    }
  ]
}
```

### Processing Etsy Webhooks

```typescript
import { Router } from 'express';

const router = Router();

// Listing Update Handler
router.post('/webhooks/etsy/listings', async (req, res) => {
  try {
    const listing = req.body;
    
    // Update listing in database
    await db.product.upsert({
      where: { etsyListingId: listing.listing_id },
      update: {
        title: listing.title,
        description: listing.description,
        sku: listing.sku,
        price: parseFloat(listing.price),
        quantity: listing.quantity,
        tags: listing.tags,
        images: listing.images,
        lastSyncedAt: new Date(),
      },
      create: {
        etsyListingId: listing.listing_id,
        title: listing.title,
        description: listing.description,
        sku: listing.sku,
        price: parseFloat(listing.price),
        quantity: listing.quantity,
        tags: listing.tags,
        images: listing.images,
        channel: 'ETSY',
      },
    });
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing Etsy listing webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Inventory Update Handler
router.post('/webhooks/etsy/inventory', async (req, res) => {
  try {
    const { listing_id, products } = req.body;
    
    // Update inventory in database
    for (const product of products) {
      for (const offering of product.offerings) {
        await db.inventory.update({
          where: { etsyOfferingId: offering.offering_id },
          data: {
            quantity: offering.quantity,
            price: offering.price,
            lastSyncedAt: new Date(),
          },
        });
      }
    }
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing Etsy inventory webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Order Update Handler
router.post('/webhooks/etsy/orders', async (req, res) => {
  try {
    const order = req.body;
    
    // Update order in database
    await db.order.upsert({
      where: { etsyOrderId: order.order_id },
      update: {
        status: order.status,
        totalPrice: order.total_price,
        totalShippingCost: order.total_shipping_cost,
        totalTaxCost: order.total_tax_cost,
        transactions: order.transactions,
        lastSyncedAt: new Date(),
      },
      create: {
        etsyOrderId: order.order_id,
        status: order.status,
        totalPrice: order.total_price,
        totalShippingCost: order.total_shipping_cost,
        totalTaxCost: order.total_tax_cost,
        transactions: order.transactions,
        channel: 'ETSY',
      },
    });
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing Etsy order webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
```

---

## Webhook Delivery

### Delivery Guarantees

- **At-least-once delivery**: Webhooks may be delivered multiple times
- **Ordered delivery**: Events are delivered in order per resource
- **Timeout**: Endpoints must respond within 30 seconds
- **Retries**: Failed deliveries are retried with exponential backoff

### Retry Policy

| Attempt | Delay | Total Time |
|---------|-------|-----------|
| 1st | Immediate | 0s |
| 2nd | 5 minutes | 5m |
| 3rd | 30 minutes | 35m |
| 4th | 2 hours | 2h 35m |
| 5th | 5 hours | 7h 35m |

### Webhook Response Requirements

Your endpoint must:

1. **Respond quickly** (within 30 seconds)
2. **Return 2xx status code** for successful processing
3. **Return 4xx status code** for invalid payloads (won't retry)
4. **Return 5xx status code** for temporary errors (will retry)

```typescript
// Good: Respond immediately, process asynchronously
app.post('/webhooks/shopify/products', async (req, res) => {
  // Queue the webhook for processing
  await webhookQueue.add({
    type: 'shopify.product.update',
    payload: req.body,
  });
  
  // Respond immediately
  res.status(200).json({ success: true });
});

// Bad: Process synchronously, may timeout
app.post('/webhooks/shopify/products', async (req, res) => {
  // This may take too long
  await processProductUpdate(req.body);
  res.status(200).json({ success: true });
});
```

---

## Error Handling

### Idempotent Processing

Since webhooks may be delivered multiple times, ensure your processing is idempotent:

```typescript
// Good: Upsert operation is idempotent
await db.product.upsert({
  where: { shopifyId: product.id },
  update: { /* ... */ },
  create: { /* ... */ },
});

// Bad: Insert may fail on duplicate
await db.product.create({
  data: { shopifyId: product.id, /* ... */ },
});
```

### Webhook Logging

Log all webhook events for debugging:

```typescript
async function logWebhook(
  marketplace: string,
  topic: string,
  payload: any,
  signature: string,
  verified: boolean
) {
  await db.webhookLog.create({
    data: {
      marketplace,
      topic,
      payload: JSON.stringify(payload),
      signature,
      verified,
      receivedAt: new Date(),
    },
  });
}
```

### Error Recovery

Implement dead-letter queues for failed webhooks:

```typescript
async function processWebhookWithRetry(
  webhook: WebhookPayload,
  maxRetries: number = 3
) {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await processWebhook(webhook);
      return;
    } catch (error) {
      lastError = error as Error;
      
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  // Move to dead-letter queue
  await db.deadLetterQueue.create({
    data: {
      webhook: JSON.stringify(webhook),
      error: lastError?.message,
      failedAt: new Date(),
    },
  });
}
```

---

## Testing Webhooks

### Manual Testing

Use curl to test webhook endpoints:

```bash
# Test Shopify webhook
curl -X POST http://localhost:3001/webhooks/shopify/products \
  -H "Content-Type: application/json" \
  -H "X-Shopify-HMAC-SHA256: $(echo -n '{...}' | openssl dgst -sha256 -hmac 'secret' -binary | base64)" \
  -d '{
    "id": 632910392,
    "title": "Test Product",
    "handle": "test-product",
    "vendor": "Test Vendor",
    "product_type": "Test",
    "created_at": "2023-01-01T12:00:00-05:00",
    "updated_at": "2023-01-01T12:00:00-05:00",
    "published_at": "2023-01-01T12:00:00-05: