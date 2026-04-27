# Phase 15: Publishing Matrix - Publishing Toggles & ASIN Grouping

## Overview

Phase 15 implements granular, platform-specific publishing control through two key mechanisms:

1. **Master Publishing Toggle** (`isPublished`) - Controls whether an entire platform listing syncs
2. **Offer-Level Toggles** (`isActive`) - Controls whether specific fulfillment methods (FBA/FBM) sync
3. **Analytics Grouping Key** (`platformProductId`) - Groups FBA/FBM offers under a single ASIN for analytics

This prevents duplicate offers from syncing to platforms like Shopify that don't support multiple fulfillment methods, while maintaining granular control over what gets published where.

---

## Database Schema Changes

### ChannelListing Model

Added two new fields:

```prisma
model ChannelListing {
  // ... existing fields ...
  
  // PHASE 15: Analytics Grouping Key
  // For Amazon: ASIN (groups FBA/FBM under single ASIN for analytics)
  // For eBay: ItemID (groups variations under single listing)
  // For Shopify: Product ID (groups variants)
  platformProductId String?
  
  // PHASE 15: Publishing Control
  // Master toggle: when false, this listing will not sync to the platform
  isPublished Boolean @default(true)
}
```

### Offer Model

The `isActive` field already existed but is now critical for Phase 15:

```prisma
model Offer {
  // ... existing fields ...
  
  // PHASE 15: Offer-level publishing control
  // When false, this specific fulfillment method will not sync
  isActive Boolean @default(true)
}
```

---

## Frontend Implementation

### PlatformTab.tsx

#### 1. Master Publishing Toggle

Added at the top of each listing section:

```tsx
{/* PHASE 15: Master Publishing Toggle */}
<div className={`rounded-lg p-4 border-2 transition-all ${
  activeListing.isPublished
    ? 'bg-green-50 border-green-300'
    : 'bg-red-50 border-red-300'
}`}>
  <div className="flex items-center justify-between">
    <div>
      <h4 className="font-semibold text-gray-900">
        Publish to {platform.charAt(0).toUpperCase() + platform.slice(1)}
      </h4>
      <p className="text-sm text-gray-600 mt-1">
        {activeListing.isPublished
          ? '✓ This listing will be synced to the platform'
          : '✗ This listing will NOT be synced to the platform'}
      </p>
    </div>
    <button
      onClick={handleTogglePublished}
      className={`px-4 py-2 rounded-lg transition-colors font-medium ${
        activeListing.isPublished
          ? 'bg-green-600 text-white hover:bg-green-700'
          : 'bg-red-600 text-white hover:bg-red-700'
      }`}
    >
      {activeListing.isPublished ? '✓ Published' : '✗ Unpublished'}
    </button>
  </div>
</div>
```

When unpublished, the rest of the listing section is visually dimmed with `opacity-60`.

#### 2. Analytics Grouping Key (platformProductId)

Added after the external listing ID field:

```tsx
{/* PHASE 15: Platform Product ID (Analytics Grouping Key) */}
<div>
  <label className="block text-sm font-medium text-gray-700 mb-2">
    {platform.toLowerCase() === 'amazon' 
      ? 'ASIN (For Analytics Grouping)' 
      : platform.toLowerCase() === 'ebay'
      ? 'eBay Item ID'
      : 'Product ID'}
  </label>
  <input
    type="text"
    value={activeListing.platformProductId || ''}
    onChange={(e) => handlePlatformProductIdChange(e.target.value)}
    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
    placeholder={platform.toLowerCase() === 'amazon' ? 'e.g., B0123456789' : 'e.g., 123456789012'}
  />
  <p className="text-xs text-gray-500 mt-1">
    {platform.toLowerCase() === 'amazon'
      ? 'Groups FBA/FBM offers under a single ASIN for analytics'
      : 'Groups variations under a single listing for analytics'}
  </p>
</div>
```

### OfferCard.tsx

#### Active Offer Toggle

Added in the expanded view, right after the header:

```tsx
{/* PHASE 15: Active Offer Toggle */}
<div className={`rounded-lg p-4 border-2 transition-all ${
  formData.isActive
    ? 'bg-green-50 border-green-300'
    : 'bg-gray-50 border-gray-300'
}`}>
  <div className="flex items-center justify-between">
    <div>
      <h4 className="font-semibold text-gray-900">Active Offer</h4>
      <p className="text-sm text-gray-600 mt-1">
        {formData.isActive
          ? '✓ This offer will be synced to the platform'
          : '✗ This offer will NOT be synced to the platform'}
      </p>
    </div>
    <button
      onClick={handleToggleActive}
      className={`px-4 py-2 rounded-lg transition-colors font-medium ${
        formData.isActive
          ? 'bg-green-600 text-white hover:bg-green-700'
          : 'bg-gray-400 text-white hover:bg-gray-500'
      }`}
    >
      {formData.isActive ? '✓ Active' : '✗ Inactive'}
    </button>
  </div>
</div>
```

---

## Backend Implementation

### BullMQ Autopilot Worker (bullmq-sync.worker.ts)

Added critical publishing checks after the grace period check:

```typescript
// PHASE 15: Publishing Control Checks
// Skip sync if listing is unpublished or offers are inactive
if (channelListingId) {
  const channelListing = await prisma.channelListing.findUnique({
    where: { id: channelListingId },
    include: { offers: true },
  })

  if (!channelListing) {
    logger.warn('Channel listing not found', { channelListingId })
    throw new Error(`Channel listing ${channelListingId} not found`)
  }

  // Check if listing is published
  if (!channelListing.isPublished) {
    logger.info('⏭️ Skipping unpublished listing', {
      queueId,
      channelListingId,
      reason: 'Listing isPublished = false',
    })
    await prisma.outboundSyncQueue.update({
      where: { id: queueId },
      data: {
        syncStatus: 'SKIPPED',
        errorMessage: 'Listing is unpublished (isPublished = false)',
      },
    })
    return { status: 'SKIPPED', queueId, reason: 'Listing unpublished' }
  }

  // Check if all offers are inactive (for offer-specific syncs)
  if (syncType === 'OFFER_SYNC' && channelListing.offers.length > 0) {
    const activeOffers = channelListing.offers.filter((o) => o.isActive !== false)
    if (activeOffers.length === 0) {
      logger.info('⏭️ Skipping sync with no active offers', {
        queueId,
        channelListingId,
        reason: 'All offers are inactive',
      })
      await prisma.outboundSyncQueue.update({
        where: { id: queueId },
        data: {
          syncStatus: 'SKIPPED',
          errorMessage: 'No active offers to sync',
        },
      })
      return { status: 'SKIPPED', queueId, reason: 'No active offers' }
    }
  }
}
```

### Amazon Mapper Service (amazon-mapper.service.ts)

Added new method to build offer payloads with isActive filtering:

```typescript
/**
 * PHASE 15: Build offer payload with isActive filtering
 * Only includes active offers in the payload
 */
async buildOfferPayload(channelListingId: string): Promise<any> {
  try {
    logger.info('Building offer payload', { channelListingId });

    const channelListing = await prisma.channelListing.findUnique({
      where: { id: channelListingId },
      include: {
        offers: true,
        product: true,
      },
    });

    if (!channelListing) {
      throw new Error(`ChannelListing not found: ${channelListingId}`);
    }

    // PHASE 15: Filter only active offers
    const activeOffers = channelListing.offers.filter((offer) => offer.isActive !== false);

    if (activeOffers.length === 0) {
      logger.warn('No active offers found for channel listing', { channelListingId });
      return {
        channelListingId,
        offers: [],
        activeCount: 0,
        totalCount: channelListing.offers.length,
      };
    }

    // Build offer items
    const offerItems = activeOffers.map((offer) => ({
      sku: offer.sku,
      fulfillmentMethod: offer.fulfillmentMethod,
      price: offer.price ? Number(offer.price) : Number(channelListing.price),
      quantity: offer.quantity || channelListing.quantity,
      isActive: offer.isActive,
    }));

    return {
      channelListingId,
      platformProductId: channelListing.platformProductId,
      offers: offerItems,
      activeCount: activeOffers.length,
      totalCount: channelListing.offers.length,
    };
  } catch (error) {
    logger.error('Error building offer payload', {
      error: error instanceof Error ? error.message : String(error),
      channelListingId,
    });
    throw error;
  }
}
```

---

## Sync Flow with Publishing Controls

### Before Sync Execution

```
1. BullMQ Worker receives job
2. Check grace period (Phase 12a)
3. ✨ NEW: Check if ChannelListing.isPublished === true
   - If false → SKIP sync, mark as SKIPPED
4. ✨ NEW: Check if any Offer.isActive === true (for offer syncs)
   - If all false → SKIP sync, mark as SKIPPED
5. Proceed with sync if all checks pass
```

### Offer Payload Building

```
1. Fetch ChannelListing with all Offers
2. ✨ NEW: Filter offers where isActive !== false
3. Build payload with only active offers
4. Include platformProductId for analytics grouping
5. Send to platform API
```

---

## Use Cases

### Use Case 1: Disable Shopify Listing

**Scenario**: You have FBA and FBM offers for Amazon, but Shopify doesn't support multiple fulfillment methods.

**Solution**:
1. Create two Amazon listings (one for FBA, one for FBM)
2. Create one Shopify listing
3. Toggle `isPublished = false` on the Shopify listing
4. Sync will skip Shopify entirely, preventing duplicate offers

### Use Case 2: Disable FBM Temporarily

**Scenario**: Your FBM warehouse is closed for inventory, but FBA is still active.

**Solution**:
1. Toggle `isActive = false` on the FBM offer
2. Sync will only include the FBA offer
3. When warehouse reopens, toggle `isActive = true` again

### Use Case 3: Analytics Grouping

**Scenario**: You want to track FBA and FBM sales under a single ASIN for analytics.

**Solution**:
1. Set `platformProductId = "B0123456789"` on both FBA and FBM listings
2. Analytics systems can group by platformProductId
3. Reports show combined FBA + FBM performance under one ASIN

---

## API Routes

### Update ChannelListing

```http
PATCH /api/matrix/listings/:id
Content-Type: application/json

{
  "isPublished": true,
  "platformProductId": "B0123456789"
}
```

### Update Offer

```http
PATCH /api/matrix/offers/:id
Content-Type: application/json

{
  "isActive": true
}
```

---

## Logging & Monitoring

All publishing control decisions are logged:

```
⏭️ Skipping unpublished listing
  queueId: "queue_123"
  channelListingId: "listing_456"
  reason: "Listing isPublished = false"

⏭️ Skipping sync with no active offers
  queueId: "queue_123"
  channelListingId: "listing_456"
  reason: "All offers are inactive"

Building offer payload
  channelListingId: "listing_456"
  activeCount: 1
  totalCount: 2
```

---

## Testing Checklist

- [ ] Toggle `isPublished` on a listing and verify sync is skipped
- [ ] Toggle `isActive` on an offer and verify it's excluded from payload
- [ ] Set `platformProductId` and verify it appears in sync logs
- [ ] Verify unpublished listings show dimmed UI
- [ ] Verify inactive offers show dimmed UI
- [ ] Test with multiple offers (some active, some inactive)
- [ ] Verify analytics grouping works across FBA/FBM

---

## Files Modified

1. **packages/database/prisma/schema.prisma**
   - Added `platformProductId` to ChannelListing
   - Added `isPublished` to ChannelListing

2. **apps/web/src/app/catalog/[id]/edit/tabs/PlatformTab.tsx**
   - Added master publishing toggle UI
   - Added platformProductId input field
   - Added handlers for both

3. **apps/web/src/app/catalog/[id]/edit/tabs/OfferCard.tsx**
   - Added isActive toggle UI
   - Added handler for toggle

4. **apps/api/src/workers/bullmq-sync.worker.ts**
   - Added publishing control checks before sync execution

5. **apps/api/src/services/amazon-mapper.service.ts**
   - Added `buildOfferPayload()` method with isActive filtering

---

## Next Steps

1. Update Matrix API routes to accept/save new fields
2. Add analytics dashboard to show platformProductId grouping
3. Implement bulk publishing controls (toggle multiple listings at once)
4. Add publishing audit trail (who toggled what, when)
