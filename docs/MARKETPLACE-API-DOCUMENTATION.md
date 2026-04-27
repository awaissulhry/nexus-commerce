# Marketplace Integration API Documentation

**Version**: 1.0.0  
**Last Updated**: 2026-04-23  
**Status**: Production Ready

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Shopify API](#shopify-api)
4. [WooCommerce API](#woocommerce-api)
5. [Etsy API](#etsy-api)
6. [Unified Marketplace API](#unified-marketplace-api)
7. [Error Handling](#error-handling)
8. [Rate Limiting](#rate-limiting)
9. [Webhooks](#webhooks)

---

## Overview

The Nexus Commerce marketplace integration provides a unified interface for managing products, inventory, and pricing across multiple e-commerce platforms:

- **Shopify** - GraphQL-based API
- **WooCommerce** - REST API
- **Etsy** - REST API
- **Amazon** - SP-API
- **eBay** - REST API

### Base URLs

```
Shopify:      https://{shop-name}.myshopify.com/admin/api/{version}
WooCommerce:  https://{store-url}/wp-json/wc/v3
Etsy:         https://openapi.etsy.com/v3
Amazon:       https://sellingpartnerapi-{region}.amazon.com
eBay:         https://api.ebay.com
```

---

## Authentication

### Shopify Authentication

**Type**: OAuth 2.0 with Access Token

```bash
# Environment Variables Required
SHOPIFY_SHOP_NAME=your-shop-name
SHOPIFY_ACCESS_TOKEN=your-access-token
SHOPIFY_WEBHOOK_SECRET=your-webhook-secret
```

**Header Format**:
```
X-Shopify-Access-Token: {access_token}
```

**Token Refresh**: Shopify tokens don't expire but should be rotated periodically for security.

### WooCommerce Authentication

**Type**: Basic Auth with Consumer Key/Secret

```bash
# Environment Variables Required
WOOCOMMERCE_STORE_URL=https://your-store.com
WOOCOMMERCE_CONSUMER_KEY=your-consumer-key
WOOCOMMERCE_CONSUMER_SECRET=your-consumer-secret
WOOCOMMERCE_WEBHOOK_SECRET=your-webhook-secret
```

**Header Format**:
```
Authorization: Basic {base64(consumer_key:consumer_secret)}
```

### Etsy Authentication

**Type**: OAuth 2.0 with Access Token and Refresh Token

```bash
# Environment Variables Required
ETSY_SHOP_ID=your-shop-id
ETSY_API_KEY=your-api-key
ETSY_ACCESS_TOKEN=your-access-token
ETSY_REFRESH_TOKEN=your-refresh-token
ETSY_WEBHOOK_SECRET=your-webhook-secret
```

**Header Format**:
```
Authorization: Bearer {access_token}
x-api-key: {api_key}
```

**Token Refresh**: Etsy tokens expire after 3600 seconds. Implement automatic refresh using the refresh token.

---

## Shopify API

### Products

#### Get Product
```bash
GET /products/{product_id}.json
```

**Response**:
```json
{
  "product": {
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
}
```

#### Update Product
```bash
PUT /products/{product_id}.json
```

**Request Body**:
```json
{
  "product": {
    "title": "Updated Product Title",
    "vendor": "New Vendor",
    "product_type": "New Type",
    "tags": "tag1, tag2"
  }
}
```

### Variants

#### Update Variant Price
```bash
PUT /variants/{variant_id}.json
```

**Request Body**:
```json
{
  "variant": {
    "price": "29.99",
    "compare_at_price": "39.99"
  }
}
```

#### Update Inventory
```bash
POST /inventory_levels/adjust.json
```

**Request Body**:
```json
{
  "inventory_item_id": 808950810,
  "available_adjustment": 5,
  "location_id": 905684977
}
```

### GraphQL API

Shopify also supports GraphQL for more complex queries:

```graphql
query {
  products(first: 10) {
    edges {
      node {
        id
        title
        handle
        variants(first: 10) {
          edges {
            node {
              id
              title
              price
              sku
            }
          }
        }
      }
    }
  }
}
```

---

## WooCommerce API

### Products

#### Get Product
```bash
GET /products/{product_id}
```

**Response**:
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
  ],
  "attributes": [
    {
      "id": 1,
      "name": "Color",
      "options": ["Red", "Blue", "Green"]
    }
  ]
}
```

#### Create Product
```bash
POST /products
```

**Request Body**:
```json
{
  "name": "New Product",
  "type": "simple",
  "status": "publish",
  "description": "Product description",
  "short_description": "Short description",
  "sku": "NEW-PRODUCT-001",
  "price": "29.99",
  "regular_price": "29.99",
  "images": [
    {
      "src": "https://example.com/image.jpg",
      "alt": "Product Image"
    }
  ]
}
```

### Variations

#### Get Variation
```bash
GET /products/{product_id}/variations/{variation_id}
```

**Response**:
```json
{
  "id": 1234,
  "product_id": 794,
  "sku": "BEANIE-RED",
  "price": "18.00",
  "regular_price": "18.00",
  "sale_price": "",
  "stock_quantity": 50,
  "stock_status": "instock",
  "attributes": [
    {
      "id": 1,
      "name": "Color",
      "option": "Red"
    }
  ]
}
```

#### Update Variation
```bash
PUT /products/{product_id}/variations/{variation_id}
```

**Request Body**:
```json
{
  "price": "19.99",
  "stock_quantity": 45,
  "stock_status": "instock"
}
```

### Orders

#### Get Order
```bash
GET /orders/{order_id}
```

**Response**:
```json
{
  "id": 12345,
  "number": "12345",
  "status": "processing",
  "date_created": "2023-01-01T12:00:00",
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
      "sku": "BEANIE-RED"
    }
  ]
}
```

---

## Etsy API

### Listings

#### Get Listing
```bash
GET /listings/{listing_id}
```

**Response**:
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

#### Create Listing
```bash
POST /listings
```

**Request Body**:
```json
{
  "quantity": 10,
  "title": "Handmade Ceramic Mug",
  "description": "Beautiful handmade ceramic mug",
  "price": 25.00,
  "currency_code": "USD",
  "category_id": 69150473,
  "tags": ["handmade", "ceramic", "mug"],
  "who_made": "i_did",
  "when_made": "2020_2023",
  "is_supply": false,
  "is_personalizable": false,
  "should_auto_renew": true
}
```

#### Update Listing
```bash
PATCH /listings/{listing_id}
```

**Request Body**:
```json
{
  "title": "Updated Title",
  "description": "Updated description",
  "price": 29.99,
  "quantity": 15
}
```

### Inventory

#### Get Inventory
```bash
GET /listings/{listing_id}/inventory
```

**Response**:
```json
{
  "listing_id": 1234567890,
  "products": [
    {
      "product_id": 1234567890,
      "sku": "MUG-CERAMIC-001",
      "property_values": [
        {
          "property_id": 200,
          "value_id": 1234,
          "values": ["Red"]
        }
      ],
      "offerings": [
        {
          "offering_id": 1234567890,
          "quantity": 10,
          "is_deleted": false,
          "price": 25.00
        }
      ]
    }
  ]
}
```

#### Update Inventory
```bash
PUT /listings/{listing_id}/inventory
```

**Request Body**:
```json
{
  "products": [
    {
      "product_id": 1234567890,
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

### Orders

#### Get Order
```bash
GET /orders/{order_id}
```

**Response**:
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

---

## Unified Marketplace API

### Health Check

#### Get Marketplace Health Status
```bash
GET /marketplaces/health
```

**Response**:
```json
{
  "success": true,
  "statuses": [
    {
      "channel": "SHOPIFY",
      "isAvailable": true,
      "lastChecked": "2026-04-23T08:20:00Z",
      "responseTime": 45
    },
    {
      "channel": "WOOCOMMERCE",
      "isAvailable": true,
      "lastChecked": "2026-04-23T08:20:00Z",
      "responseTime": 120
    },
    {
      "channel": "ETSY",
      "isAvailable": true,
      "lastChecked": "2026-04-23T08:20:00Z",
      "responseTime": 85
    }
  ],
  "timestamp": "2026-04-23T08:20:00Z"
}
```

### Product Sync

#### Sync Product Across Channels
```bash
POST /marketplaces/products/{productId}/sync
```

**Request Body**:
```json
{
  "channels": ["SHOPIFY", "WOOCOMMERCE", "ETSY"]
}
```

**Response**:
```json
{
  "success": true,
  "productId": "prod_123",
  "summary": {
    "total": 3,
    "successful": 3,
    "failed": 0
  },
  "results": [
    {
      "channel": "SHOPIFY",
      "success": true,
      "message": "Product synced to SHOPIFY",
      "timestamp": "2026-04-23T08:20:00Z"
    },
    {
      "channel": "WOOCOMMERCE",
      "success": true,
      "message": "Product synced to WOOCOMMERCE",
      "timestamp": "2026-04-23T08:20:00Z"
    },
    {
      "channel": "ETSY",
      "success": true,
      "message": "Product synced to ETSY",
      "timestamp": "2026-04-23T08:20:00Z"
    }
  ]
}
```

### Price Updates

#### Update Prices Across Channels
```bash
POST /marketplaces/prices/update
```

**Request Body**:
```json
{
  "updates": [
    {
      "channel": "SHOPIFY",
      "channelVariantId": "gid://shopify/ProductVariant/123",
      "price": 29.99
    },
    {
      "channel": "WOOCOMMERCE",
      "channelVariantId": "456",
      "channelProductId": "789",
      "price": 29.99
    },
    {
      "channel": "ETSY",
      "channelVariantId": "111",
      "channelProductId": "222",
      "price": 29.99
    }
  ]
}
```

**Response**:
```json
{
  "success": true,
  "summary": {
    "total": 3,
    "successful": 3,
    "failed": 0
  },
  "results": [
    {
      "channel": "SHOPIFY",
      "success": true,
      "variantId": "gid://shopify/ProductVariant/123",
      "newPrice": 29.99
    },
    {
      "channel": "WOOCOMMERCE",
      "success": true,
      "variantId": "456",
      "newPrice": 29.99
    },
    {
      "channel": "ETSY",
      "success": true,
      "variantId": "111",
      "newPrice": 29.99
    }
  ]
}
```

### Inventory Updates

#### Update Inventory Across Channels
```bash
POST /marketplaces/inventory/update
```

**Request Body**:
```json
{
  "updates": [
    {
      "channel": "SHOPIFY",
      "channelVariantId": "gid://shopify/ProductVariant/123",
      "quantity": 50
    },
    {
      "channel": "WOOCOMMERCE",
      "channelVariantId": "456",
      "channelProductId": "789",
      "quantity": 50
    },
    {
      "channel": "ETSY",
      "channelVariantId": "111",
      "channelProductId": "222",
      "quantity": 50
    }
  ]
}
```

**Response**:
```json
{
  "success": true,
  "summary": {
    "total": 3,
    "successful": 3,
    "failed": 0
  },
  "results": [
    {
      "channel": "SHOPIFY",
      "success": true,
      "variantId": "gid://shopify/ProductVariant/123",
      "newQuantity": 50
    },
    {
      "channel": "WOOCOMMERCE",
      "success": true,
      "variantId": "456",
      "newQuantity": 50
    },
    {
      "channel": "ETSY",
      "success": true,
      "variantId": "111",
      "newQuantity": 50
    }
  ]
}
```

---

## Error Handling

### Error Response Format

All errors follow a consistent format:

```json
{
  "success": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid request parameters",
    "details": {
      "field": "price",
      "issue": "Price must be greater than 0"
    }
  },
  "timestamp": "2026-04-23T08:20:00Z"
}
```

### Common Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `INVALID_REQUEST` | 400 | Invalid request parameters |
| `UNAUTHORIZED` | 401 | Missing or invalid authentication |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Resource not found |
| `CONFLICT` | 409 | Resource conflict (e.g., duplicate SKU) |
| `RATE_LIMIT_EXCEEDED` | 429 | Rate limit exceeded |
| `MARKETPLACE_ERROR` | 502 | Marketplace API error |
| `INTERNAL_ERROR` | 500 | Internal server error |

### Marketplace-Specific Errors

#### Shopify Errors
- `SHOPIFY_INVALID_PRODUCT` - Product not found in Shopify
- `SHOPIFY_INVALID_VARIANT` - Variant not found in Shopify
- `SHOPIFY_INVENTORY_ERROR` - Inventory update failed
- `SHOPIFY_RATE_LIMIT` - Shopify rate limit exceeded

#### WooCommerce Errors
- `WOOCOMMERCE_INVALID_PRODUCT` - Product not found in WooCommerce
- `WOOCOMMERCE_INVALID_VARIATION` - Variation not found in WooCommerce
- `WOOCOMMERCE_STOCK_ERROR` - Stock update failed
- `WOOCOMMERCE_AUTH_ERROR` - Authentication failed

#### Etsy Errors
- `ETSY_INVALID_LISTING` - Listing not found in Etsy
- `ETSY_INVENTORY_ERROR` - Inventory update failed
- `ETSY_TOKEN_EXPIRED` - Access token expired
- `ETSY_RATE_LIMIT` - Etsy rate limit exceeded

---

## Rate Limiting

### Rate Limits by Marketplace

| Marketplace | Requests/Minute | Requests/Hour | Burst |
|-------------|-----------------|---------------|-------|
| Shopify | 2 | 120 | 40 |
| WooCommerce | 10 | 600 | 100 |
| Etsy | 10 | 600 | 50 |
| Amazon | 15 | 900 | 100 |
| eBay | 5 | 300 | 25 |

### Rate Limit Headers

```
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 119
X-RateLimit-Reset: 1609459260
```

### Handling Rate Limits

When rate limited, the API returns a 429 status code with retry information:

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded",
    "retryAfter": 60
  }
}
```

**Recommended Retry Strategy**:
1. Wait for the time specified in `retryAfter` header
2. Implement exponential backoff for subsequent retries
3. Use batch operations to reduce request count

---

## Webhooks

See [WEBHOOK-DOCUMENTATION.md](./WEBHOOK-DOCUMENTATION.md) for detailed webhook information.

---

## Support

For API support and issues:
- **Documentation**: https://docs.nexus-commerce.com
- **Status Page**: https://status.nexus-commerce.com
- **Email**: api-support@nexus-commerce.com
- **Slack**: #marketplace-integrations

---

**Last Updated**: 2026-04-23  
**Version**: 1.0.0
