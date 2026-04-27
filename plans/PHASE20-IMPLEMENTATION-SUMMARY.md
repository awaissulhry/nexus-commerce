# Phase 20: SSOT Architecture - Implementation Summary

## Overview

This phase transforms the product listing system from a simple master-only model to an **enterprise-grade Single Source of Truth (SSOT)** architecture with channel-specific overrides, inspired by Amazon's multi-channel listing system.

### Key Deliverables

1. **Fix 404 Errors** on child product PATCH endpoints
2. **SSOT Data Model** with channel override capabilities
3. **Channel Override UI** with "Follow Master Data" toggles
4. **Real-Time Sync Queue** integration with BullMQ
5. **Validation State Icons** showing sync status per tab
6. **Cascade Logic** for intelligent price/stock propagation
7. **Complete Testing Suite** for all scenarios

---

## Architecture Overview

### Current State (Phase 19.14.8)
```
Product (Master)
├── basePrice: 99.99
├── name: "Headphones"
├── totalStock: 100
│
├── ChannelListing (Amazon)
│   └── price: 99.99 (always matches master)
│
├── ChannelListing (eBay)
│   └── price: 99.99 (always matches master)
│
└── ProductVariation (Child)
    ├── basePrice: 79.99
    └── totalStock: 50
```

### Target State (Phase 20)
```
Product (Master) — SSOT
├── basePrice: 99.99 ✓
├── name: "Headphones" ✓
├── totalStock: 100 ✓
│
├── ChannelListing (Amazon)
│   ├── followMasterPrice: false
│   ├── priceOverride: 89.99 ← Custom!
│   ├── followMasterTitle: true
│   ├── title: null (uses master)
│   ├── syncStatus: "IN_SYNC" ✓
│   └── lastSyncAt: 2026-04-27T12:30:00Z
│
├── ChannelListing (eBay)
│   ├── followMasterPrice: true
│   ├── priceOverride: null (uses master)
│   ├── followMasterTitle: true
│   ├── title: null (uses master)
│   ├── syncStatus: "PENDING" ⏳
│   └── lastSyncAt: null
│
└── ProductVariation (Child)
    ├── basePrice: 79.99 (inherits from parent)
    ├── totalStock: 50 (inherits from parent)
    └── ChannelListings[] (same override pattern)
```

---

## Phase 20.1: Fix 404 Errors on PATCH Child Endpoints

### Problem
Child product update endpoint returns 404 despite existing at line 919 in `catalog.routes.ts`

### Root Cause
1. Route registration prefix mismatch
2. Fastify route not properly mounted
3. Client fetch URL doesn't match server route

### Solution Steps

**Step 1**: Verify route registration in `apps/api/src/routes/index.ts`
```typescript
// Check if catalogRoutes is registered with correct prefix
app.register(catalogRoutes, { prefix: '/api' })
// OR
app.register(catalogRoutes, { prefix: '/api/catalog' })
```

**Step 2**: Confirm endpoint path
- If prefix is `/api`: endpoint is `PATCH /api/products/:parentId/children/:childId`
- If prefix is `/api/catalog`: endpoint is `PATCH /api/catalog/products/:parentId/children/:childId`

**Step 3**: Update client fetch URL in `MasterCatalogTab.tsx`
```typescript
// Current (may be wrong):
const response = await fetch(`/api/products/${product.id}/children/${childId}`, ...)

// Should be:
const response = await fetch(`/api/catalog/products/${product.id}/children/${childId}`, ...)
// OR
const response = await fetch(`/api/products/${product.id}/children/${childId}`, ...)
```

**Step 4**: Add logging to verify endpoint is called
```typescript
app.patch("products/:parentId/children/:childId", async (request, reply) => {
  console.log("🔵 PATCH child endpoint called", { parentId, childId })
  // ... rest of handler
})
```

---

## Phase 20.2: Design SSOT Data Model & Schema Extensions

### Prisma Schema Changes

**Extend ChannelListing Model**:
```prisma
model ChannelListing {
  id                    String   @id @default(cuid())
  productId             String
  product               Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  
  channel               String   // AMAZON, EBAY, SHOPIFY, WOOCOMMERCE
  channelMarket         String   // AMAZON_US, AMAZON_EU, etc.
  region                String   // US, EU, UK, etc.
  
  // Master data references (read-only, for display)
  masterTitle           String?
  masterPrice           Decimal? @db.Decimal(10, 2)
  masterDescription     String?
  
  // Channel-specific overrides
  title                 String?  // If null, use master
  priceOverride         Decimal? @db.Decimal(10, 2)
  descriptionOverride   String?
  
  // Override toggles (explicit control)
  followMasterTitle     Boolean  @default(true)
  followMasterPrice     Boolean  @default(true)
  followMasterDescription Boolean @default(true)
  
  // Sync state tracking
  syncStatus            String   @default("PENDING") // PENDING, IN_SYNC, ERROR, SYNCING
  lastSyncAt            DateTime?
  lastSyncError         String?
  syncAttempts          Int      @default(0)
  
  // Platform-specific attributes
  platformAttributes    Json?    // bulletPoints, images, etc.
  
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  
  @@unique([productId, channel, region])
}
```

**New Model: ChannelListingOverride** (for audit trail)
```prisma
model ChannelListingOverride {
  id                    String   @id @default(cuid())
  channelListingId      String
  channelListing        ChannelListing @relation(fields: [channelListingId], references: [id], onDelete: Cascade)
  
  field                 String   // "price", "title", "description"
  masterValue           String?
  overrideValue         String?
  reason                String?  // Why was this overridden?
  
  createdAt             DateTime @default(now())
  createdBy             String?  // User ID
}
```

**Extend Product Model**:
```prisma
model Product {
  // ... existing fields ...
  
  // SSOT indicators
  isMasterProduct       Boolean  @default(false)
  isParent              Boolean  @default(false)
  
  // Sync configuration
  syncChannels          String[] @default(["AMAZON", "EBAY"])
  autoSyncEnabled       Boolean  @default(true)
  
  // Validation state
  validationStatus      String   @default("VALID") // VALID, WARNING, ERROR
  validationErrors      Json?    // { channel: [errors] }
}
```

### Migration Steps
1. Create migration: `npx prisma migrate dev --name add_ssot_fields`
2. Update existing ChannelListings to set `followMaster*` flags to `true`
3. Populate `masterTitle`, `masterPrice`, `masterDescription` from Product

---

## Phase 20.3: Implement Channel Override UI Components

### New Components to Create

**1. ChannelOverrideToggle.tsx**
- Displays master value in read-only box
- Toggle button to switch between "Follow Master" and "Custom Override"
- Input field for custom value (shown only when override active)
- Sync status icon with last sync timestamp
- Validation error display

**2. SyncStatusIcon.tsx**
- Shows status: PENDING (⏳), SYNCING (⟳), IN_SYNC (✓), ERROR (✕)
- Color-coded: yellow, blue, green, red
- Tooltip with last sync time

**3. TabValidationIcon.tsx**
- Shows validation status: valid (✓), warning (⚠), error (✕)
- Displays error count if applicable
- Used in tab headers to show which tabs have issues

### Component Hierarchy
```
ProductEditorForm
├── TabNavigation
│   ├── Tab (Vital Info) + TabValidationIcon
│   ├── Tab (Offer) + TabValidationIcon
│   ├── Tab (Master Catalog) + TabValidationIcon
│   └── Tab (Channel Overrides) + TabValidationIcon
│
└── TabContent
    └── ChannelOverridesTab
        ├── ChannelTabs (AMAZON, EBAY, SHOPIFY, WOOCOMMERCE)
        └── ChannelOverrideToggle (Price)
        └── ChannelOverrideToggle (Title)
        └── ChannelOverrideToggle (Description)
        └── SyncControlPanel
```

---

## Phase 20.4: Build Channel-Specific Tabs with Override Toggles

### ChannelOverridesTab Component

**Features**:
- Horizontal tabs for each channel (AMAZON, EBAY, SHOPIFY, WOOCOMMERCE)
- For each channel, show 3 override toggles:
  - Price: Master $99.99 vs Override $89.99
  - Title: Master "Headphones" vs Override "Amazon-Optimized Title"
  - Description: Master text vs Override text
- Each toggle shows:
  - Master value (read-only, highlighted)
  - Toggle switch (Follow Master / Custom Override)
  - Input field (only if override active)
  - Sync status icon
  - Last sync timestamp
- Force Sync button to manually trigger sync to selected channel

**User Flow**:
1. User opens "Channel Overrides" tab
2. Selects AMAZON channel
3. Sees Price toggle set to "Follow Master" ($99.99)
4. Clicks toggle to enable override
5. Enters custom price $89.99
6. System queues sync to Amazon
7. Sync status changes from PENDING → SYNCING → IN_SYNC
8. Last sync timestamp updates

---

## Phase 20.5: Create Real-Time Sync Queue Integration

### Backend Services

**ChannelSyncService**:
- `queueChannelSync(channelListingId, syncType)` - Queue a single channel for sync
- `cascadeSyncToChannels(productId, changedFields)` - Queue all channels when master changes
- `cascadeSyncToChildren(parentId, changedFields)` - Queue all children when parent changes

**ChannelSyncWorker**:
- Processes jobs from BullMQ queue
- Updates ChannelListing.syncStatus: PENDING → SYNCING → IN_SYNC/ERROR
- Calls marketplace-specific services (Amazon, eBay, Shopify)
- Retries failed syncs with exponential backoff
- Records last sync timestamp and error messages

### Sync Flow
```
User updates Master Price
    ↓
PATCH /api/products/:id
    ↓
Product.basePrice updated
    ↓
ChannelSyncService.cascadeSyncToChannels()
    ↓
For each ChannelListing where followMasterPrice=true:
  - Queue sync job to BullMQ
  - Set syncStatus = "PENDING"
    ↓
ChannelSyncWorker processes job
  - Set syncStatus = "SYNCING"
  - Call Amazon/eBay/Shopify API
  - Set syncStatus = "IN_SYNC"
  - Set lastSyncAt = now()
    ↓
Frontend polls for status updates
  - Shows sync progress
  - Updates UI when complete
```

### API Endpoints

**Queue Channel Sync**:
```
POST /api/channel-listings/:id/sync
Body: { syncType: "FULL" | "PRICE" | "TITLE" | "DESCRIPTION" }
Response: { queued: true, channelListingId, syncStatus: "PENDING" }
```

**Get Sync Status**:
```
GET /api/channel-listings/:id/sync-status
Response: { syncStatus: "PENDING" | "SYNCING" | "IN_SYNC" | "ERROR", lastSyncAt, lastSyncError }
```

**Update Channel Listing**:
```
PATCH /api/channel-listings/:id
Body: {
  followMasterPrice?: boolean,
  priceOverride?: number,
  followMasterTitle?: boolean,
  title?: string,
  followMasterDescription?: boolean,
  descriptionOverride?: string
}
Response: { success: true, data: updatedChannelListing }
```

---

## Phase 20.6: Add Validation State Icons to Tabs

### Tab Validation States

Each tab can have one of three states:
- **VALID** (✓ green): All fields valid, no errors
- **WARNING** (⚠ yellow): Some fields have warnings (e.g., missing optional fields)
- **ERROR** (✕ red): Required fields missing or invalid

### Implementation

**In ProductEditorForm.tsx**:
```typescript
const getTabValidationStatus = (tabId: string) => {
  const errors = formState.errors
  
  switch (tabId) {
    case 'vital-info':
      return errors.sku || errors.name ? 'error' : 'valid'
    case 'offer':
      return errors.basePrice || errors.totalStock ? 'error' : 'valid'
    case 'master-catalog':
      return product.children.length === 0 ? 'warning' : 'valid'
    case 'channel-overrides':
      const syncErrors = channelListings.filter(cl => cl.syncStatus === 'ERROR')
      return syncErrors.length > 0 ? 'error' : 'valid'
    default:
      return 'valid'
  }
}
```

**Tab Header with Icon**:
```typescript
<div className="flex items-center gap-2">
  <span>{tab.icon}</span>
  <span>{tab.label}</span>
  <TabValidationIcon 
    status={getTabValidationStatus(tab.id)}
    errorCount={getErrorCount(tab.id)}
  />
</div>
```

---

## Phase 20.7: Implement Cascade Logic for Price/Stock Updates

### Cascade Scenarios

**Scenario 1: Update Master Price**
```
User updates Product.basePrice from 99.99 → 109.99
    ↓
For each ChannelListing where followMasterPrice=true:
  - Queue sync to marketplace
  - Update syncStatus = "PENDING"
    ↓
For each Child where parentId=productId:
  - Update Child.basePrice = 109.99 (if not overridden)
  - For each Child's ChannelListing where followMasterPrice=true:
    - Queue sync to marketplace
```

**Scenario 2: Update Child Price**
```
User updates Child.basePrice from 79.99 → 84.99
    ↓
For each Child's ChannelListing where followMasterPrice=true:
  - Queue sync to marketplace
  - Update syncStatus = "PENDING"
```

**Scenario 3: Toggle Override**
```
User toggles Amazon ChannelListing.followMasterPrice from true → false
    ↓
Set priceOverride = current master price (99.99)
    ↓
Queue sync to Amazon
    ↓
Amazon now uses override value, not master
```

### API Implementation

**Enhanced PATCH /api/products/:id**:
```typescript
app.patch('/products/:id', async (request, reply) => {
  const {
    basePrice,
    totalStock,
    name,
    description,
    cascadeToChildren = true,
    cascadeToChannels = true,
  } = request.body

  // 1. Update master product
  const updatedProduct = await prisma.product.update({
    where: { id },
    data: { basePrice, totalStock, name, description },
  })

  // 2. Cascade to children if enabled
  if (cascadeToChildren && product.isParent) {
    await prisma.product.updateMany({
      where: { parentId: id },
      data: { basePrice, totalStock },
    })
  }

  // 3. Cascade to channels if enabled
  if (cascadeToChannels) {
    const changedFields = ['basePrice', 'totalStock', 'name', 'description']
      .filter(field => request.body[field] !== undefined)
    
    await channelSyncService.cascadeSyncToChannels(id, changedFields)
    
    if (product.isParent) {
      await channelSyncService.cascadeSyncToChildren(id, changedFields)
    }
  }

  return reply.send({
    success: true,
    data: updatedProduct,
    cascaded: {
      children: cascadeToChildren ? product.children.length : 0,
      channels: cascadeToChannels ? product.channelListings.length : 0,
    },
  })
})
```

---

## Phase 20.8: Testing & Verification

### Test Scenarios

**1. Fix 404 Errors**
- [ ] PATCH child product with valid data → 200 OK
- [ ] PATCH child product with invalid parent ID → 404
- [ ] PATCH child product with invalid child ID → 404
- [ ] Verify child data is updated in database

**2. SSOT Data Model**
- [ ] Create product with channel listings
- [ ] Verify `followMaster*` flags default to true
- [ ] Verify `priceOverride` is null when following master
- [ ] Verify `syncStatus` defaults to "PENDING"

**3. Channel Override UI**
- [ ] Toggle "Follow Master" → "Custom Override"
- [ ] Enter custom price → Input field appears
- [ ] Toggle back to "Follow Master" → Input field disappears
- [ ] Sync status icon updates in real-time

**4. Real-Time Sync Queue**
- [ ] Update master price → Sync queued for all channels
- [ ] Sync status changes: PENDING → SYNCING → IN_SYNC
- [ ] Last sync timestamp updates
- [ ] Failed sync shows error message

**5. Validation State Icons**
- [ ] Tab shows ✓ when all fields valid
- [ ] Tab shows ✕ when required fields missing
- [ ] Tab shows ⚠ when optional fields missing
- [ ] Error count displays correctly

**6. Cascade Logic**
- [ ] Update master price → Children updated
- [ ] Update master price → All channels queued for sync
- [ ] Update child price → Only child's channels queued
- [ ] Toggle override → Sync queued for that channel only

**7. End-to-End Flow**
- [ ] Create parent product with 2 children
- [ ] Create channel listings for parent and children
- [ ] Update master price
- [ ] Verify children updated
- [ ] Verify all channels queued for sync
- [ ] Verify sync completes successfully
- [ ] Verify UI shows IN_SYNC status

---

## File Structure

### New Files to Create
```
apps/web/src/
├── components/
│   ├── catalog/
│   │   ├── ChannelOverrideToggle.tsx
│   │   ├── SyncStatusIcon.tsx
│   │   └── TabValidationIcon.tsx
│   └── ...
│
└── app/catalog/[id]/edit/tabs/
    ├── ChannelOverridesTab.tsx
    └── ...

apps/api/src/
├── services/
│   ├── channel-sync.service.ts
│   └── ...
│
├── workers/
│   ├── channel-sync.worker.ts
│   └── ...
│
└── routes/
    ├── channel-listings.routes.ts
    └── ...
```

### Files to Modify
```
apps/web/src/
├── app/catalog/[id]/edit/
│   ├── ProductEditorForm.tsx (add ChannelOverridesTab)
│   └── schema.ts (add validation)
│
└── app/catalog/[id]/edit/tabs/
    └── MasterCatalogTab.tsx (remove debug banner)

apps/api/src/
├── routes/
│   ├── catalog.routes.ts (fix 404, add cascade logic)
│   └── index.ts (verify route registration)
│
└── db.ts (verify Prisma client)
```

---

## Success Criteria

✅ All 404 errors on PATCH child endpoints are fixed
✅ SSOT data model implemented with override toggles
✅ Channel-specific tabs show master vs override values
✅ Real-time sync queue processes all changes
✅ Validation state icons display correctly
✅ Cascade logic propagates changes intelligently
✅ All test scenarios pass
✅ No breaking changes to existing functionality

---

## Dependencies

- **BullMQ** (already installed)
- **Prisma** (already installed)
- **React Hook Form** (already installed)
- **Zod** (already installed)
- **Lucide React** (already installed)

---

## Estimated Complexity

- **Phase 20.1**: Low (debugging)
- **Phase 20.2**: Medium (schema migration)
- **Phase 20.3**: Medium (UI components)
- **Phase 20.4**: Medium (tab integration)
- **Phase 20.5**: High (queue integration)
- **Phase 20.6**: Low (icon components)
- **Phase 20.7**: High (cascade logic)
- **Phase 20.8**: Medium (testing)

**Total**: ~40-50 hours of implementation work

---

## Next Steps

1. Review this plan and provide feedback
2. Approve or request changes
3. Switch to Code mode to implement Phase 20.1 (fix 404 errors)
4. Proceed sequentially through remaining phases
