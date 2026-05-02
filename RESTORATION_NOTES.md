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


---

## Phase 5.4: GTIN exemption — submission package + guided handoff

Date: 2026-05-02

The original spec assumed an Amazon SP-API endpoint for submitting GTIN
exemption applications and polling status. **That endpoint doesn't
exist** — Amazon's GTIN exemption is a Seller Central web flow with
human review by email, no public API surface. The phase pivoted from
"auto-submit + auto-poll" to "perfect submission package + user-driven
status flow", which still kills 90% of the seller's time on this
process (the prep work, not the review wait).

### What ships

- **`GtinExemptionApplication` model** — DRAFT → PACKAGE_READY →
  SUBMITTED → APPROVED / REJECTED / ABANDONED. Indexed on
  `(brandName, marketplace)` for the brand-cache lookup.

- **API**:
  - `GET /api/gtin-exemption/check?brand=&marketplace=` — surfaces
    an existing approved (or pending) application so the wizard
    auto-detects "this brand is already cleared".
  - `POST /api/gtin-exemption` — find-or-create a DRAFT for
    `(brand, marketplace)`. Pre-fills the brand letter from the
    `AccountSettings` record.
  - `GET /api/gtin-exemption/:id`, `PATCH /api/gtin-exemption/:id`
    — read + edit fields and status.
  - `POST /api/gtin-exemption/:id/validate-images` — runs the
    rule-based validator (resolution ≥ 1000×1000, accepted format,
    plausible file size) over the master product's images and
    stores the result on the application.
  - `GET /api/gtin-exemption/:id/brand-letter.pdf` — pdfkit-rendered
    on the fly from the stored text, no storage round-trip.
  - `GET /api/gtin-exemption/:id/package.zip` — the full submission
    package (brand letter PDF + image files + per-marketplace
    `instructions.md`), regenerated on every download from the
    application's current state. First download flips status to
    `PACKAGE_READY`.

- **Wizard step 1 (Identifiers)** — three radio paths (existing
  GTIN, brand already exempted, apply now). Auto-detects the
  product's UPC/EAN/GTIN; runs the brand-cache check on mount and
  pre-selects "have exemption" when an approved record is found.

- **Wizard step 2 (Apply)** — when the user picks the "apply now"
  path, this is the full guided flow: brand verification form
  (trademark / brand stand-in / website-only), image-validation
  panel with per-image diagnostics, brand-letter preview, package
  download button, status tracking. When the user picks one of the
  other paths, step 2 is informational only.

- **User-driven status** — "Mark as submitted" (with optional case
  ID), "Mark as approved" (caches the brand for this marketplace
  forever), "Mark as rejected" (captures Amazon's reason for the
  next package iteration).

### What we don't do (and why)

- **Programmatic submission to Amazon** — no SP-API endpoint.
- **Automatic status polling** — Amazon responds via email, not
  API. User reports the outcome in our UI.
- **Vision-based image checks** (logo / watermark detection,
  background analysis, brand visibility scoring) — deferred to
  Phase 6 once a vision model is wired.
- **AI-generated rejection fixes** — same dependency.
- **Adding new images via the wizard** — v1 uses the master
  product's existing images; if there are < 9 we surface a clear
  message asking the user to add more via the product edit page,
  then re-run validation.

### Sales pitch (the honest version)

90% of the seller's GTIN-exemption pain is **prep**, not Amazon's
review wait. We generate a submission-ready package in 2 minutes
versus 2–3 days of trial-and-error, and the **brand cache** means
each brand only needs ONE successful application — every future
listing for that brand on that marketplace skips this step
entirely.


---

## Phase 5.5: AI content generation (v1)

Date: 2026-05-02

Step 6 of the listing wizard is now wired to a real Gemini Flash
backend. One generation pass produces an Amazon-optimised title,
five themed bullets, an HTML description, and 250-char backend
keywords — all in the marketplace's language.

### What ships

- **`POST /api/listing-content/generate`** — single endpoint with
  field-array selection (`['title','bullets','description','keywords']`).
  Runs the requested prompts in parallel server-side via
  `Promise.all`. Returns whichever fields were asked for, plus a
  metadata block with model, language, elapsed time.
- **`ListingContentService`** — Gemini Flash via the existing
  `GeminiService`. Per-field prompt templates with structured-JSON
  output contracts. Temperature bumped per `variant` so repeated
  regenerations produce visibly different copy.
- **Step 6 UI** — per-field generate / regenerate, inline editing,
  live char counts, AI-supplied "insights" badges (✓ Brand at start
  / ✓ Italian localisation / etc.) so the user sees why the
  suggestion is good. Auto-saves the entire content slice into
  `wizardState.content` after every generation or edit, so the
  user can resume where they left off.
- **Localisation** — the prompt switches language by marketplace
  (IT → Italian, DE → German, FR → French, ES → Spanish, UK →
  British English with proper spellings, US → American English,
  plus NL / SE / PL / CA / MX). Falls back to English for any
  marketplace not in the table.
- **Cost / latency** — Flash, not Pro: ~$0.0005 per field
  generation, < 1s typical. 4-field "Generate all" lands in
  < 5s on warm cache.
- **JSON parsing** — strips markdown fences if Gemini accidentally
  wraps the response, throws a clear error if the body still isn't
  valid JSON for the requested field.
- **Service-level guard** — when `GEMINI_API_KEY` isn't set the
  endpoint returns 503 with a helpful message instead of hanging.

### What we don't do (v1, deferred to Phase 6)

- **Multi-marketplace translation** — generating once and writing
  IT / DE / FR / ES / UK / US in one pass. Needs the publishing
  layer that lands in Phase 6 step 9–10. v1 generates for the
  wizard's current marketplace only.
- **AI-vs-user-edit diff tracking** — useful telemetry for
  measuring AI hit-rate but adds real complexity. Save the final
  value only; add the diff log later when there's a place to view
  it.
- **A+ Content / EBC** — beyond plain Amazon-safe HTML, the
  rich-content generator that produces image-rich modules and
  comparison tables ships in Phase 6 with the publishing path.
- **Quality scoring** — "this title is 87/100 by Amazon best
  practices". Insights badges stand in for v1; a real score
  follows once we have a rubric to grade against.
- **Brand-voice profile** — saving the user's editing patterns
  per brand so the next product matches.

---

# Products Rebuild — `/inventory` → `/products`

Date: 2026-05-02

The legacy `/inventory` browse page had three compounding bugs that
silently hid catalog rows:

1. **Hard 50-product cap.** The page hit
   `/api/amazon/products/list?topLevelOnly=1&limit=50` with no
   pagination affordance. Anyone with > 50 products saw a truncated
   list that looked complete.
2. **Amazon-only filter.** The endpoint applied
   `where: { syncChannels: { has: 'AMAZON' } }`. Products created
   from CSV / XLSX / ZIP upload that hadn't been synced to Amazon yet
   were invisible — including everything in the bulk-operations
   pipeline.
3. **Misleading total count.** The header counter reflected the
   filtered + capped slice, not the true catalog size, so the user
   had no signal that products were missing.

## What replaced it

A new `/products` route built fresh against a new
`GET /api/products` endpoint that paginates correctly, filters
across all channels (and unfiltered by default), and returns
**stats matching the filtered view** so the header counters are
coherent with what's browsable.

### API — `apps/api/src/routes/products.routes.ts`

`GET /api/products` accepts:

- `page`, `limit` (default 1 / 50; 200 max)
- `search` — matches SKU / name / brand / GTIN (case-insensitive)
- `status` — comma-separated: `ACTIVE`, `DRAFT`, `INACTIVE`
- `channels` — comma-separated: `AMAZON`, `EBAY`, `SHOPIFY`,
  `WOOCOMMERCE`
- `stockLevel` — `all` | `in` | `low` (1–5) | `out` (=0)
- `sort` — `updated` | `created` | `sku` | `name` |
  `price-asc` | `price-desc` | `stock-asc` | `stock-desc`

Returns `{ products, page, limit, total, totalPages, stats }`
where `stats = { total, active, draft, inStock, outOfStock }`
reflects the *filtered* set (so the header counters and the rows
the user is browsing always agree).

The `where` clause uses `parentId: null` to hide variations from
the top-level browse — variations show up inside the parent's
edit page.

The select uses the `cloudImages` relation (the `Image` model
ordered by `sortOrder`), not the legacy `images` relation
(`ProductImage`). Card image is `p.cloudImages[0]?.url`.

### UI — `apps/web/src/app/products/`

- `page.tsx` — server component, server-renders page 1 of 50 from
  the new endpoint with `cache: 'no-store'`. Falls back to an
  empty state with the underlying error string if the fetch fails.
- `ProductsClient.tsx` — client shell. Owns search (200ms
  debounce), filters, sort, page, page size, view mode (grid /
  table), and selection. Refetches on any state change via a
  `fetchKey` JSON useMemo; `isInitialMount` ref skips the very
  first effect run because the server already provided initial
  data. Filter / search / sort changes reset `page` to 1.
  Selection clears whenever the visible product set changes — a
  selection that points at rows you can't see anymore would be
  confusing.
- `components/GridView.tsx` — responsive
  `grid-cols-[repeat(auto-fill,minmax(220px,1fr))]` of cards.
  Native `<img loading="lazy">` with `onError` swap to a Package
  icon (no `next/image` to keep the path simple). Status badge,
  stock indicator (red ≤ 0, amber ≤ 5, emerald otherwise),
  channel dots (orange / blue / emerald / purple per channel).
- `components/TableView.tsx` — TanStack `react-table` core model
  (no virtualization at v1; 200-row max page is fine without it).
  ~10 columns: select checkbox, image thumb (40×40), SKU, Name,
  Status, Stock, Price, Channels, Updated. Row click navigates
  to `/products/[id]/edit`; cmd/ctrl/middle-click opens in a new
  tab. Checkbox `stopPropagation`'s the row click. The header
  checkbox is tri-state via the DOM `indeterminate` ref.
- `components/PaginationStrip.tsx` — Prev / Next + "X – Y of Z"
  indicator. Hides when total = 0.
- `components/ProductFilters.tsx` — dropdown panel: Status
  (multi-check), Channel (multi-check), Stock level (radio).
  Active count badge on the trigger; Reset all button inside.
- `components/SortMenu.tsx` — 8 sort options, single-select
  dropdown.
- `components/SelectionBar.tsx` — fixed bottom-center pill that
  appears when ≥ 1 row is selected. Count + Export CSV +
  Cancel. Export builds a CSV blob client-side from the selected
  `ProductRow[]` (id / sku / name / brand / status / basePrice /
  totalStock / syncChannels / imageUrl / updatedAt / createdAt),
  with proper quote-escaping. No server endpoint needed.

### Migration

- `apps/web/src/app/inventory/page.tsx` — replaced with a
  `redirect('/products')`. Bookmarks and any stale internal link
  bounce. Sub-routes under `/inventory/*` (upload, manage, fba,
  stranded, resolve, etc.) are unchanged in v1.
- `apps/web/src/components/layout/AppSidebar.tsx` — main
  Catalog → Products nav item now points at `/products`. The
  `active` predicate matches both `/products*` and `/inventory*`
  so users on the redirect path still see the correct highlight.
- 11 internal user-facing links migrated: command palette,
  legacy `Sidebar.tsx`, breadcrumbs in `/inventory/{stranded,
  resolve, fba}`, EmptyState CTAs in `/listings`,
  `/fulfillment/stock`, `/pim/review`,
  `ChannelMarketView`, `ChannelDashboard`, the back button in
  `/products/[id]/edit/ProductEditClient.tsx`, the
  `/catalog/[id]/edit` "Inventory" link, the `/catalog/page.tsx`
  redirect target, and the `/performance/health` "View Products"
  CTA.
- `revalidatePath` calls in `inventory/manage/actions.ts`,
  `actions/listings.ts`, and `pricing/actions.ts` were extended
  to also revalidate `/products` so price / stock / link edits
  show up immediately after the migration.

### What we *don't* do (v1, deferred)

- **URL state.** Search / filter / sort / page do not sync to the
  URL. Sharing a filtered view via link, browser back/forward
  through filter states, and "open this page in a new tab with
  my filters" all fall back to the default view. Will be added
  via `searchParams` once we settle the route between server-
  rendered first-paint and client-controlled re-fetches.
- **Bulk edit.** Selecting rows + clicking "Edit price" / "Edit
  stock" inline. v1 ships with **Export CSV** of the selection
  only — the user opens the CSV in their tool of choice, edits,
  and re-imports via `/bulk-operations`. Real bulk-edit-in-place
  needs the same patch endpoint and per-cell validation as the
  bulk grid; we'll add it once the pattern stabilises.
- **Single-product creation page.** "New product" routes to
  `/bulk-operations#upload`. A form-based one-product creator
  is a deferred design — v1's flow is: upload → review in bulk
  grid → edit page.
- **Faceted search counts.** Filter dropdowns don't show "(123)"
  counts per option. Real faceting needs a second aggregate
  query per filter axis; not worth it until the user complains.
- **Image hosting via `next/image`.** Native `<img>` is plenty
  for thumbnails up to 220 px, avoids a deploy-time domain
  allowlist, and degrades gracefully to a Package icon on load
  failure.
- **Server-driven sorting on derived columns.** The Updated
  column shows a relative timestamp computed client-side; for
  sort, the server orders by `updatedAt` directly.

---

# P0 cleanup (post-Phase 5.5, 2026-05-02 → 03)

Three reliability improvements landed before the user paused for real Xavia operations.

## P0 #0 — Schema-migration drift CI gate

`packages/database/scripts/check-schema-drift.mjs` parses
`schema.prisma` for every `model X` (and any `@@map("y")`), scans every
`prisma/migrations/*/migration.sql` for `CREATE TABLE [IF NOT EXISTS] "X"`,
and exits non-zero if any model lacks a `CREATE TABLE`. ~50ms; no shadow
database needed (deliberately simpler than `prisma migrate diff`, which
requires a live shadow Postgres). Catches the *exact* class of bug that
took `/products` down — a Prisma model with no migration creating its
table — at commit time, before the runtime crash.

Wired three places:
- `npm run check:drift` (root + `@nexus/database`)
- `.githooks/pre-push` runs it before the existing apps/web + apps/api
  builds. Install per-clone with `git config core.hooksPath .githooks`
  (documented in DEVELOPMENT.md). No real CI yet, so this hook is the
  only barrier to a broken push.
- `node packages/database/scripts/check-schema-drift.mjs` directly.

The first run found two more orphans beyond the known `Image`:
`ChannelConnection` (eBay auth flow uses it ~12 times — runtime risk
in production today, just not exercised) and `DraftListing` (zero
callers, pure orphan from Phase 5 design that never landed). Both are
allow-listed in the script with a `TECH_DEBT #31 / #32` reference; the
gate's job is preventing *new* drift, while pre-existing drift is
documented and being worked off.

Limitations: column-level drift (model has a field but no migration
adds the column) is out of scope — that would need a real shadow DB
and is best left to CI when we add it. `@@map` is supported but
unused.

## P0 #8 — GTIN wizard image validator (verification + dead-code purge)

The original hypothesis ("the validator is broken at runtime by the
same `Image`-table-missing root cause") **was wrong.** Verified live:
`POST /api/gtin-exemption/<id>/validate-images` against the existing
Xavia DRAFT returned 200 with the expected empty validation set. The
GTIN routes already select the `images` relation (`ProductImage`),
not `cloudImages` (the orphan `Image` model).

What was actually orphan and dangerous:

- `apps/api/src/services/image.service.ts` (571 LOC) — only consumer
  of `prisma.image`, written for color-based variant assignment and
  never finished.
- `apps/api/src/routes/images.ts` (279 LOC) — Express-style router
  that imports `ImageService`. The whole `apps/api` uses Fastify;
  this file was never registered with the running server.
- `apps/api/src/services/__tests__/image.integration.test.ts` (363
  LOC) — test for the dead service.
- `apps/api/src/routes/index.ts` — also dead (its `setupRoutes` is
  never imported); fixed the leftover `images.js` import to keep
  typecheck green.
- `model Image { … }` in `schema.prisma` — orphan model, no migration.

Net: −1,213 LOC dead code + the orphan model gone. Drift gate now
passes with 44 models (was 45) and the allow-list is down to two
entries (ChannelConnection + DraftListing).

## P0 #27 — Italian terminology glossary

The Phase 5.5 AI generator was producing "Giubbotto" (padded/winter
jacket) when the user (Xavia, motorcycle gear, Amazon IT) needed
"Giacca" (generic jacket). The fix is a brand glossary fed into every
AI prompt.

Schema (`packages/database/prisma/schema.prisma`):

```prisma
model TerminologyPreference {
  id          String   @id @default(cuid())
  brand       String?      // null = applies to every brand in the marketplace
  marketplace String       // 'IT', 'DE', …
  language    String       // 'it', 'de', …
  preferred   String       // the word the AI should use
  avoid       String[]     // words it keeps producing that are wrong
  context     String?      // e.g. "motorcycle jacket", "summer mesh"
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([brand, marketplace])
  @@index([marketplace])
}
```

Migration `20260502_phase_p0_27_terminology` is idempotent (`CREATE
TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`) and seeds seven
Xavia/IT entries via `INSERT … ON CONFLICT DO NOTHING`:

| Preferred  | Avoid                  | Context |
|---|---|---|
| Giacca     | Giubbotto, Bomber      | motorcycle jacket — user-confirmed |
| Pantaloni  | Brache                 | motorcycle pants |
| Casco      | Elmetto                | motorcycle helmet — Elmetto is military/construction |
| Stivali    | Scarpe, Scarponi       | motorcycle boots |
| Protezioni | Armatura               | body armour — Armatura sounds medieval |
| Pelle      | Cuoio                  | leather garment material |
| Rete       | Maglia                 | mesh / breathable fabric |

Each row's `context` documents the reasoning so the user can audit
+ refine via the admin UI. The user explicitly approved Giacca/Giubbotto
on 2026-05-03 and asked the assistant to "do its best" for the rest.

API (`apps/api/src/routes/terminology.routes.ts`): full CRUD —
`GET /api/terminology?brand=&marketplace=`, `POST`, `PATCH /:id`,
`DELETE /:id`. `brand=__none__` returns only defaults; otherwise the
list query returns brand-specific + brand-null defaults so the AI
prompt receives both.

AI prompt injection (`apps/api/src/services/ai/listing-content.service.ts`):
new `terminologyBlock(entries)` helper. Every prompt builder (title,
bullets, description, keywords) appends:

> Terminology preferences (STRICTLY FOLLOW — do not substitute
> synonyms):
> - Use "Giacca" instead of: "Giubbotto", "Bomber" (motorcycle jacket).
> - …

before the JSON return contract. The route fetches the matching
preferences (`brand: product.brand` UNION `brand: null`,
`marketplace: marketplace`) and passes them through `GenerationParams.terminology`.

Admin UI at `/settings/terminology` (`apps/web/src/app/settings/terminology/`):
table + add modal + inline edit + delete-with-confirmation. New
"Terminology" tab in the Settings sub-nav.

Verification path (run after Railway redeploys): open the listing
wizard for a Xavia jacket product, navigate to Step 6 (Content),
click "Generate all content" with marketplace IT. The title should
consistently use "Giacca" across regenerations. Add new preferences
inline in `/settings/terminology` as more drift surfaces.

### What we don't do (v1, deferred)

- **Constrained decoding** — preferences are a prompt instruction, not
  a hard constraint. If Gemini ignores the preference (low probability
  given the "STRICTLY FOLLOW" framing, but possible), the user has to
  regenerate. A real fix uses logit-biased decoding or post-generation
  rewriting; v1 ships the prompt approach.
- **Per-product / per-category overrides** — preferences apply per
  brand × marketplace. A "different rule for racing leather vs. mesh"
  scenario isn't supported until the user asks.
- **Audit log** — when preferences change, no record of who edited
  what / when. Add when the team grows past one user.

