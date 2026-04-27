# Phase 15: Publishing Matrix - Completion Summary

## Executive Summary

Phase 15 successfully implements granular, platform-specific publishing control through three key mechanisms:

1. **Master Publishing Toggle** - Control whether entire platform listings sync
2. **Offer-Level Toggles** - Control whether specific fulfillment methods (FBA/FBM) sync
3. **Analytics Grouping Key** - Group FBA/FBM offers under single ASIN for analytics

This solves the critical problem of preventing duplicate offers from syncing to platforms like Shopify that don't support multiple fulfillment methods, while maintaining complete granular control.

---

## What Was Built

### 1. Database Schema Updates ✅

**File**: `packages/database/prisma/schema.prisma`

Added to `ChannelListing` model:
```prisma
platformProductId String?  // Analytics grouping key (ASIN for Amazon, ItemID for eBay)
isPublished       Boolean @default(true)  // Master publishing toggle
```

**Migration**: `npx prisma db push` - Successfully applied

---

### 2. Frontend UI Components ✅

#### PlatformTab.tsx
**File**: `apps/web/src/app/catalog/[id]/edit/tabs/PlatformTab.tsx`

**Changes**:
- Added `isPublished` and `platformProductId` to ChannelListing interface
- Added `handleTogglePublished()` callback
- Added `handlePlatformProductIdChange()` callback
- Added master publishing toggle UI (green/red button at top of listing)
- Added platformProductId input field with platform-specific labels
- Unpublished listings show dimmed UI (opacity-60)

**UI Features**:
- Color-coded toggle (green = published, red = unpublished)
- Clear messaging: "This listing will [not] be synced to [Platform]"
- Platform-specific labels:
  - Amazon: "ASIN (For Analytics Grouping)"
  - eBay: "eBay Item ID"
  - Others: "Product ID"

#### OfferCard.tsx
**File**: `apps/web/src/app/catalog/[id]/edit/tabs/OfferCard.tsx`

**Changes**:
- Added `isActive` to Offer interface
- Added `handleToggleActive()` callback
- Added active offer toggle UI in expanded view
- Debounced updates to parent component

**UI Features**:
- Color-coded toggle (green = active, gray = inactive)
- Clear messaging: "This offer will [not] be synced to the platform"
- Appears right after offer header for prominence

---

### 3. Backend Sync Logic ✅

#### BullMQ Autopilot Worker
**File**: `apps/api/src/workers/bullmq-sync.worker.ts`

**Changes**:
- Added publishing control checks after grace period check
- Check 1: Verify `ChannelListing.isPublished === true`
  - If false: Skip sync, mark as SKIPPED, log reason
- Check 2: Verify at least one `Offer.isActive === true` (for offer syncs)
  - If all false: Skip sync, mark as SKIPPED, log reason

**Execution Flow**:
```
Job received
  ↓
Grace period check (Phase 12a)
  ↓
✨ Publishing checks (Phase 15)
  ├─ Is listing published?
  └─ Are there active offers?
  ↓
Sync execution (if all checks pass)
```

#### Amazon Mapper Service
**File**: `apps/api/src/services/amazon-mapper.service.ts`

**Changes**:
- Added `buildOfferPayload()` method
- Filters offers where `isActive !== false`
- Returns payload with:
  - Only active offers
  - platformProductId for analytics grouping
  - Active/total offer counts

**Method Signature**:
```typescript
async buildOfferPayload(channelListingId: string): Promise<{
  channelListingId: string
  platformProductId?: string
  offers: Array<{
    sku: string
    fulfillmentMethod: 'FBA' | 'FBM'
    price: number
    quantity: number
    isActive: boolean
  }>
  activeCount: number
  totalCount: number
}>
```

---

## Key Features

### 1. Master Publishing Toggle

**Purpose**: Prevent entire platform from syncing

**Use Case**: Shopify doesn't support multiple fulfillment methods
- Create FBA + FBM listings for Amazon
- Create single listing for Shopify
- Toggle `isPublished = false` on Shopify
- Sync skips Shopify entirely

**UI**:
- Prominent green/red button at top of listing
- Clear status message
- Dimmed listing content when unpublished

### 2. Offer-Level Toggles

**Purpose**: Control which fulfillment methods sync

**Use Case**: FBM warehouse temporarily closed
- Toggle `isActive = false` on FBM offer
- Sync only includes FBA
- When warehouse reopens, toggle back to true

**UI**:
- Green/gray button in offer card
- Clear status message
- Appears in expanded view for prominence

### 3. Analytics Grouping Key

**Purpose**: Group FBA/FBM under single ASIN for analytics

**Use Case**: Track combined FBA + FBM sales
- Set `platformProductId = "B0123456789"` on both FBA and FBM listings
- Analytics systems group by platformProductId
- Reports show combined performance

**UI**:
- Text input field with platform-specific label
- Helper text explaining purpose
- Placeholder examples (B0123456789 for Amazon)

---

## Sync Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│ User toggles isPublished or isActive in UI                  │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Changes saved to database                                   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Sync triggered (manual or scheduled)                        │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ BullMQ Worker receives job                                  │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Check grace period (Phase 12a)                              │
│ ✓ If cancelled → SKIP                                       │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ ✨ Check isPublished (Phase 15)                             │
│ ✗ If false → SKIP, mark SKIPPED, log reason                │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ ✨ Check active offers (Phase 15)                           │
│ ✗ If all inactive → SKIP, mark SKIPPED, log reason         │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Build payload with only active offers                       │
│ Include platformProductId for analytics                     │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Send to platform API (Amazon, eBay, Shopify, etc.)         │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────────────┐
│ Update sync queue record with result                        │
│ Log success/failure with context                            │
└─────────────────────────────────────────────────────────────┘
```

---

## Logging Examples

### Unpublished Listing Skip
```
⏭️ Skipping unpublished listing
  queueId: "queue_abc123"
  channelListingId: "listing_def456"
  reason: "Listing isPublished = false"
```

### No Active Offers Skip
```
⏭️ Skipping sync with no active offers
  queueId: "queue_abc123"
  channelListingId: "listing_def456"
  reason: "All offers are inactive"
```

### Offer Payload Built
```
Building offer payload
  channelListingId: "listing_def456"
  activeCount: 1
  totalCount: 2
```

---

## Testing Verification

✅ **Database Migration**
- Schema updated with new fields
- Default values applied correctly
- Prisma client regenerated

✅ **Frontend UI**
- Master toggle renders correctly
- platformProductId input accepts values
- Offer toggle renders in expanded view
- Dimming effect works when unpublished
- All handlers fire correctly

✅ **Backend Logic**
- Publishing checks execute before sync
- Unpublished listings are skipped
- Inactive offers are filtered
- Payload includes only active offers
- platformProductId included in payload
- All decisions logged with context

---

## Files Modified

| File | Changes | Lines |
|------|---------|-------|
| `schema.prisma` | +2 fields to ChannelListing | +5 |
| `PlatformTab.tsx` | +Master toggle, +platformProductId input | +80 |
| `OfferCard.tsx` | +isActive toggle | +50 |
| `bullmq-sync.worker.ts` | +Publishing checks | +60 |
| `amazon-mapper.service.ts` | +buildOfferPayload() method | +70 |

**Total**: 5 files modified, ~265 lines added

---

## Documentation Created

1. **PHASE15-PUBLISHING-MATRIX.md** (Comprehensive guide)
   - Database schema changes
   - Frontend implementation details
   - Backend sync logic
   - Use cases and examples
   - API routes
   - Testing checklist

2. **PHASE15-QUICK-REFERENCE.md** (Quick lookup)
   - What's new table
   - UI changes summary
   - Common scenarios
   - API endpoints
   - Troubleshooting

3. **PHASE15-COMPLETION-SUMMARY.md** (This document)
   - Executive summary
   - What was built
   - Key features
   - Sync flow diagram
   - Testing verification

---

## Integration Points

### With Phase 12a (Grace Period)
- Publishing checks execute AFTER grace period check
- If user cancels during grace period, publishing checks never run
- Maintains undo functionality

### With Phase 13 (BullMQ)
- Publishing checks integrated into worker job processing
- Skipped syncs marked with SKIPPED status
- Error messages logged for audit trail

### With Amazon Mapper
- New `buildOfferPayload()` method filters active offers
- platformProductId included for analytics grouping
- Maintains compatibility with existing variation payload builder

---

## Performance Impact

- **Database**: Minimal (2 new nullable fields)
- **Sync Logic**: +2 database queries per sync (to fetch listing + offers)
- **Payload Size**: Reduced (only active offers included)
- **Logging**: Minimal overhead (standard logger calls)

---

## Security Considerations

- Publishing toggles are user-controlled (no API key required)
- Changes are logged for audit trail
- Sync skips are marked clearly in queue records
- No sensitive data exposed in logs

---

## Backward Compatibility

✅ **Fully backward compatible**
- New fields have default values (`isPublished = true`, `platformProductId = null`)
- Existing listings continue to sync normally
- No breaking changes to API contracts
- Existing offers default to `isActive = true`

---

## Next Steps

### Immediate (Phase 16)
1. Bulk publishing controls (toggle multiple listings at once)
2. Publishing audit trail (who toggled what, when)
3. Analytics dashboard with platformProductId grouping

### Future (Phase 17+)
1. Scheduled publishing (publish at specific times)
2. Publishing rules (auto-publish based on conditions)
3. Publishing templates (save/reuse publishing configurations)

---

## Success Criteria Met

✅ Master toggle prevents entire platform from syncing
✅ Offer toggles prevent specific fulfillment methods from syncing
✅ Analytics grouping key groups FBA/FBM under single ASIN
✅ UI is intuitive with clear status messages
✅ Sync logic respects publishing controls
✅ All decisions are logged for audit trail
✅ Backward compatible with existing data
✅ Comprehensive documentation provided

---

## Conclusion

Phase 15 successfully delivers granular publishing control to the Nexus Commerce platform. Users can now:

1. **Prevent duplicate offers** from syncing to platforms that don't support multiple fulfillment methods
2. **Disable specific fulfillment methods** temporarily (e.g., when warehouse is closed)
3. **Group analytics** by ASIN to track combined FBA + FBM performance

The implementation is clean, well-documented, and fully integrated with existing sync infrastructure.
