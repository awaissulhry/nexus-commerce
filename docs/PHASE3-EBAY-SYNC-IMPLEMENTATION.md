# Phase 3.3: eBay Sync & Auto-Match Service Implementation

**Status:** ✅ COMPLETED  
**Date:** April 24, 2026  
**Phase Duration:** Phase 3.1 + 3.2 + 3.3 Combined

## Overview

Phase 3.3 implements the complete eBay inventory synchronization and auto-matching system, enabling:
- Fetching all active eBay listings from seller account
- Intelligent auto-matching algorithm (SKU → UPC → EAN → Title → Manual)
- Automatic creation/update of VariantChannelListing records
- Unmatched listing tracking for manual mapping
- Comprehensive sync status reporting

## Architecture

### Backend Components

#### 1. eBay Sync Service (`apps/api/src/services/ebay-sync.service.ts`)

**Purpose:** Orchestrates the complete eBay inventory sync and auto-matching process

**Key Methods:**

- **`fetchEbayListings(accessToken)`**
  - Calls eBay Inventory API to retrieve all active listings
  - Parses inventory items into standardized format
  - Returns array of EbayListing objects with SKU, title, price, quantity

- **`autoMatchListing(listing)`**
  - Implements 4-tier matching strategy:
    1. **SKU Match** (95% confidence) - Exact SKU match in Nexus database
    2. **UPC Match** (85% confidence) - UPC field matches eBay SKU
    3. **EAN Match** (85% confidence) - EAN field matches eBay SKU
    4. **Title Match** (60% confidence) - Product name contains eBay title words
  - Returns MatchResult with confidence score and match type
  - Logs all matching attempts for debugging

- **`createOrUpdateChannelListing(match, listing, channelConnectionId)`**
  - Creates new VariantChannelListing if not exists
  - Updates existing listing with latest eBay data
  - Stores external listing ID, SKU, URL, pricing, inventory
  - Tracks creation vs. update statistics

- **`syncEbayInventory(connectionId)`**
  - Main orchestration method
  - Fetches valid OAuth token
  - Retrieves all eBay listings
  - Processes each listing through auto-match
  - Creates/updates VariantChannelListing records
  - Updates connection sync status
  - Returns comprehensive SyncResult

**Matching Algorithm:**

```
For each eBay listing:
  1. Extract eBay SKU (from sku or customLabel field)
  2. Try SKU match → if found, confidence 95%
  3. Try UPC match → if found, confidence 85%
  4. Try EAN match → if found, confidence 85%
  5. Try title match → if found, confidence 60%
  6. If no match → flag as unmatched, confidence 0%
  
  If matched:
    - Create/update VariantChannelListing
    - Link to ChannelConnection
    - Store external listing ID and SKU
    - Set listing status to ACTIVE
  
  If unmatched:
    - Log for manual review
    - Create placeholder VariantChannelListing
    - Flag for user to manually link
```

**Statistics Tracked:**

- `listingsFetched` - Total eBay listings retrieved
- `listingsMatched` - Successfully matched to Nexus products
- `listingsUnmatched` - No match found (manual mapping needed)
- `listingsCreated` - New VariantChannelListing records created
- `listingsUpdated` - Existing records updated with new data
- `errors` - Array of errors encountered during sync

#### 2. eBay Routes (`apps/api/src/routes/ebay.routes.ts`)

**Purpose:** Fastify route handlers for eBay sync operations

**Endpoints:**

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/sync/ebay/inventory` | Trigger inventory sync |
| GET | `/api/sync/ebay/inventory/:connectionId` | Get sync status |
| GET | `/api/sync/ebay/listings/:connectionId` | List all eBay listings |
| GET | `/api/sync/ebay/unmatched/:connectionId` | Get unmatched listings |
| POST | `/api/sync/ebay/listings/:listingId/link` | Manually link listing |

**Request/Response Examples:**

```bash
# 1. Trigger Inventory Sync
POST /api/sync/ebay/inventory
{
  "connectionId": "cuid..."
}
Response: {
  "success": true,
  "syncId": "ebay-sync-1234567890",
  "status": "SUCCESS",
  "summary": {
    "listingsFetched": 150,
    "listingsMatched": 142,
    "listingsUnmatched": 8,
    "listingsCreated": 50,
    "listingsUpdated": 92,
    "errorCount": 0
  },
  "matches": [
    {
      "ebayItemId": "123456789",
      "ebayTitle": "Product Name",
      "ebaySku": "SKU123",
      "matchType": "SKU",
      "matchedProductId": "prod_123",
      "confidence": 95,
      "reason": "Exact SKU match: SKU123"
    }
  ],
  "errors": [],
  "startedAt": "2026-04-24T22:00:00Z",
  "completedAt": "2026-04-24T22:05:00Z"
}

# 2. Get Sync Status
GET /api/sync/ebay/inventory/cuid...
Response: {
  "success": true,
  "connection": {
    "id": "cuid...",
    "isActive": true,
    "lastSyncAt": "2026-04-24T22:05:00Z",
    "lastSyncStatus": "SUCCESS",
    "lastSyncError": null
  }
}

# 3. List All eBay Listings
GET /api/sync/ebay/listings/cuid...
Response: {
  "success": true,
  "count": 142,
  "listings": [
    {
      "id": "listing_123",
      "variantId": "var_456",
      "productName": "Product Name",
      "productSku": "SKU123",
      "externalListingId": "123456789",
      "externalSku": "SKU123",
      "listingUrl": "https://www.ebay.com/itm/123456789",
      "listingStatus": "ACTIVE",
      "currentPrice": "29.99",
      "quantity": 50,
      "quantitySold": 5,
      "lastSyncedAt": "2026-04-24T22:05:00Z",
      "lastSyncStatus": "SUCCESS"
    }
  ]
}

# 4. Get Unmatched Listings
GET /api/sync/ebay/unmatched/cuid...
Response: {
  "success": true,
  "count": 8,
  "unmatched": [
    {
      "id": "listing_789",
      "externalListingId": "987654321",
      "externalSku": "UNKNOWN_SKU",
      "listingUrl": "https://www.ebay.com/itm/987654321",
      "listingStatus": "ACTIVE",
      "currentPrice": "49.99",
      "quantity": 25
    }
  ]
}

# 5. Manually Link Listing
POST /api/sync/ebay/listings/listing_789/link
{
  "variantId": "var_999"
}
Response: {
  "success": true,
  "message": "Listing linked successfully",
  "listing": {
    "id": "listing_789",
    "variantId": "var_999",
    "productName": "Manually Linked Product",
    "externalListingId": "987654321"
  }
}
```

## Database Integration

### VariantChannelListing Model

**Fields Used for eBay Sync:**

```prisma
model VariantChannelListing {
  // Primary Keys
  id                  String           @id @default(cuid())
  variantId           String           // Link to ProductVariation
  
  // eBay Connection
  channelConnectionId String?          // Link to ChannelConnection
  
  // eBay-Specific Fields
  externalListingId   String?          // eBay ItemID (12-digit)
  externalSku         String?          // eBay custom SKU
  listingUrl          String?          // Direct eBay listing URL
  
  // Pricing & Inventory
  currentPrice        Decimal?         // eBay listing price
  quantity            Int?             // Current quantity available
  quantitySold        Int              // Quantity sold
  
  // Status Tracking
  listingStatus       String           // ACTIVE, INACTIVE, ENDED, etc.
  lastSyncedAt        DateTime?        // Last sync timestamp
  lastSyncStatus      String?          // SUCCESS, FAILED, PENDING
  lastSyncError       String?          // Error message if failed
}
```

### ChannelConnection Model

**Fields Updated During Sync:**

```prisma
model ChannelConnection {
  id                String    @id @default(cuid())
  
  // OAuth2 Tokens
  ebayAccessToken   String?   // Current access token
  ebayRefreshToken  String?   // Refresh token
  ebayTokenExpiresAt DateTime? // Token expiration
  
  // Seller Info
  ebaySignInName    String?   // Seller username
  ebayStoreName     String?   // Store name
  ebayStoreFrontUrl String?   // Store URL
  
  // Sync Status
  isActive          Boolean   @default(false)
  lastSyncAt        DateTime? // Last sync timestamp
  lastSyncStatus    String?   // SUCCESS, FAILED, PARTIAL
  lastSyncError     String?   // Error message
}
```

## Workflow

### Complete eBay Integration Flow

```
1. User connects eBay account
   ↓
2. OAuth2 flow completes
   ↓
3. ChannelConnection created with tokens
   ↓
4. User triggers inventory sync
   ↓
5. EbaySyncService.syncEbayInventory() called
   ├─ Get valid OAuth token (auto-refresh if needed)
   ├─ Fetch all active eBay listings
   ├─ For each listing:
   │  ├─ Extract SKU/title/price/quantity
   │  ├─ Run auto-match algorithm
   │  ├─ If matched: create/update VariantChannelListing
   │  └─ If unmatched: flag for manual review
   ├─ Update ChannelConnection sync status
   └─ Return comprehensive SyncResult
   ↓
6. User reviews unmatched listings
   ↓
7. User manually links unmatched items
   ↓
8. All eBay listings now linked to Nexus products
   ↓
9. Centralized inventory count available
```

## Auto-Matching Strategy

### Confidence Levels

| Strategy | Confidence | Criteria | Use Case |
|----------|-----------|----------|----------|
| SKU Match | 95% | Exact SKU match in database | Primary matching method |
| UPC Match | 85% | Product UPC matches eBay SKU | Fallback for UPC-based products |
| EAN Match | 85% | Product EAN matches eBay SKU | International products |
| Title Match | 60% | Product name contains eBay title words | Last resort matching |
| Manual | 0% | No automatic match found | User must manually link |

### Example Matching Scenarios

**Scenario 1: SKU Match (95% confidence)**
```
eBay Listing: SKU="PROD-001", Title="Blue Widget"
Nexus Product: sku="PROD-001"
Result: MATCHED (SKU)
```

**Scenario 2: UPC Match (85% confidence)**
```
eBay Listing: SKU="012345678901", Title="Widget"
Nexus Product: sku="DIFFERENT", upc="012345678901"
Result: MATCHED (UPC)
```

**Scenario 3: Title Match (60% confidence)**
```
eBay Listing: SKU="UNKNOWN", Title="Blue Widget Pro"
Nexus Product: sku="UNKNOWN", name="Blue Widget"
Result: MATCHED (TITLE) - "Blue Widget" found in title
```

**Scenario 4: No Match (0% confidence)**
```
eBay Listing: SKU="MYSTERY123", Title="Unknown Item"
Nexus Product: No matching SKU, UPC, EAN, or title
Result: UNMATCHED - Flagged for manual review
```

## Error Handling

### Sync Error Scenarios

1. **Invalid Token**
   - Auto-refresh token
   - If refresh fails, mark connection as inactive
   - Return error to user

2. **eBay API Failure**
   - Log error with details
   - Return partial sync result
   - Update connection with error status

3. **Database Write Failure**
   - Log error
   - Continue processing other listings
   - Report failed listings in result

4. **Matching Failure**
   - Log error
   - Mark listing as unmatched
   - Continue with next listing

### Error Reporting

All errors are collected and returned in SyncResult:

```typescript
errors: [
  {
    itemId: "123456789",
    error: "Failed to create VariantChannelListing: Database error"
  }
]
```

## Performance Considerations

### Optimization Strategies

1. **Batch Processing**
   - Process listings in batches
   - Reduce database round-trips
   - Implement transaction support

2. **Caching**
   - Cache product lookups
   - Reduce database queries
   - Invalidate on product updates

3. **Async Processing**
   - Use background jobs for large syncs
   - Return sync ID immediately
   - Poll for status updates

4. **Indexing**
   - Index on SKU, UPC, EAN for fast lookups
   - Index on externalListingId for reverse lookups
   - Index on channelConnectionId for filtering

## Files Created/Modified

### New Files

- `apps/api/src/services/ebay-sync.service.ts` (540+ lines)
  - EbaySyncService class
  - Auto-matching algorithm
  - Listing creation/update logic

- `apps/api/src/routes/ebay.routes.ts` (330+ lines)
  - 5 API endpoints
  - Sync orchestration
  - Listing management

### Modified Files

- `apps/api/src/index.ts`
  - Imported ebayRoutes
  - Registered ebayRoutes in Fastify app

## Testing

### Manual Testing Steps

1. **Connect eBay Account**
   ```bash
   POST /api/ebay/auth/initiate
   # Follow OAuth flow
   ```

2. **Trigger Inventory Sync**
   ```bash
   POST /api/sync/ebay/inventory
   {
     "connectionId": "your_connection_id"
   }
   ```

3. **Review Sync Results**
   ```bash
   GET /api/sync/ebay/inventory/your_connection_id
   ```

4. **Check Matched Listings**
   ```bash
   GET /api/sync/ebay/listings/your_connection_id
   ```

5. **Review Unmatched Listings**
   ```bash
   GET /api/sync/ebay/unmatched/your_connection_id
   ```

6. **Manually Link Unmatched Items**
   ```bash
   POST /api/sync/ebay/listings/listing_id/link
   {
     "variantId": "variant_id"
   }
   ```

### Expected Results

- ✅ All eBay listings fetched successfully
- ✅ 80-95% auto-matched based on SKU/UPC/EAN
- ✅ Remaining 5-20% flagged for manual review
- ✅ VariantChannelListing records created/updated
- ✅ Sync status tracked in ChannelConnection
- ✅ Unmatched listings accessible for manual linking

## Next Steps

### Phase 4: Order Synchronization

1. **Fetch eBay Orders**
   - Retrieve completed orders from eBay API
   - Map to internal Order model
   - Link to VariantChannelListing

2. **Financial Tracking**
   - Sync order amounts
   - Track fees and commissions
   - Create FinancialTransaction records

3. **Fulfillment Management**
   - Track order status
   - Update fulfillment status
   - Sync tracking information

### Phase 5: Inventory Synchronization

1. **Real-time Inventory Updates**
   - Sync quantity changes
   - Update eBay listings
   - Prevent overselling

2. **Price Synchronization**
   - Sync pricing rules
   - Update eBay prices
   - Implement repricing logic

## Completion Checklist

- [x] eBay Sync Service created with auto-matching
- [x] 4-tier matching algorithm implemented
- [x] VariantChannelListing creation/update logic
- [x] API endpoints for sync operations
- [x] Unmatched listing tracking
- [x] Manual linking capability
- [x] Comprehensive error handling
- [x] Sync status reporting
- [x] Database integration
- [x] Route registration
- [x] Documentation

## Summary

Phase 3.3 successfully implements a complete, production-ready eBay inventory synchronization system with intelligent auto-matching. The system:

- **Fetches** all active eBay listings via Inventory API
- **Matches** listings to Nexus products using 4-tier algorithm (95% → 60% confidence)
- **Creates/Updates** VariantChannelListing records automatically
- **Tracks** unmatched listings for manual review
- **Reports** comprehensive sync statistics and errors
- **Integrates** seamlessly with existing ChannelConnection and OAuth2 systems

The implementation bridges Amazon and eBay catalogs into a single centralized inventory system, enabling unified inventory management across multiple marketplaces.

**Status: Ready for Phase 4 (Order Synchronization)**
