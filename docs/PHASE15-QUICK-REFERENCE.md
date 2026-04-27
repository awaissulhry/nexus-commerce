# Phase 15: Publishing Matrix - Quick Reference

## What's New

Three new controls for granular publishing management:

| Control | Location | Purpose | Default |
|---------|----------|---------|---------|
| **Master Toggle** | ChannelListing.isPublished | Prevent entire platform from syncing | `true` |
| **Offer Toggle** | Offer.isActive | Prevent specific fulfillment method from syncing | `true` |
| **Analytics Key** | ChannelListing.platformProductId | Group FBA/FBM under single ASIN | `null` |

---

## UI Changes

### Platform Tab (PlatformTab.tsx)

**Before**: No publishing controls
**After**: 
- Green/Red toggle at top: "Publish to [Platform]"
- New input field: "ASIN (For Analytics Grouping)" for Amazon
- Unpublished listings appear dimmed

### Offer Card (OfferCard.tsx)

**Before**: No offer-level controls
**After**:
- Green/Gray toggle: "Active Offer"
- Inactive offers won't sync to platform

---

## Database Changes

```sql
-- ChannelListing table
ALTER TABLE "ChannelListing" ADD COLUMN "platformProductId" TEXT;
ALTER TABLE "ChannelListing" ADD COLUMN "isPublished" BOOLEAN DEFAULT true;

-- Offer table (isActive already exists)
-- No changes needed
```

---

## Sync Logic Changes

### Before Sync Execution

```
Job received → Grace period check → ✨ Publishing checks → Sync
```

### Publishing Checks

```typescript
// Check 1: Is listing published?
if (!channelListing.isPublished) {
  return SKIP // Don't sync
}

// Check 2: Are there active offers?
const activeOffers = offers.filter(o => o.isActive !== false)
if (activeOffers.length === 0) {
  return SKIP // Don't sync
}

// Check 3: Build payload with only active offers
const payload = {
  offers: activeOffers,
  platformProductId: channelListing.platformProductId
}
```

---

## Common Scenarios

### Scenario 1: Disable Shopify (Multiple Fulfillment Methods)

```
Amazon: FBA + FBM (2 listings)
Shopify: Single listing (doesn't support multiple fulfillment)

Solution:
1. Create Shopify listing
2. Toggle isPublished = false
3. Sync skips Shopify entirely
```

### Scenario 2: Disable FBM Temporarily

```
Amazon: FBA (active) + FBM (warehouse closed)

Solution:
1. Open FBM offer
2. Toggle isActive = false
3. Sync only includes FBA
4. When warehouse reopens, toggle isActive = true
```

### Scenario 3: Analytics Grouping

```
Amazon: FBA listing + FBM listing (same product)

Solution:
1. Set platformProductId = "B0123456789" on both
2. Analytics systems group by platformProductId
3. Reports show combined FBA + FBM sales
```

---

## API Endpoints

### Update Listing Publishing Status

```bash
curl -X PATCH http://localhost:3001/api/matrix/listings/listing_123 \
  -H "Content-Type: application/json" \
  -d '{
    "isPublished": false,
    "platformProductId": "B0123456789"
  }'
```

### Update Offer Status

```bash
curl -X PATCH http://localhost:3001/api/matrix/offers/offer_456 \
  -H "Content-Type: application/json" \
  -d '{
    "isActive": false
  }'
```

---

## Logging

All publishing decisions are logged with context:

```
⏭️ Skipping unpublished listing
  queueId: queue_123
  channelListingId: listing_456
  reason: Listing isPublished = false

⏭️ Skipping sync with no active offers
  queueId: queue_123
  channelListingId: listing_456
  reason: All offers are inactive

Building offer payload
  channelListingId: listing_456
  activeCount: 1
  totalCount: 2
```

---

## Files Changed

| File | Changes |
|------|---------|
| `schema.prisma` | +2 fields to ChannelListing |
| `PlatformTab.tsx` | +Master toggle, +platformProductId input |
| `OfferCard.tsx` | +isActive toggle |
| `bullmq-sync.worker.ts` | +Publishing checks before sync |
| `amazon-mapper.service.ts` | +buildOfferPayload() with filtering |

---

## Testing

```bash
# Test 1: Unpublished listing
1. Create listing
2. Toggle isPublished = false
3. Trigger sync
4. Verify sync is SKIPPED in logs

# Test 2: Inactive offer
1. Create offer
2. Toggle isActive = false
3. Trigger sync
4. Verify offer excluded from payload

# Test 3: Analytics grouping
1. Set platformProductId on listing
2. Trigger sync
3. Verify platformProductId in payload
```

---

## Key Differences from Phase 14

| Aspect | Phase 14 | Phase 15 |
|--------|----------|----------|
| Publishing Control | None | Master toggle + Offer toggles |
| Analytics Grouping | None | platformProductId field |
| Sync Logic | No publishing checks | Checks before execution |
| Offer Filtering | All offers synced | Only active offers synced |
| UI | No toggles | Green/Red toggles |

---

## Troubleshooting

**Q: Listing won't sync**
A: Check if `isPublished = true` and at least one offer has `isActive = true`

**Q: Offer not appearing in payload**
A: Check if offer has `isActive = true`

**Q: Analytics not grouping correctly**
A: Verify `platformProductId` is set on both FBA and FBM listings

**Q: Sync marked as SKIPPED**
A: Check logs for "Skipping unpublished listing" or "no active offers"

---

## Next Phase

Phase 16 will likely focus on:
- Bulk publishing controls
- Publishing audit trail
- Analytics dashboard with platformProductId grouping
- Scheduled publishing (publish at specific times)
