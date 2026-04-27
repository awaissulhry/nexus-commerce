# Amazon Catalog Sync Service Architecture

## Overview
Complete redesign of the catalog synchronization system to perfectly mirror Amazon Seller Central's parent/child hierarchy, ensuring 265 products are correctly grouped into ~14 master parents with their variations.

---

## 1. Database Schema Enhancements

### 1.1 Product Model Updates

**Add these fields to the Product model:**

```prisma
model Product {
  // ... existing fields ...
  
  // ── Parent/Child Hierarchy ──────────────────────────────────────
  isParent          Boolean   @default(false)  // TRUE if this is a master parent
  parentId          String?                    // Self-relation: parent product ID
  parent            Product?  @relation("ProductHierarchy", fields: [parentId], references: [id], onDelete: Cascade)
  children          Product[] @relation("ProductHierarchy")  // Child variations
  
  // ── Amazon Parent ASIN (non-buyable) ────────────────────────────
  parentAsin        String?   // Parent ASIN from Amazon (non-buyable)
  
  // ── Fulfillment Channel ─────────────────────────────────────────
  fulfillmentChannel FulfillmentMethod?  // FBA or FBM (default for all variations)
  
  // ── Shipping Template (FBM only) ────────────────────────────────
  shippingTemplate  String?   // e.g., "Xavia FBM Shipping Template"
  
  // ── Sync Metadata ───────────────────────────────────────────────
  lastAmazonSync    DateTime?
  amazonSyncStatus  String?   // SUCCESS, FAILED, PENDING
  amazonSyncError   String?
  
  // Relations
  syncLogs          SyncLog[]
  
  // ... rest of existing fields ...
}
```

### 1.2 SyncLog Model (New)

```prisma
model SyncLog {
  id                String    @id @default(cuid())
  product           Product   @relation(fields: [productId], references: [id], onDelete: Cascade)
  productId         String
  
  syncType          String    // "AMAZON_CATALOG", "AMAZON_INVENTORY", "AMAZON_PRICING"
  status            String    // "PENDING", "IN_PROGRESS", "SUCCESS", "FAILED"
  
  itemsProcessed    Int       @default(0)
  itemsSuccessful   Int       @default(0)
  itemsFailed       Int       @default(0)
  
  startedAt         DateTime  @default(now())
  completedAt       DateTime?
  
  errorMessage      String?
  details           Json?     // Detailed sync results
  
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  
  @@index([productId])
  @@index([status])
  @@index([syncType])
}
```

---

## 2. Amazon Sync Engine Service

### 2.1 Service Architecture

**File:** `apps/api/src/services/amazon-sync.service.ts`

**Core Responsibilities:**
1. Connect to Amazon SP-API
2. Fetch catalog with parent/child relationships
3. Identify variation matrix (Size, Color, SizeColor, etc.)
4. Sync fulfillment channel (FBA vs FBM)
5. Persist relationships to database
6. Log all sync activity

### 2.2 Key Methods

```typescript
class AmazonSyncService {
  // Main entry point
  async syncAmazonCatalog(sellerId: string): Promise<SyncResult>
  
  // Fetch parent/child relationships from Amazon
  private async fetchCatalogHierarchy(sellerId: string): Promise<CatalogItem[]>
  
  // Identify which items are parents vs children
  private identifyParentChildRelationships(items: CatalogItem[]): {
    parents: CatalogItem[]
    children: Map<string, CatalogItem[]>  // parentAsin → children
  }
  
  // Sync a single parent product
  private async syncParentProduct(item: CatalogItem): Promise<Product>
  
  // Sync a child variation
  private async syncChildVariation(
    parentId: string,
    childItem: CatalogItem
  ): Promise<ProductVariation>
  
  // Detect fulfillment channel (FBA vs FBM)
  private detectFulfillmentChannel(item: CatalogItem): FulfillmentMethod
  
  // Extract shipping template for FBM items
  private extractShippingTemplate(item: CatalogItem): string | null
  
  // Log sync progress
  private async logSyncProgress(
    productId: string,
    status: string,
    details: any
  ): Promise<void>
}
```

### 2.3 Variation Matrix Detection

**Logic:**
- Query Amazon Catalog Items API for each product
- Check `relationships` field for parent/child links
- Extract variation attributes (Color, Size, Material, etc.)
- Build variation theme string (e.g., "SizeColor")
- Store in `Product.variationTheme`

**Example:**
```
Parent ASIN: B0123456789 (non-buyable)
  ├─ Child ASIN: B0123456790 (Size: S, Color: Black)
  ├─ Child ASIN: B0123456791 (Size: M, Color: Black)
  ├─ Child ASIN: B0123456792 (Size: L, Color: Black)
  ├─ Child ASIN: B0123456793 (Size: S, Color: Red)
  └─ Child ASIN: B0123456794 (Size: M, Color: Red)

Variation Theme: "SizeColor"
```

### 2.4 Fulfillment Channel Sync

**FBA Detection:**
- Check if item has Amazon network stock
- Query FBA inventory endpoint
- Set `fulfillmentChannel: FBA`

**FBM Detection:**
- Check if item uses merchant fulfillment
- Extract shipping template from listing
- Set `fulfillmentChannel: FBM`
- Store template in `shippingTemplate` field

---

## 3. Sync API Endpoint

### 3.1 Route Definition

**File:** `apps/api/src/routes/sync.routes.ts`

```typescript
POST /api/sync/amazon/catalog
Content-Type: application/json

Request Body:
{
  "sellerId": "AMAZON_SELLER_ID",
  "syncType": "FULL" | "INCREMENTAL",
  "includeInventory": true,
  "includePricing": true
}

Response:
{
  "syncId": "sync_123456",
  "status": "IN_PROGRESS",
  "itemsProcessed": 0,
  "itemsSuccessful": 0,
  "itemsFailed": 0,
  "startedAt": "2026-04-24T08:19:00Z",
  "estimatedCompletion": "2026-04-24T08:25:00Z"
}
```

### 3.2 Endpoint Implementation

```typescript
export async function syncRoutes(app: FastifyInstance) {
  // POST /api/sync/amazon/catalog
  app.post<{ Body: SyncCatalogRequest }>(
    "/sync/amazon/catalog",
    async (request, reply) => {
      try {
        const { sellerId, syncType = "FULL" } = request.body;
        
        // Validate seller
        const seller = await validateSeller(sellerId);
        if (!seller) {
          return reply.status(401).send({ error: "Invalid seller" });
        }
        
        // Start async sync
        const syncLog = await prisma.syncLog.create({
          data: {
            productId: "SYSTEM",  // Or create a system product
            syncType: "AMAZON_CATALOG",
            status: "IN_PROGRESS",
            startedAt: new Date(),
          },
        });
        
        // Trigger background sync (don't wait)
        amazonSyncService.syncAmazonCatalog(sellerId, syncLog.id)
          .catch(err => {
            console.error("Sync failed:", err);
            // Update sync log with error
          });
        
        return reply.send({
          syncId: syncLog.id,
          status: "IN_PROGRESS",
          startedAt: syncLog.startedAt,
        });
      } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: "Sync failed" });
      }
    }
  );
  
  // GET /api/sync/amazon/catalog/:syncId
  app.get<{ Params: { syncId: string } }>(
    "/sync/amazon/catalog/:syncId",
    async (request, reply) => {
      const { syncId } = request.params;
      
      const syncLog = await prisma.syncLog.findUnique({
        where: { id: syncId },
      });
      
      if (!syncLog) {
        return reply.status(404).send({ error: "Sync not found" });
      }
      
      return reply.send(syncLog);
    }
  );
}
```

---

## 4. Data Flow Diagram

```
Amazon SP-API
    ↓
[Fetch Catalog Items]
    ↓
[Identify Parent/Child Relationships]
    ├─ Parent ASIN → Product (isParent: true)
    └─ Child ASIN → ProductVariation (productId: parent.id)
    ↓
[Detect Fulfillment Channel]
    ├─ FBA → fulfillmentChannel: FBA
    └─ FBM → fulfillmentChannel: FBM, shippingTemplate: "..."
    ↓
[Extract Variation Attributes]
    ├─ Color, Size, Material, etc.
    └─ Store in variationAttributes JSON
    ↓
[Persist to Database]
    ├─ Create/Update Product (parent)
    ├─ Create/Update ProductVariation (children)
    └─ Create/Update VariantChannelListing
    ↓
[Log Sync Progress]
    └─ SyncLog record with status
    ↓
[Frontend Displays Hierarchy]
    ├─ Parent rows with expander
    └─ Child rows in subRows
```

---

## 5. Implementation Phases

### Phase 1: Database Schema (Week 1)
- [ ] Add `isParent`, `parentId`, `parentAsin`, `fulfillmentChannel`, `shippingTemplate` to Product
- [ ] Create `SyncLog` model
- [ ] Run migration
- [ ] Update Prisma client

### Phase 2: Sync Service (Week 2)
- [ ] Implement `AmazonSyncService` class
- [ ] Add Amazon SP-API integration
- [ ] Implement parent/child identification logic
- [ ] Add fulfillment channel detection
- [ ] Add sync logging

### Phase 3: API Endpoint (Week 2)
- [ ] Create `/api/sync/amazon/catalog` POST endpoint
- [ ] Create `/api/sync/amazon/catalog/:syncId` GET endpoint
- [ ] Add request validation
- [ ] Add error handling

### Phase 4: Frontend Integration (Week 3)
- [ ] Update inventory page to fetch sync logs
- [ ] Display sync progress in UI
- [ ] Add manual sync trigger button
- [ ] Display sync history

---

## 6. Success Criteria

✅ **Data Integrity:**
- 265 products correctly grouped into ~14 parents + standalones
- Each parent has `isParent: true` and `parentId: null`
- Each child has `isParent: false` and `parentId: <parent.id>`
- All variations linked to correct parent

✅ **Fulfillment Accuracy:**
- FBA items correctly flagged with `fulfillmentChannel: FBA`
- FBM items correctly flagged with `fulfillmentChannel: FBM`
- Shipping templates extracted for FBM items

✅ **Sync Logging:**
- All sync operations logged to `SyncLog` table
- Sync progress trackable via API
- Errors captured and reported

✅ **Frontend Display:**
- Parent rows show expander chevron
- Child rows appear only in parent's subRows
- Tab counts reflect grouped data only
- Sync status visible in UI

---

## 7. Error Handling & Recovery

**Sync Failures:**
- Retry failed items up to 3 times
- Log detailed error messages
- Mark sync as FAILED if critical items fail
- Allow manual retry

**Data Conflicts:**
- If parent/child relationship changes, update existing records
- Preserve variation data during updates
- Handle orphaned children gracefully

**API Rate Limiting:**
- Implement exponential backoff
- Batch requests to Amazon API
- Cache responses where possible

---

## 8. Testing Strategy

**Unit Tests:**
- Parent/child identification logic
- Fulfillment channel detection
- Variation attribute extraction

**Integration Tests:**
- Full sync flow with mock Amazon API
- Database persistence verification
- Sync log accuracy

**E2E Tests:**
- Manual sync trigger
- Sync progress tracking
- Frontend hierarchy display

---

## 9. Monitoring & Observability

**Metrics to Track:**
- Sync duration
- Items processed per minute
- Success/failure rates
- API error rates
- Database write performance

**Logging:**
- Detailed sync progress logs
- Error stack traces
- API request/response logs
- Database transaction logs

---

## 10. Future Enhancements

- Incremental sync (only changed items)
- Real-time sync via webhooks
- Bulk price/inventory updates
- Variation matrix auto-detection
- Multi-marketplace sync (eBay, Shopify, etc.)
