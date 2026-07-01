# Task B1 Report — channelListingId + per-cell Resync action

## Shaper / endpoint change

### control-tower.service.ts
- Added `channelListingId: string` to `ControlTowerListing` interface.
- Added `channelListingId: string` to `ControlTowerChannelCell` interface.
- In `buildControlTowerRows`, the cell return object now includes `channelListingId: listing.channelListingId`, carrying the DB id through the pure shaper.

### control-tower.routes.ts
- In the `inputs.push()` block, the `listings` array mapping now includes `channelListingId: l.id` (where `l` is a `ChannelListing` row from Prisma).

## Resync action + bulk-action contract

The Resync button POSTs to `POST /api/listings/bulk-action` with:
```json
{ "action": "resync", "listingIds": ["<channelListingId>"] }
```

The route validates the action, creates a `BulkActionJob`, and runs the worker async. For `action: "resync"`, the worker sets `syncStatus = 'PENDING'`, `lastSyncStatus = 'PENDING'`, `syncRetryCount = 0`, `lastSyncError = null` on the `ChannelListing` row. The route responds `202 { jobId, status: 'QUEUED', total: 1 }`.

## Frontend wiring (ControlTowerClient.tsx)

- `ChannelEntry` interface now includes `channelListingId: string`.
- `resyncingCell: string | null` state tracks which cell's resync is in-flight (keyed by `channelListingId`).
- `resyncCell(channelListingId, label)` function: confirm → POST → toast → `load()`. Follows exact same pattern as `bulkRetry`.
- A `RotateCcw` icon-button (already imported) appears next to the existing `Eye` delta-preview button in every channel cell. While resyncing, shows `Loader2 animate-spin` and is `disabled`.
- Hover style uses DS tokens: `text-tertiary` default, `hover:text-orange-600 hover:bg-orange-50` to distinguish from the blue Eye button.
- No raw `text-slate-*` or `border-slate-*` added; only DS tokens + existing palette pattern.

## Verification results

### vitest
```
Test Files  1 passed (1)
Tests       29 passed (29)   ← 28 original + 1 new channelListingId pass-through test
```

### tsc (API)
No errors.

### tsc (web)
No errors.

## Self-review

- `channelListingId` flows: DB → service interface → shaper → cell → JSON response → frontend `ChannelEntry` → Resync POST body. End-to-end wired.
- The only new network call is `POST /api/listings/bulk-action`; no new endpoints were added.
- No existing tests broken. New test explicitly verifies the pass-through property.
- Confirm/toast/refresh pattern is identical to `bulkRetry` — no hand-rolled dialogs.
- DS compliance: `text-tertiary` for icon default state; no new raw slate tokens.
- ESM `.js` imports unchanged (service file has no imports to add).
