# Phase 1 Restoration Notes

Date: 2026-04-30

## Root cause of the route freeze

`apps/api/src/lib/queue.ts` exported five Redis-backed objects as
**module-level constants**:

```ts
export const outboundSyncQueue = new Queue(...)
export const channelSyncQueue  = new Queue(...)
export const stockUpdateQueue  = new Queue(...)
export const queueEvents             = new QueueEvents(...)
export const channelSyncQueueEvents  = new QueueEvents(...)
```

`new Queue(...)` opens a Redis connection synchronously at construction. Any
route file that imported `lib/queue.ts` — directly or transitively through a
service — therefore tried to connect to Redis the moment Node loaded the
module graph, before `app.listen` was reached. On Railway, `REDIS_URL` was
not yet on `process.env` at module-load time, so the boot crashed and routes
had to be commented out one-by-one as a stopgap.

## Fix: fully lazy queue.ts

`apps/api/src/lib/queue.ts` was rewritten so that **nothing** in the module
opens a Redis connection at load time. The Redis client, all three queues,
and both QueueEvents are created on first access via internal getters
(`getRedisConnection`, `getOutboundSyncQueue`, …). The named exports stay
the same — `outboundSyncQueue`, `channelSyncQueue`, `stockUpdateQueue`,
`queueEvents`, `channelSyncQueueEvents` — but they are now `Proxy` wrappers
that resolve to the real instance on the first method call. Existing call
sites (`outboundSyncQueue.add(...)`, `await stockUpdateQueue.close()`, etc.)
require no changes.

`initializeQueue()` and `closeQueue()` were updated to drive the getters
explicitly so workers/health checks still work when Phase 2 enables them.

## Files refactored

| File | Change |
|---|---|
| `apps/api/src/lib/queue.ts` | Full lazy rewrite; queues + QueueEvents now Proxy-backed singletons |
| `apps/api/src/routes/catalog-safe.routes.ts` | Trimmed to `/amazon/import` only — the rest collided with the now re-enabled `catalog.routes.ts` |
| `apps/api/src/index.ts` | Re-enabled all 20 disabled route imports + registrations |

## Routes re-enabled

All twenty previously commented-out routes are now registered:

- `listingsRoutes`
- `aiRoutes`
- `marketplaceRoutes`
- `adminRoutes`
- `monitoringRoutes`
- `shopifyRoutes`, `shopifyWebhookRoutes`
- `woocommerceRoutes`, `woocommerceWebhookRoutes`
- `estyRoutes`, `estyWebhookRoutes`
- `ebayAuthRoutes`, `ebayRoutes`, `ebayOrdersRoutes`
- `catalogRoutes` (under `/api/catalog`)
- `outboundRoutes`
- `matrixRoutes`
- `inboundRoutes`
- `webhookRoutes`
- `ordersRoutes`

Plus the routes that were already enabled: `inventoryRoutes`, `syncRoutes`,
`catalogSafeRoutes`, `healthRoutes`, `amazonRoutes`.

## Still disabled (intentional — Phase 2)

The HTTP layer is fully restored, but BullMQ infrastructure is still gated:

- `startJobs()` — node-cron job dispatch
- `initializeQueue()` — Redis ping + counts
- `initializeBullMQWorker()`
- `initializeChannelSyncWorker()`
- `initializeBulkListWorker()`
- `closeQueue()` on SIGTERM/SIGINT

These are commented out in `apps/api/src/index.ts`. Phase 2 will turn them
back on once `REDIS_URL` is verified on Railway.

## Breaking changes

**One.** `catalog-safe.routes.ts` lost three endpoints to avoid a Fastify
`FST_ERR_DUPLICATED_ROUTE` crash when both catalog files registered under
`/api/catalog`. The endpoints removed from the safe file were already
duplicates with the same behavior in the full `catalog.routes.ts`:

| Endpoint | Now served by |
|---|---|
| `POST /api/catalog/ebay/import` | `catalog.routes.ts:1503` |
| `GET  /api/catalog/ebay/stats`  | `catalog.routes.ts:1539` |
| `DELETE /api/catalog/products/:id` | `catalog.routes.ts:797` (cascading delete) |

`POST /api/catalog/amazon/import` stays in `catalog-safe.routes.ts` — it has
no equivalent in the full file.

## Verification

Local boot test (`apps/api`, `REDIS_PORT=1` to make Redis unreachable):

- `tsc --noEmit` clean
- All 20 disabled route files import without opening a Redis connection
- Server boots in ~150ms with all routes registered
- No `FST_ERR_DUPLICATED_ROUTE`
- No module-load Redis errors

The `/api/health` endpoint returns 503 when the database is unreachable —
that is the existing behavior (it does a `SELECT 1` round-trip), unrelated
to the queue refactor.

## Next steps

1. Deploy `main` to Railway and tail logs for any module-load Redis errors.
2. Hit `/api/health`, `/api/inventory`, `/api/catalog/...` to confirm 200s.
3. Phase 2: re-enable workers and `initializeQueue()` once Railway env is
   confirmed.

---

## Phase 2: Parent/Child Hierarchy (2026-04-30)

### What was attempted, what worked
- **Catalog Items API path** — abandoned. The SP-API app is missing the
  Catalog Items API role, which is a Restricted Role on the Italian
  Seller Central account and not visible to grant. Re-authorizing did not
  unlock it. `/api/amazon/products/test-catalog-api` confirms:
  `CATALOG_ITEMS_API_BLOCKED: even summaries failed`.
- **Reports API path** — partial. `GET_MERCHANT_LISTINGS_DATA` works (no
  scope issue) but its 30 columns do not include parent SKU or parent
  ASIN. `asin2` and `asin3` columns exist but are entirely empty (0/247
  rows). 18 listings share an `asin1` value, but those are just
  duplicate FBA/FBM listings of the same product, not parent groupings.
- **Title-based grouping** — works. Amazon listings for variation
  children are titled identically to the parent + `" (Size, Color)"`
  appended at the end (and the parent record exists in the DB with the
  full description, no parenthetical). This is the actual signal.

### Solution shipped
A new endpoint `POST /api/amazon/products/auto-group` parses each
product's name with `/^(.+?)\s*\(([^()]+)\)\s*$/`. Children are products
whose name had a trailing parenthetical with short variation attrs
(<60 chars, comma-separated). Parents are products whose full name
matches a child's stripped baseTitle. The `?dryRun=1` flag previews
the plan; `?reset=1` clears the prior (incorrect) SKU-prefix groupings
first. Stock is rolled up child→parent automatically.

### Results — first run on production data
| Metric | Value |
|---|---|
| Total Amazon products | 278 |
| Children with variation parens | 235 |
| Parents found | 12 |
| Children linked | 199 |
| Standalone (no parens or no match) | 67 |
| Orphan children (no parent record) | 36 |

Top groupings (the previously-failing cases now correct):

| Parent SKU | Children | Theme | Notes |
|---|---|---|---|
| `xracing` | 49 | Size/Color | X-Tuta racing suit |
| `GALE-JACKET` | 38 | Size/Color | Black + Yellow merged ✓ |
| `IT-MOSS-JACKET` | 21 | Size/Color | Black + Yellow + Green merged ✓ |
| `3K-HP05-BH9I` | 15 | Size/Color | MISANO leather jacket |
| `VENTRA-JACKET` | 12 | Size/Color | Red + Yellow merged ✓ |
| `REGAL-JACKET` | 12 | Size/Color | Black + Grey merged ✓ |
| `AIRMESH-JACKET` | 12 | Size/Color | Black + Yellow merged ✓ |
| `AIREON` | 12 | Size/Color | Crema + Nero Neo merged ✓ |
| `xavia-knee-slider` | 8 | Size | 8 colors |
| `normal-knee-slider` | 8 | Size | 8 colors |
| `AIR-MESH-JACKET-MEN` | 6 | Size/Color | |
| `WATERPROOF-OVERJACKET-BLACK-MEN` | 6 | Size/Color | |

### 36 orphan children to follow up on
Mostly women's variants (`REGAL-JACKET-*-WOMEN`, `VENTRA-JACKET-*-WOMEN`)
whose parent record (`Da Donna` description) does not exist in the DB —
only the men's parent is imported. Two ways to fix:
1. Import the women's parent records from Amazon Seller Central, then
   re-run `/products/auto-group?reset=1`.
2. Manually merge them via `POST /api/amazon/products/merge` with body
   `{ parentSku, childSkus[], variationTheme }`. (`/products/unmerge` is
   also available to undo a merge.)

### Frontend
- `/api/inventory/top-level` now exposes `childCount` (computed from
  inline children) and `variationTheme` on each parent row. The
  `apps/web/src/components/inventory/columns.tsx` chevron rendering is
  gated on `item.childCount > 0` and was already wired up correctly.
- `apps/web/src/components/inventory/InventoryTable.tsx` lazy-loads
  children via `/api/inventory/{id}/children` (Next.js proxy →
  backend `/api/amazon/products/{id}/children`). Verified: returns the
  expected count for each parent (8, 12, 21, 38 children, etc.).

### Why we did not migrate to a proper hierarchy at the SP-API level
The Catalog Items API role is gated by Amazon's Restricted Role process
in the Italian marketplace. Title-based matching is the pragmatic path.
If the role becomes available later, `/api/amazon/products/reindex-hierarchy`
(already built, blocked on auth right now) will use the real Amazon
parent ASINs and supersede this title heuristic — the existing
parent/child records can be cleared with `?reset=1` on auto-group, then
the reindex re-builds from authoritative data.

---

## Phase 2 V2: Real Amazon Listings-API hierarchy sync (2026-04-30)

### What changed and why
Heuristic title-based grouping was abandoned. The user's directive was
"import the products exactly as they are on Amazon" — which means using
Amazon's authoritative catalog data, not pattern-matching guesses.

The Listings Items API (`getListingsItem`) is in a different SP-API role
group than Catalog Items and **is accessible** to this account. It
returns Amazon's actual product attributes including the hierarchy
fields:

| Amazon field | Persisted as |
|---|---|
| `attributes.parentage_level[0].value` (`parent`/`child`) | `Product.isParent` |
| `attributes.child_parent_sku_relationship[0].parent_sku` | `Product.parentId` (resolved by SKU lookup) |
| `attributes.variation_theme[0].name` (e.g. `SIZE/COLOR`) | `Product.variationTheme` (prettified) |
| `relationships[].variationTheme.attributes` (e.g. `["color","size"]`) | per-attr names |
| `attributes[<name>][0].value` for each name above | `Product.categoryAttributes.variations` |

For products that store size in nested `apparel_size[0].size` rather
than top-level `size[0].value`, a fallback extracts and normalises
(`3x_l` → `3XL`).

### New endpoint
`POST /api/amazon/products/sync-hierarchy?offset=0&limit=25&reset=1`
- Iterates Amazon SKUs in batches (default 25)
- For each SKU, calls `getListingsItem` with
  `includedData=[summaries, attributes, relationships]`
- Persists Amazon's hierarchy + variation values
- `reset=1` (offset=0 only): clears prior groupings before re-syncing
- Final batch rolls up child stock to parents

### Results — real Amazon catalog (verified)
| Metric | Value |
|---|---|
| Total Amazon products | 278 |
| Parents (Amazon's actual count) | **14** |
| Children (linked via `parent_sku`) | 230 |
| Standalone | 34 |
| Lookup errors (Amazon says SKU doesn't exist) | 14 stale local-only SKUs |

Top groupings (Amazon's authoritative themes — note multi-axis):

| Parent SKU | Children | Real Amazon theme |
|---|---|---|
| `xracing` | 49 | `Fit Type / Size Name / Color Name` |
| `VENTRA-JACKET` | 24 | `Size / Color` (men's + women's now correctly merged via parent_sku) |
| `REGAL-JACKET` | 24 | `Size / Color` (men's + women's merged) |
| `AIREON` | 24 | `Team Name / Athlete / Color / Size` (4 axes) |
| `IT-MOSS-JACKET` | 21 | `Color Name / Size Name / Style Name / Pattern Name` (4 axes) |
| `GALE-JACKET` | 18 | `Size / Color` |
| `3K-HP05-BH9I` | 15 | `Size / Color` |
| `AIRMESH-JACKET` | 12 | `Size / Color` |
| `UD-LVLM-1H8T` | 10 | `Color / Size` |
| `1J-EYE5-Y0TW` | 5 | `Color / Size` |

Sample child variation values (per `categoryAttributes.variations`):
```
AIREON-JACKET-CREMA-E-VINO-MEN-3XL →
  { "Color": "Crema e Vino", "Athlete": "Uomo",
    "Team Name": "Giacca", "Size": "3XL" }

xracingbxgxn54 →
  { "Size": "54", "Color": "Bianco x Giallo x Nero",
    "Fit Type": "Regular" }
```

The "Athlete = Uomo" / "Team Name = Giacca" oddity is Amazon's actual
catalog data — the Italian seller listed gender under `athlete` and
product-type under `team_name`. The sync surfaces what's there; it
does not invent.

### Heuristic code removed
The following were deleted now that real-data sync works:
- `apps/api/src/services/variation-parser.service.ts` (heuristic title parser)
- `POST /api/amazon/products/auto-group` (heuristic apply)
- `POST /api/amazon/products/detect-variations` (heuristic dry-run)
- `POST /api/amazon/products/group-by-sku` (the original wrong SKU-prefix grouper)
- `POST /api/amazon/products/reset-sku-grouping`
- `POST /api/amazon/products/reindex-hierarchy` (broken Catalog Items implementation)
- `POST /api/amazon/test-report/:reportType` (Reports API exploration; no parent column found)
- `GET /api/amazon/test-report-status/:reportId`
- `GET /api/amazon/analyze-report/:reportId`

Kept:
- `POST /api/amazon/products/sync-hierarchy` — the real one
- `GET /api/amazon/products/probe-listing?sku=…` — diagnostic for a single SKU
- `POST /api/amazon/products/merge` / `unmerge` — manual hierarchy edit (general-purpose)
- `GET /api/amazon/products/test-catalog-api`, `GET /api/amazon/test-catalog-api`
  (kept for the open Amazon support case)
- `GET /api/amazon/products/debug-hierarchy`, `/products/list`, `/products/count`,
  `GET /api/amazon/products/:id/children`, `GET /api/amazon/products` (catalog import)


---

## Bulk-ops click behaviour change (Step 3.5)

Date: 2026-05-02

**Changed.** Single click on a cell in `/bulk-operations` no longer
enters edit mode. Editing is now reached the way Excel, Sheets, and
Shopify Admin do it:

| Gesture / key | Behaviour |
|---|---|
| Single click | Selects the cell (blue ring, cell becomes the active end of the selection range) |
| Shift+click | Extends the range from the current anchor |
| Click + drag | Rectangle selection |
| Double click | Enters edit mode |
| Selected + Enter / F2 | Enters edit mode (existing value preserved, select-all so any keystroke replaces it) |
| Selected + any printable key | Enters edit mode and replaces the cell value with that key |
| Selected + Escape | Clears the selection |
| Selected + arrow keys | Moves the active cell (Shift+arrow extends the range) |
| Selected + Tab / Shift+Tab | Moves the active cell right / left |
| Editing + Enter | Commits, moves selection down |
| Editing + Tab / Shift+Tab | Commits, moves selection right / left |
| Editing + Escape | Cancels the edit, selection remains |

**Why.** The old single-click-to-edit pattern fought multi-cell
selection (which we just shipped) and prevented the spreadsheet
keyboard model — copy/paste, Tab navigation, type-to-replace, etc.

**Anything to watch for.** Users who have built muscle memory around
the old behaviour will need a moment to adjust. The status-bar pill
now nudges them: `1 cell · Enter or type to edit`.


---

## D.4: Bulk CSV / XLSX upload (v1)

Date: 2026-05-02

File-based alternative to the Step 1–6 spreadsheet copy/paste flow.
The two coexist: copy/paste suits 10–100 cell quick edits with data
already in Excel; CSV upload suits 100+ row catalog updates with a
downloadable template.

**v1 scope**
- Upload CSV / XLSX / XLS up to 50 MB / 50,000 rows.
- Two-stage flow: parse + validate → preview modal → apply on confirm.
- **Updates only.** Unknown SKUs are reported as errors with an
  actionable message (e.g. *SKU "ABC-001" not found — add the product
  via the catalog before updating*). Create-new is deferred to D.4.5
  pending its own design (productType, parent linking, image URLs,
  channel context all need answers).
- **Empty cells = no change.** The empty-cell-clears-data semantic was
  rejected: CSV exporters often emit columns the user doesn't intend
  to touch.
- **Smart parsing** carries through from D.3j: `5kg` / `5,5 kg`
  /`60cm` parse and emit a paired `*Unit` change.
- **Apply** is chunked at 500 changes per Prisma `$transaction`.
  Per-chunk atomicity: if chunk 5 of 10 fails, chunks 1–4 stay
  applied, 6–10 still try.
- **Preview state** lives on `BulkOperation` rows with status
  `PENDING_APPLY` and `expiresAt = now + 30 min`. No Redis
  dependency. Cleanup is a future cron.
- **Templates** at `GET /api/products/bulk-template?view={catalog,
  pricing,inventory,physical,full}` — CSV with editable headers + one
  sample row showing format conventions.

**Endpoints**
- `POST /api/products/bulk-upload` (multipart) → `{ uploadId, preview }`
- `POST /api/products/bulk-apply` `{ uploadId }` → `{ applied, total, status, errors, elapsedMs }`
- `GET /api/products/bulk-template?view=…` → `text/csv`

**Limitations / known follow-ups**
- No upload history UI yet — `BulkOperation` table is the system of
  record; future page can query it.
- Cascade is NOT triggered by upload (parent edits via CSV apply
  directly to the parent only; users wanting fan-out should use the
  per-cell editor).
- SheetJS / `xlsx` parse-only path; see TECH_DEBT entry on the CVE.


---

## D.5: Multi-file ZIP upload (v1)

Date: 2026-05-02

ZIP-archive flow alongside the D.4 single-file (CSV / XLSX) path. Same
preview/apply UX (`POST /api/products/bulk-upload-zip` then re-uses
`POST /api/products/bulk-apply`); the difference is the parser.

**Layout**
```
products.zip/
├── SKU-AAA/
│   ├── data.json        // optional — field updates as JSON
│   └── description.html // optional — HTML body for Product.description
├── SKU-BBB/
│   ├── data.json
│   └── images/
│       └── main.jpg     // ignored in v1, surfaced in preview warnings
└── …
```

**v1 scope**
- Per top-level folder (= SKU): read `data.json` + `description.html`.
- `data.json` accepts the same field IDs as the field registry,
  including a nested `categoryAttributes` object that maps to
  `attr_<key>` registry fields (jsonb merge on apply, no overwrite).
- `description.html` writes to a new `Product.description String?`
  column added by the same migration.
- Empty fields = no change (matches D.4).
- Per-folder error isolation: one bad folder doesn't kill the upload.
- Defensive limits: 10 000 entries, 6-level path depth, 5 000 folders,
  50 KB per `data.json`, 100 KB per `description.html`.
- `images/` and other unrecognised files are silently skipped and
  surfaced as preview warnings.
- Apply path: same `BulkOperation` row as D.4 (`status: PENDING_APPLY`
  → chunked 500-change apply → `SUCCESS` / `PARTIAL` / `FAILED`). The
  apply endpoint now routes `attr_*` changes to a Postgres `jsonb ||`
  merge so categoryAttributes from a ZIP don't blow away keys that
  weren't in the upload.

**Schema add**
```prisma
model Product {
  // …
  description String?  // D.5: HTML body shown on listings
}
```
+ `description` registered in the field registry as editable text so
the spreadsheet/CSV grid can also update it.

**Out of scope (D.5.5 follow-up — see TECH_DEBT entry)**
- Image upload from `images/` folders
- `channels/<channel>.json` per-marketplace overrides
- `variants.csv` per-product variation data

