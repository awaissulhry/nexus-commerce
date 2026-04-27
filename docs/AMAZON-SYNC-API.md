# Amazon Sync API Documentation

## Overview

The Amazon Sync API provides endpoints for synchronizing product catalogs between your inventory management system and Amazon Seller Central. This document describes all available endpoints, request/response formats, and error handling.

## Base URL

```
http://localhost:3001/api
```

## Authentication

All endpoints require proper authentication. Include your API credentials in the request headers.

## Endpoints

### 1. Trigger Amazon Catalog Sync

**Endpoint:** `POST /sync/amazon/catalog`

**Description:** Initiates a new Amazon catalog synchronization with the provided products.

**Request Body:**

```json
{
  "products": [
    {
      "asin": "B0123456789",
      "parentAsin": "B0123456780",
      "title": "Product Name",
      "sku": "SKU-001",
      "price": 29.99,
      "stock": 100,
      "fulfillmentChannel": "FBA",
      "shippingTemplate": "Standard Shipping"
    }
  ]
}
```

**Request Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| products | Array | Yes | Array of products to sync |
| products[].asin | String | Yes | Amazon Standard Identification Number |
| products[].parentAsin | String | No | Parent ASIN for variations |
| products[].title | String | Yes | Product title |
| products[].sku | String | Yes | Stock Keeping Unit |
| products[].price | Number | No | Product price |
| products[].stock | Number | No | Available stock quantity |
| products[].fulfillmentChannel | String | No | FBA or FBM (default: FBA) |
| products[].shippingTemplate | String | No | Shipping template name |

**Response (Success - 200):**

```json
{
  "success": true,
  "data": {
    "syncId": "sync-1713960000000-abc123def",
    "status": "success",
    "statistics": {
      "totalProcessed": 50,
      "parentsCreated": 5,
      "childrenCreated": 40,
      "parentsUpdated": 3,
      "childrenUpdated": 2,
      "errorCount": 0
    },
    "duration": 2500,
    "errors": []
  }
}
```

**Response (Validation Error - 400):**

```json
{
  "success": false,
  "error": "Product validation failed",
  "validationErrors": [
    {
      "sku": "SKU-001",
      "errors": ["Missing ASIN", "Missing title"]
    }
  ]
}
```

**Response (Server Error - 500):**

```json
{
  "success": false,
  "error": "Sync operation failed: Database connection error"
}
```

---

### 2. Get Sync Status

**Endpoint:** `GET /sync/amazon/catalog/:syncId`

**Description:** Retrieves the current status of a sync operation by ID.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| syncId | String | Yes | The sync operation ID |

**Response (Success - 200):**

```json
{
  "success": true,
  "data": {
    "syncId": "sync-1713960000000-abc123def",
    "status": "success",
    "totalItems": 50,
    "successCount": 50,
    "failureCount": 0,
    "duration": 2500,
    "startTime": "2026-04-24T09:30:00.000Z",
    "endTime": "2026-04-24T09:30:02.500Z",
    "details": {
      "parentsCreated": 5,
      "childrenCreated": 40,
      "parentsUpdated": 3,
      "childrenUpdated": 2,
      "errors": []
    }
  }
}
```

**Response (Not Found - 404):**

```json
{
  "success": false,
  "error": "Sync with ID sync-1713960000000-abc123def not found"
}
```

---

### 3. Retry Failed Sync

**Endpoint:** `POST /sync/amazon/catalog/:syncId/retry`

**Description:** Retries a failed or partially failed sync operation.

**Path Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| syncId | String | Yes | The sync operation ID to retry |

**Response (Success - 202):**

```json
{
  "success": true,
  "message": "Retry initiated",
  "data": {
    "syncId": "sync-1713960000000-abc123def",
    "retryCount": 5
  }
}
```

**Response (Invalid State - 400):**

```json
{
  "success": false,
  "error": "Cannot retry a successful sync"
}
```

---

### 4. Get Sync History

**Endpoint:** `GET /sync/amazon/catalog/history`

**Description:** Retrieves a paginated list of recent sync operations.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | Number | 10 | Maximum number of results (max: 100) |
| offset | Number | 0 | Number of results to skip |

**Response (Success - 200):**

```json
{
  "success": true,
  "data": {
    "syncs": [
      {
        "syncId": "sync-1713960000000-abc123def",
        "status": "success",
        "totalItems": 50,
        "successCount": 50,
        "failureCount": 0,
        "duration": 2500,
        "startTime": "2026-04-24T09:30:00.000Z"
      }
    ],
    "total": 150,
    "limit": 10,
    "offset": 0
  }
}
```

---

## Status Values

| Status | Description |
|--------|-------------|
| `success` | All items synced without errors |
| `partial` | Some items synced, but some failed |
| `failed` | Sync operation failed completely |
| `pending` | Sync is queued and waiting to start |
| `processing` | Sync is currently running |

## Error Handling

### Common Error Codes

| Code | Status | Description |
|------|--------|-------------|
| 400 | Bad Request | Invalid request body or parameters |
| 404 | Not Found | Sync ID not found |
| 500 | Server Error | Internal server error |

### Error Response Format

```json
{
  "success": false,
  "error": "Error message describing what went wrong"
}
```

## Rate Limiting

- **Limit:** 100 requests per minute per API key
- **Headers:** Include `X-RateLimit-Remaining` and `X-RateLimit-Reset` in responses

## Best Practices

1. **Batch Processing:** Send products in batches of 100-500 for optimal performance
2. **Error Handling:** Always check the `success` field and handle errors gracefully
3. **Polling:** When polling for sync status, use exponential backoff (2s, 4s, 8s, etc.)
4. **Validation:** Validate products locally before sending to reduce errors
5. **Retry Logic:** Implement exponential backoff for retries (max 3 attempts)

## Example Usage

### JavaScript/Node.js

```javascript
// Trigger sync
const response = await fetch('http://localhost:3001/api/sync/amazon/catalog', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    products: [
      {
        asin: 'B0123456789',
        title: 'Product Name',
        sku: 'SKU-001',
        price: 29.99,
        stock: 100,
      },
    ],
  }),
});

const result = await response.json();
const syncId = result.data.syncId;

// Poll for status
const pollStatus = async () => {
  const statusResponse = await fetch(
    `http://localhost:3001/api/sync/amazon/catalog/${syncId}`
  );
  const status = await statusResponse.json();
  
  if (status.data.status === 'success' || status.data.status === 'failed') {
    console.log('Sync completed:', status.data);
  } else {
    setTimeout(pollStatus, 2000);
  }
};

pollStatus();
```

### cURL

```bash
# Trigger sync
curl -X POST http://localhost:3001/api/sync/amazon/catalog \
  -H "Content-Type: application/json" \
  -d '{
    "products": [
      {
        "asin": "B0123456789",
        "title": "Product Name",
        "sku": "SKU-001",
        "price": 29.99,
        "stock": 100
      }
    ]
  }'

# Get sync status
curl http://localhost:3001/api/sync/amazon/catalog/sync-1713960000000-abc123def

# Get sync history
curl "http://localhost:3001/api/sync/amazon/catalog/history?limit=10&offset=0"
```

## Webhook Events (Future)

The following webhook events will be available in future versions:

- `sync.started` - Sync operation started
- `sync.completed` - Sync operation completed
- `sync.failed` - Sync operation failed
- `sync.item_error` - Individual item failed during sync

## Support

For issues or questions, please refer to the [Troubleshooting Guide](./AMAZON-SYNC-TROUBLESHOOTING.md).
