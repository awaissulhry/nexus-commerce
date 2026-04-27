# Phase 12d: Variation Sync Engine

## Overview

The Variation Sync Engine translates the internal Hub & Spoke Matrix into Amazon SP-API Parent/Child payloads. It includes:

1. **Amazon Mapper Service** - Builds variation payloads from master/child products
2. **Variation Sync Processor** - Processes variation syncs and logs payloads
3. **Smart Parent Triggers** - Automatically queues parent syncs when child attributes change
4. **Sandbox Mode** - Logs payloads for verification without sending to Amazon

## Architecture

### Hub & Spoke to Amazon Translation

```
Internal Matrix (Hub & Spoke)
├── Master Product (Parent)
│   ├── isParent: true
│   ├── sku: "xracing"
│   └── ChannelListing (Amazon US)
│       ├── variationTheme: "Color"
│       └── variationMapping: {...}
└── Child Products
    ├── xracing-red (categoryAttributes.color: "Red")
    ├── xracing-blue (categoryAttributes.color: "Blue")
    └── xracing-black (categoryAttributes.color: "Black")
         ↓
Amazon SP-API Payload
├── Parent Item
│   ├── sku: "xracing"
│   ├── parentage: "parent"
│   └── variationTheme: "Color"
└── Child Items
    ├── sku: "xracing-red", parentSku: "xracing", Color: "Red"
    ├── sku: "xracing-blue", parentSku: "xracing", Color: "Blue"
    └── sku: "xracing-black", parentSku: "xracing", Color: "Black"
```

## Components

### 1. Amazon Mapper Service (`apps/api/src/services/amazon-mapper.service.ts`)

Translates internal variation data to Amazon SP-API format.

**Key Methods:**

#### `buildVariationPayload(channelListingId, productId)`
Builds a complete Amazon variation payload for a parent product.

**Input:**
- `channelListingId`: The Amazon ChannelListing ID
- `productId`: The master product ID

**Output:**
```typescript
{
  items: [
    {
      sku: "xracing",
      parentage: "parent",
      variationTheme: "Color",
      title: "XRacing Pro Helmet - Multiple Colors",
      description: "...",
      price: 199.99,
      quantity: 150,
      fulfillmentChannel: "FBA"
    },
    {
      sku: "xracing-red",
      parentage: "child",
      parentSku: "xracing",
      variationAttributes: { Color: "Red" },
      title: "XRacing Pro Helmet - Red",
      price: 199.99,
      quantity: 45,
      fulfillmentChannel: "FBA"
    },
    // ... more children
  ],
  variationTheme: "Color",
  parentSku: "xracing",
  childCount: 3,
  timestamp: "2026-04-25T01:27:00.000Z"
}
```

**Process:**
1. Fetch master product with all relations
2. Validate it's a parent with variation theme
3. Build parent item from master product
4. Build child items from masterVariations
5. Extract variation attributes using variationMapping
6. Return complete payload

#### `extractVariationAttributes(childProduct, variationMapping, variationTheme)`
Maps child product attributes to Amazon format.

**Example:**
```
Input:
  childProduct.categoryAttributes = { color: "Red" }
  variationMapping = {
    Color: {
      masterAttribute: "color",
      platformAttribute: "Color",
      values: { Red: "Red", Blue: "Blue", Black: "Black" }
    }
  }
  variationTheme = "Color"

Output:
  { Color: "Red" }
```

#### `validateVariationParent(productId)`
Validates that a product can be synced as a variation parent.

**Checks:**
- Product exists
- Product is marked as parent (isParent = true)
- Product has at least one child
- Product has Amazon listing
- Amazon listing has variation theme

### 2. Variation Sync Processor (`apps/api/src/services/variation-sync-processor.service.ts`)

Processes LISTING_SYNC queue items for variation parents.

**Key Methods:**

#### `processVariationSync(queueItem)`
Processes a variation sync queue item.

**Process:**
1. Validate product is a parent
2. Validate channel listing has variation theme
3. Build Amazon variation payload
4. Log payload in sandbox mode
5. Mark sync as SUCCESS

**Logging Output:**
```
🎯 AMAZON SP-API VARIATION PAYLOAD (SANDBOX MODE)
  context: {
    productId: "cmoakom7o006vnjmpq9njn46w",
    productSku: "xracing",
    channelMarket: "AMAZON_US",
    variationTheme: "Color",
    parentSku: "xracing",
    childCount: 3,
    timestamp: "2026-04-25T01:27:00.000Z"
  }
  payload: { ... full payload ... }

📋 VARIATION ITEMS DETAIL
  parentItem: { ... }
  childItems: [ ... ]

📦 FULL PAYLOAD JSON
  json: "{ ... formatted JSON ... }"
```

#### `isVariationSync(queueItem)`
Checks if a queue item is a variation sync.

**Returns true if:**
- syncType = "LISTING_SYNC"
- payload.source = "CHILD_VARIATION_CHANGE" OR "VARIATION_THEME_UPDATE"

#### `getPendingVariationSyncs()`
Gets all pending variation syncs from the queue.

### 3. Smart Parent Triggers (in `outbound-sync-phase9.service.ts`)

Automatically queues parent syncs when child attributes change.

#### `handleChildVariationChange(childProductId, changeType, payload)`

**Triggered when:**
- Child product's `categoryAttributes` field is updated

**Process:**
1. Fetch child product with master product
2. Check if variation attributes changed
3. For each Amazon listing of parent:
   - Validate listing has variation theme
   - Queue LISTING_SYNC with source = "CHILD_VARIATION_CHANGE"
   - Set holdUntil to 5 minutes (grace period)

**Payload:**
```json
{
  "source": "CHILD_VARIATION_CHANGE",
  "triggerChildProductId": "cmodnp18m0001njoa658e9qns",
  "triggerChildSku": "xracing-red",
  "changedFields": ["categoryAttributes"],
  "reason": "Parent listing must be updated when child variation attributes change",
  "variationTheme": "Color"
}
```

**Logging:**
```
Child variation attributes changed - triggering parent sync
  childProductId: "cmodnp18m0001njoa658e9qns"
  childSku: "xracing-red"
  parentProductId: "cmoakom7o006vnjmpq9njn46w"
  parentSku: "xracing"

Queued parent variation sync (smart trigger)
  parentProductId: "cmoakom7o006vnjmpq9njn46w"
  parentSku: "xracing"
  listingId: "cmodnp18y0007njoa4forfgy0"
  channelMarket: "AMAZON_US"
  triggerChildSku: "xracing-red"
```

## Variation Mapping Configuration

The `variationMapping` JSON in ChannelListing defines how master attributes map to platform attributes.

**Example for Color Variation:**
```json
{
  "Color": {
    "masterAttribute": "color",
    "platformAttribute": "Color",
    "values": {
      "Red": "Red",
      "Blue": "Blue",
      "Black": "Black"
    }
  }
}
```

**Example for Size Variation:**
```json
{
  "Size": {
    "masterAttribute": "size",
    "platformAttribute": "Size",
    "values": {
      "S": "Small",
      "M": "Medium",
      "L": "Large",
      "XL": "X-Large"
    }
  }
}
```

**Example for Size + Color:**
```json
{
  "Size": {
    "masterAttribute": "size",
    "platformAttribute": "Size",
    "values": { "S": "Small", "M": "Medium", "L": "Large" }
  },
  "Color": {
    "masterAttribute": "color",
    "platformAttribute": "Color",
    "values": { "Red": "Red", "Blue": "Blue", "Black": "Black" }
  }
}
```

## Sync Flow

### 1. User Updates Child Product Attribute

```
User edits xracing-red product
  → Changes categoryAttributes.color from "Red" to "Crimson"
  → Saves product
```

### 2. Smart Parent Trigger Fires

```
handleChildVariationChange() called
  → Detects categoryAttributes changed
  → Finds parent product (xracing)
  → Finds Amazon listing with variationTheme = "Color"
  → Queues LISTING_SYNC with source = "CHILD_VARIATION_CHANGE"
  → Sets holdUntil = now + 5 minutes (grace period)
```

### 3. Grace Period (5 minutes)

```
User can cancel the sync within 5 minutes
  → DELETE /api/outbound/queue/:queueId
  → Sync is removed from queue
```

### 4. Autopilot Processes Sync

```
After 5 minutes, Autopilot picks up the sync
  → Calls variationSyncProcessor.processVariationSync()
  → Builds Amazon variation payload
  → Logs payload in sandbox mode
  → Marks sync as SUCCESS
```

### 5. Payload Logged

```
🎯 AMAZON SP-API VARIATION PAYLOAD (SANDBOX MODE)
  productSku: "xracing"
  variationTheme: "Color"
  childCount: 3
  
  payload: {
    items: [
      { sku: "xracing", parentage: "parent", variationTheme: "Color", ... },
      { sku: "xracing-red", parentage: "child", parentSku: "xracing", Color: "Crimson", ... },
      { sku: "xracing-blue", parentage: "child", parentSku: "xracing", Color: "Blue", ... },
      { sku: "xracing-black", parentage: "child", parentSku: "xracing", Color: "Black", ... }
    ]
  }
```

## Integration Points

### 1. Product Update API

When a child product is updated via the Matrix Editor:

```typescript
// In the product update endpoint
await outboundSyncServicePhase9.handleChildVariationChange(
  productId,
  'UPDATE',
  changedFields
);
```

### 2. Autopilot Sync Cycle

In the Autopilot heartbeat loop:

```typescript
// Get pending syncs
const items = await outboundSyncServicePhase9.getPendingSyncItems();

for (const item of items) {
  // Check if it's a variation sync
  if (variationSyncProcessor.isVariationSync(item)) {
    await variationSyncProcessor.processVariationSync(item);
  } else {
    // Handle other sync types
  }
}
```

## Sandbox Mode

Currently, the system logs variation payloads instead of sending them to Amazon.

**To enable real Amazon sync:**
1. Implement Amazon SP-API client
2. Replace logging with actual API call
3. Handle Amazon response (ASIN assignment, etc.)
4. Update sync status based on Amazon response

**Example:**
```typescript
// In variationSyncProcessor.processVariationSync()
const response = await amazonSpApiClient.submitVariationPayload(
  variationPayload
);

if (response.success) {
  // Update product with Amazon ASINs
  // Mark sync as SUCCESS
} else {
  // Mark sync as FAILED with error
}
```

## Testing

### Manual Test: Trigger Parent Sync

1. Navigate to xracing-red product edit page
2. Change categoryAttributes.color from "Red" to "Crimson"
3. Save product
4. Check API logs for:
   - "Child variation attributes changed - triggering parent sync"
   - "Queued parent variation sync (smart trigger)"
5. Wait 5 minutes or manually trigger Autopilot
6. Check logs for:
   - "🎯 AMAZON SP-API VARIATION PAYLOAD (SANDBOX MODE)"
   - Full payload with updated color

### Verify Payload Structure

The logged payload should include:
- Parent item with parentage = "parent"
- Child items with parentage = "child" and parentSku
- Variation attributes mapped correctly
- All pricing and inventory data

## Files Created/Modified

**Created:**
- `apps/api/src/services/amazon-mapper.service.ts` - Variation payload builder
- `apps/api/src/services/variation-sync-processor.service.ts` - Sync processor
- `docs/PHASE12D-VARIATION-SYNC-ENGINE.md` - This documentation

**Modified:**
- `apps/api/src/services/outbound-sync-phase9.service.ts` - Added variation sync methods

## Next Steps

### Phase 12e: Amazon SP-API Integration
- Implement real Amazon SP-API client
- Handle parent ASIN assignment
- Sync child ASINs
- Handle variation family updates

### Phase 12f: Multi-Attribute Variations
- Support Size + Color variations
- Support Material + Color variations
- Handle complex variation themes

### Phase 12g: Variation Sync Monitoring
- Dashboard for variation sync status
- Alerts for failed variation syncs
- Variation family health checks

## Summary

The Variation Sync Engine successfully:
- ✅ Translates Hub & Spoke Matrix to Amazon SP-API format
- ✅ Builds complete parent/child payloads with variation attributes
- ✅ Implements smart parent triggers for child attribute changes
- ✅ Logs payloads in sandbox mode for verification
- ✅ Integrates with Autopilot grace period (5-minute undo window)
- ✅ Provides comprehensive logging for debugging

The system is ready for visual testing and Amazon SP-API integration.
