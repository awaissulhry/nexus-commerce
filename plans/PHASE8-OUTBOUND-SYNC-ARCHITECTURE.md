# Phase 8: The Outbound Sync Engine - Architecture Blueprint

## Executive Summary

Phase 8 implements a **bidirectional sync system** that automatically pushes product updates from Nexus to Amazon and eBay. When a user edits a product (price, quantity, attributes), the system queues the change and syncs it to all connected marketplaces.

**Goal:** Ensure Nexus is the single source of truth for product data across all channels.

---

## 1. Database Schema Changes

### 1.1 OutboundSyncQueue Model

**File:** [`packages/database/prisma/schema.prisma`](../packages/database/prisma/schema.prisma)

Add new model to track pending outbound syncs:

```prisma
enum SyncChannel {
  AMAZON
  EBAY
  SHOPIFY
  WOOCOMMERCE
}

enum OutboundSyncStatus {
  PENDING      // Waiting to be processed
  IN_PROGRESS  // Currently syncing
  SUCCESS      // Successfully synced
  FAILED       // Failed, will retry
  SKIPPED      // Skipped (e.g., no listing on channel)
}

model OutboundSyncQueue {
  id                String              @id @default(cuid())
  
  // Product reference
  productId         String
  product           Product             @relation(fields: [productId], references: [id], onDelete: Cascade)
  
  // Target channel
  targetChannel     SyncChannel         @default(AMAZON)
  
  // Sync status
  syncStatus        OutboundSyncStatus  @default(PENDING)
  
  // Payload (what to sync)
  payload           Json                // { "price": 99.99, "quantity": 50, "categoryAttributes": {...} }
  
  // Error tracking
  errorMessage      String?
  errorCode         String?
  retryCount        Int                 @default(0)
  maxRetries        Int                 @default(3)
  
  // Timestamps
  createdAt         DateTime            @default(now())
  updatedAt         DateTime            @updatedAt
  syncedAt          DateTime?           // When successfully synced
  nextRetryAt       DateTime?           // When to retry if failed
  
  // Metadata
  syncType          String              // "PRICE_UPDATE", "QUANTITY_UPDATE", "ATTRIBUTE_UPDATE", "FULL_SYNC"
  externalListingId String?             // Amazon ASIN or eBay ItemID
  
  @@index([productId])
  @@index([syncStatus])
  @@index([targetChannel])
  @@index([nextRetryAt])
}

// Update Product model to add relation
model Product {
  // ... existing fields ...
  
  // NEW: Outbound sync queue
  outboundSyncQueue OutboundSyncQueue[]
}
```

### 1.2 Why This Design?

- **Queue-based:** Decouples product updates from marketplace syncs
- **Retry logic:** Handles temporary API failures gracefully
- **Audit trail:** Tracks all sync attempts and errors
- **Flexible payload:** Supports partial or full updates
- **Channel-specific:** Can sync to different channels independently
- **Indexed:** Fast queries for pending syncs and retries

---

## 2. Outbound Sync Service Architecture

### 2.1 Service Overview

**File:** `apps/api/src/services/outbound-sync.service.ts` (NEW)

The `OutboundSyncService` orchestrates all outbound syncs:

```typescript
export class OutboundSyncService {
  // Queue management
  async queueProductUpdate(
    productId: string,
    channels: SyncChannel[],
    syncType: string,
    payload: Record<string, any>
  ): Promise<OutboundSyncQueue[]>

  // Sync execution
  async processPendingSyncs(
    limit?: number
  ): Promise<{ success: number; failed: number }>

  async syncProductToChannel(
    queueId: string,
    channel: SyncChannel
  ): Promise<{ success: boolean; error?: string }>

  // Amazon integration
  private async syncToAmazon(
    product: Product,
    payload: Record<string, any>,
    queueId: string
  ): Promise<void>

  // eBay integration
  private async syncToEbay(
    product: Product,
    payload: Record<string, any>,
    queueId: string
  ): Promise<void>

  // Status and monitoring
  async getQueueStatus(
    filters?: { productId?: string; channel?: SyncChannel; status?: OutboundSyncStatus }
  ): Promise<OutboundSyncQueue[]>

  async retryFailedSyncs(): Promise<number>

  async clearSuccessfulSyncs(olderThan?: Date): Promise<number>
}
```

### 2.2 Amazon Integration

#### Amazon SP-API Listings Items API

**Endpoint:** `PATCH /listings/2021-08-01/items/{sellerId}/{sku}`

**Use Case:** Update existing Amazon listing with partial changes

```typescript
private async syncToAmazon(
  product: Product,
  payload: Record<string, any>,
  queueId: string
): Promise<void> {
  // 1. Get Amazon credentials
  const amazonConnection = await this.getAmazonConnection(product);
  if (!amazonConnection) {
    throw new Error('No Amazon connection found');
  }

  // 2. Build Amazon payload
  const amazonPayload = this.buildAmazonPayload(product, payload);
  
  // 3. Call Amazon SP-API
  const response = await fetch(
    `https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/${amazonConnection.sellerId}/${product.sku}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${amazonConnection.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(amazonPayload),
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Amazon API error: ${error.message}`);
  }

  // 4. Mark as synced
  await this.markSyncSuccess(queueId);
}

// Build Amazon-specific payload
private buildAmazonPayload(
  product: Product,
  payload: Record<string, any>
): Record<string, any> {
  const amazonPayload: Record<string, any> = {};

  // Price update
  if ('basePrice' in payload) {
    amazonPayload.pricing = [
      {
        currency: 'USD',
        amount: payload.basePrice,
      },
    ];
  }

  // Quantity update
  if ('totalStock' in payload) {
    amazonPayload.fulfillmentAvailability = [
      {
        fulfillmentChannelCode: product.fulfillmentChannel || 'DEFAULT',
        quantity: payload.totalStock,
      },
    ];
  }

  // Category attributes (dynamic fields)
  if ('categoryAttributes' in payload) {
    amazonPayload.attributes = this.mapCategoryAttributesToAmazon(
      product.productType,
      payload.categoryAttributes
    );
  }

  return amazonPayload;
}
```

**Supported Updates:**
- Price changes
- Quantity/inventory updates
- Category-specific attributes
- Product descriptions
- Images

**Error Handling:**
- Retry on rate limit (429)
- Retry on temporary failures (5xx)
- Fail permanently on validation errors (400)
- Log all errors for debugging

### 2.3 eBay Integration

#### eBay Inventory API

**Endpoint:** `PUT /sell/inventory/v1/inventory_item/{sku}`

**Use Case:** Update eBay inventory item with new data

```typescript
private async syncToEbay(
  product: Product,
  payload: Record<string, any>,
  queueId: string
): Promise<void> {
  // 1. Get eBay credentials
  const ebayConnection = await this.getEbayConnection(product);
  if (!ebayConnection) {
    throw new Error('No eBay connection found');
  }

  // 2. Build eBay payload
  const ebayPayload = this.buildEbayPayload(product, payload);

  // 3. Call eBay Inventory API
  const response = await fetch(
    `https://api.ebay.com/sell/inventory/v1/inventory_item/${product.sku}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${ebayConnection.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(ebayPayload),
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`eBay API error: ${error.errors?.[0]?.message}`);
  }

  // 4. Mark as synced
  await this.markSyncSuccess(queueId);
}

// Build eBay-specific payload
private buildEbayPayload(
  product: Product,
  payload: Record<string, any>
): Record<string, any> {
  const ebayPayload: Record<string, any> = {};

  // Availability (quantity)
  if ('totalStock' in payload) {
    ebayPayload.availability = {
      quantity: payload.totalStock,
    };
  }

  // Price
  if ('basePrice' in payload) {
    ebayPayload.price = {
      currency: 'USD',
      value: payload.basePrice.toString(),
    };
  }

  // Condition
  ebayPayload.condition = 'NEW';

  return ebayPayload;
}
```

**Supported Updates:**
- Quantity/availability
- Price
- Condition
- Item specifics

**Error Handling:**
- Retry on rate limit (429)
- Retry on temporary failures (5xx)
- Fail on validation errors (400)
- Log all errors

### 2.4 Sync Flow Diagram

```
Product Update (Price, Quantity, Attributes)
        ↓
Create OutboundSyncQueue entries
  - PENDING status
  - Payload with changes
  - Target channels (AMAZON, EBAY)
        ↓
Background Job (every 5 minutes)
  - Query PENDING syncs
  - Process each sync
        ↓
For each sync:
  - Get product details
  - Get marketplace credentials
  - Build marketplace-specific payload
  - Call marketplace API
        ↓
On Success:
  - Mark as SUCCESS
  - Set syncedAt timestamp
  - Log success
        ↓
On Failure:
  - Increment retryCount
  - Set nextRetryAt (exponential backoff)
  - Log error
  - If retryCount < maxRetries:
    - Keep status as PENDING
  - Else:
    - Mark as FAILED
    - Alert admin
```

---

## 3. API Routes

### 3.1 Endpoints

**File:** `apps/api/src/routes/outbound.routes.ts` (NEW)

```typescript
export async function outboundRoutes(app: FastifyInstance) {
  /**
   * POST /api/outbound/sync/:productId
   * Manually trigger sync for a product to specific channels
   */
  app.post<{ Params: { productId: string }; Body: SyncProductBody }>(
    '/api/outbound/sync/:productId',
    async (request, reply) => {
      const { channels, syncType } = request.body;
      
      // Get product
      const product = await prisma.product.findUnique({
        where: { id: request.params.productId },
      });
      
      if (!product) {
        return reply.status(404).send({
          success: false,
          error: { code: 'PRODUCT_NOT_FOUND', message: 'Product not found' },
        });
      }

      // Queue syncs
      const queues = await outboundSyncService.queueProductUpdate(
        product.id,
        channels,
        syncType,
        { /* payload */ }
      );

      return reply.send({
        success: true,
        data: {
          productId: product.id,
          queued: queues.length,
          queues,
        },
      });
    }
  );

  /**
   * GET /api/outbound/queue
   * View sync queue status
   */
  app.get<{ Querystring: QueueFilterQuery }>(
    '/api/outbound/queue',
    async (request, reply) => {
      const { productId, channel, status } = request.query;

      const queues = await outboundSyncService.getQueueStatus({
        productId,
        channel: channel as SyncChannel,
        status: status as OutboundSyncStatus,
      });

      return reply.send({
        success: true,
        data: {
          total: queues.length,
          pending: queues.filter(q => q.syncStatus === 'PENDING').length,
          failed: queues.filter(q => q.syncStatus === 'FAILED').length,
          queues,
        },
      });
    }
  );

  /**
   * POST /api/outbound/queue/:queueId/retry
   * Manually retry a failed sync
   */
  app.post<{ Params: { queueId: string } }>(
    '/api/outbound/queue/:queueId/retry',
    async (request, reply) => {
      const queue = await prisma.outboundSyncQueue.findUnique({
        where: { id: request.params.queueId },
        include: { product: true },
      });

      if (!queue) {
        return reply.status(404).send({
          success: false,
          error: { code: 'QUEUE_NOT_FOUND', message: 'Queue entry not found' },
        });
      }

      // Reset for retry
      await prisma.outboundSyncQueue.update({
        where: { id: queue.id },
        data: {
          syncStatus: 'PENDING',
          retryCount: 0,
          errorMessage: null,
        },
      });

      return reply.send({
        success: true,
        message: 'Sync queued for retry',
      });
    }
  );

  /**
   * POST /api/outbound/process
   * Manually trigger sync processing (admin)
   */
  app.post('/api/outbound/process', async (request, reply) => {
    const result = await outboundSyncService.processPendingSyncs();

    return reply.send({
      success: true,
      data: result,
    });
  });

  /**
   * GET /api/outbound/stats
   * Get sync statistics
   */
  app.get('/api/outbound/stats', async (request, reply) => {
    const stats = await outboundSyncService.getQueueStats();

    return reply.send({
      success: true,
      data: stats,
    });
  });
}
```

### 3.2 Request/Response Examples

**POST /api/outbound/sync/:productId**

Request:
```json
{
  "channels": ["AMAZON", "EBAY"],
  "syncType": "PRICE_UPDATE"
}
```

Response:
```json
{
  "success": true,
  "data": {
    "productId": "prod-123",
    "queued": 2,
    "queues": [
      {
        "id": "queue-1",
        "productId": "prod-123",
        "targetChannel": "AMAZON",
        "syncStatus": "PENDING",
        "syncType": "PRICE_UPDATE",
        "createdAt": "2026-04-24T23:11:00.000Z"
      },
      {
        "id": "queue-2",
        "productId": "prod-123",
        "targetChannel": "EBAY",
        "syncStatus": "PENDING",
        "syncType": "PRICE_UPDATE",
        "createdAt": "2026-04-24T23:11:00.000Z"
      }
    ]
  }
}
```

**GET /api/outbound/queue**

Response:
```json
{
  "success": true,
  "data": {
    "total": 45,
    "pending": 12,
    "failed": 3,
    "queues": [
      {
        "id": "queue-1",
        "productId": "prod-123",
        "targetChannel": "AMAZON",
        "syncStatus": "PENDING",
        "syncType": "PRICE_UPDATE",
        "retryCount": 0,
        "createdAt": "2026-04-24T23:11:00.000Z"
      }
    ]
  }
}
```

---

## 4. Sync Triggers

### 4.1 When to Queue Syncs

Syncs should be queued when:

1. **Price Updated**
   - User edits `basePrice`
   - Sync type: `PRICE_UPDATE`
   - Payload: `{ basePrice: 99.99 }`

2. **Quantity Updated**
   - User edits `totalStock`
   - Sync type: `QUANTITY_UPDATE`
   - Payload: `{ totalStock: 50 }`

3. **Attributes Updated**
   - User edits `categoryAttributes`
   - Sync type: `ATTRIBUTE_UPDATE`
   - Payload: `{ categoryAttributes: {...} }`

4. **Full Product Update**
   - User edits multiple fields
   - Sync type: `FULL_SYNC`
   - Payload: `{ name, description, price, quantity, attributes }`

### 4.2 Implementation Points

**In Product Update Endpoint:**

```typescript
// After updating product in database
const updatedProduct = await prisma.product.update({
  where: { id: productId },
  data: updateData,
});

// Queue syncs to all connected channels
const connectedChannels = await getConnectedChannels(productId);
await outboundSyncService.queueProductUpdate(
  productId,
  connectedChannels,
  determineSyncType(updateData),
  buildPayload(updateData)
);
```

---

## 5. Background Job

### 5.1 Sync Processor Job

**File:** `apps/api/src/jobs/outbound-sync.job.ts` (NEW)

```typescript
export async function startOutboundSyncJob() {
  // Run every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      console.log('[Outbound Sync] Processing pending syncs...');
      
      const result = await outboundSyncService.processPendingSyncs(
        limit: 50 // Process max 50 per run
      );

      console.log(
        `[Outbound Sync] Processed: ${result.success} success, ${result.failed} failed`
      );
    } catch (error) {
      console.error('[Outbound Sync] Job failed:', error);
    }
  });

  // Retry failed syncs every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    try {
      console.log('[Outbound Sync] Retrying failed syncs...');
      
      const retried = await outboundSyncService.retryFailedSyncs();
      
      console.log(`[Outbound Sync] Retried: ${retried} syncs`);
    } catch (error) {
      console.error('[Outbound Sync] Retry job failed:', error);
    }
  });

  // Clean up old successful syncs every day
  cron.schedule('0 2 * * *', async () => {
    try {
      console.log('[Outbound Sync] Cleaning up old syncs...');
      
      const olderThan = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days
      const cleaned = await outboundSyncService.clearSuccessfulSyncs(olderThan);
      
      console.log(`[Outbound Sync] Cleaned: ${cleaned} old syncs`);
    } catch (error) {
      console.error('[Outbound Sync] Cleanup job failed:', error);
    }
  });
}
```

---

## 6. Error Handling & Retry Logic

### 6.1 Retry Strategy

```typescript
// Exponential backoff
const retryDelays = [
  1 * 60 * 1000,      // 1 minute
  5 * 60 * 1000,      // 5 minutes
  15 * 60 * 1000,     // 15 minutes
  60 * 60 * 1000,     // 1 hour
];

private getNextRetryTime(retryCount: number): Date {
  const delay = retryDelays[Math.min(retryCount, retryDelays.length - 1)];
  return new Date(Date.now() + delay);
}
```

### 6.2 Error Classification

```typescript
enum ErrorType {
  RATE_LIMIT,      // 429 - Retry
  TEMPORARY,       // 5xx - Retry
  VALIDATION,      // 400 - Fail permanently
  AUTHENTICATION,  // 401/403 - Fail permanently
  NOT_FOUND,       // 404 - Fail permanently
  UNKNOWN,         // Other - Retry
}

private classifyError(statusCode: number, error: any): ErrorType {
  if (statusCode === 429) return ErrorType.RATE_LIMIT;
  if (statusCode >= 500) return ErrorType.TEMPORARY;
  if (statusCode === 400) return ErrorType.VALIDATION;
  if (statusCode === 401 || statusCode === 403) return ErrorType.AUTHENTICATION;
  if (statusCode === 404) return ErrorType.NOT_FOUND;
  return ErrorType.UNKNOWN;
}
```

---

## 7. Monitoring & Alerts

### 7.1 Metrics to Track

- Total syncs queued
- Syncs in progress
- Successful syncs
- Failed syncs
- Average sync time
- Error rate by channel
- Retry rate

### 7.2 Alert Conditions

- Sync failure rate > 10%
- Queue size > 1000
- Sync processing time > 30 seconds
- Channel API unavailable

---

## 8. Implementation Phases

### Phase 8.1: Database & Service
- [ ] Add OutboundSyncQueue model
- [ ] Create OutboundSyncService
- [ ] Implement Amazon sync logic
- [ ] Implement eBay sync logic
- [ ] Add retry logic

### Phase 8.2: API Routes
- [ ] Create outbound.routes.ts
- [ ] Implement sync endpoints
- [ ] Add queue status endpoint
- [ ] Add manual retry endpoint

### Phase 8.3: Background Jobs
- [ ] Create outbound-sync.job.ts
- [ ] Implement sync processor
- [ ] Implement retry processor
- [ ] Implement cleanup job

### Phase 8.4: Integration
- [ ] Hook into product update endpoints
- [ ] Queue syncs on price/quantity changes
- [ ] Queue syncs on attribute changes
- [ ] Test end-to-end

### Phase 8.5: Testing & Monitoring
- [ ] Unit tests for sync logic
- [ ] Integration tests with mock APIs
- [ ] Performance testing
- [ ] Monitoring dashboard

---

## 9. Success Criteria

✅ OutboundSyncQueue model created
✅ OutboundSyncService implemented
✅ Amazon SP-API integration working
✅ eBay Inventory API integration working
✅ API endpoints for manual sync and queue status
✅ Background job processing syncs
✅ Retry logic with exponential backoff
✅ Error handling and logging
✅ All tests passing
✅ Monitoring and alerts configured

---

## 10. Future Enhancements

- [ ] Webhook-based sync (real-time instead of polling)
- [ ] Batch syncs for multiple products
- [ ] Sync scheduling (sync at specific times)
- [ ] Selective field syncing (only sync changed fields)
- [ ] Sync history and audit trail
- [ ] Conflict resolution (if marketplace has newer data)
- [ ] Multi-language support for descriptions
- [ ] Image sync to marketplaces

---

**Status:** 🏗️ ARCHITECTURE COMPLETE
**Version:** 1.0.0
**Last Updated:** April 24, 2026
**Next Phase:** Phase 8.1 - Database & Service Implementation
