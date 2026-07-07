# Stock Import Wizard Perfection — Diagnosis & Fix Proposal (2026-07-07)

**Page:** `/fulfillment/stock/import` (IM.1 wizard, commit 675c5246)
**Status:** DIAGNOSIS COMPLETE — awaiting Owner approval before any code change.
**Scope guard:** this is the IM.1 stock wizard ONLY. The legacy import-wizard
(`/bulk-operations/imports`, `ImportJob`, `import.service.ts`) and the FF2
flat-file import engine are explicitly out of scope (Owner-locked).

---

## 1. Root causes of "No valid rows found after mapping"

The wizard parses every file **twice** and the two parsers disagree:

- **Server** `POST /api/stock/import/parse` (`stock.routes.ts:3145`) uses the
  real parsers (`services/import/parsers.ts`): csv-parse (quotes, BOM strip,
  header dedupe `Price__2`), ExcelJS for xlsx, delimiter sniff (comma/tab).
  The MAP step's headers + preview come from here.
- **Client** `readAllRows()` (`ImportClient.tsx:313`) re-reads the same file
  with `file.text()` + `line.split(/,|\t/)` — no quotes, no BOM strip, no
  dedupe, no xlsx, no JSON. The rows actually imported come from here.

Mapping joins server header names onto client row keys. Any disagreement ⇒
`row[idCol]` is undefined for every row ⇒ all rows dropped ⇒ the exact toast
the Owner sees. Concrete failure classes:

| # | File | Server result | Client result | Outcome |
|---|------|--------------|---------------|---------|
| 1 | `.xlsx` / `.xls` | headers parse fine (xlsx) | `file.text()` on binary → garbage keys | 0 rows, always |
| 2 | CSV UTF-8 with BOM (Excel default) | BOM stripped → `sku` | key stays `﻿sku` | 0 rows when identifier is col 1 |
| 3 | Semicolon CSV (Italian Excel!) | `.csv` ext **forces comma** (`sniffDelimiter`, parsers.ts:49) → ONE mega-header `sku;qty` | same | can't even map two columns |
| 4 | Quoted fields with commas (`"Giacca, nera",5`) | correct | columns shift | dropped rows or **silently wrong quantities** |
| 5 | Duplicate headers | deduped `Qty__2` | last-wins overwrite | mapped col missing on client |
| 6 | `.json` | **parsed as CSV** — route never calls `parseJson` (stock.routes.ts:3154-3158) | garbage | broken despite being advertised |
| 7 | Pasted Excel cells (TSV) | wrapped as `pasted.csv` → ext forces comma → mega-header | splits tabs fine | keys mismatch → 0 rows |
| 8 | Qty formats `1,5` / `1.234` / `5 pz` | n/a | `Number()` → NaN → **silent row drop** (ImportClient.tsx:207) | partial, unexplained row loss |

Additional parse-layer defects:
- `.xls` (old binary) is accepted by the file picker but ExcelJS only reads
  `.xlsx` → server 500 ("weird errors").
- Client caps files at 10 MB, server multipart at 50 MB — inconsistent copy.
- UI says "first 5 rows" but server preview returns 20 (cosmetic).

## 2. Resolution / mapping defects

- **Assign modal + alias product search are 100% dead**: they call
  `/api/products/search?q=...` and read `data.products ?? data.results`
  (ImportClient.tsx:445-447), but the endpoint only honors `search=`
  (`product-search.service.ts:66` `parseFilters`) and returns rows under
  `items` (products-search.routes.ts responseSchema). Every search shows
  "No products found" → unresolved rows are dead ends.
- **Auto-map priority bug** (`autoMapHeaders`, ImportClient.tsx:178): first
  header wins. `["Product Name","SKU","Qty"]` → *Product Name* claims
  identifier, SKU stays unmapped → whole file resolves FUZZY instead of EXACT.
  Identifier priority must be sku-like > barcode > name.
- **Header dictionary is tiny + English-only** (`SMART_HEADER_MAP`): missing
  Amazon (`seller-sku`, `asin1`, `Merchant SKU`), eBay (`Custom label (SKU)`),
  barcodes (`ean`, `barcode`, `gtin`, `upc`), Italian (`codice`, `quantità`,
  `qta`, `q.tà`, `giacenza`, `pezzi`, `disponibilità`).
- **Resolver misses channel identities** (`stock-import.service.ts:109`):
  matches Product.sku, SkuAlias, fuzzy name, Product.ean/upc — but NOT
  `SharedListingMembership.sku` (eBay custom labels), `Product.fnsku`, or
  ASIN. Files exported from Amazon/eBay won't resolve.
- **Fuzzy tier auto-selects** the top candidate (tier FUZZY_NAME with
  productId pre-filled) — bulk-commit of a wrong product is one click away.
  Needs an ambiguity gate (near-tie or weak score ⇒ require confirm).
- Barcode tier runs AFTER fuzzy-name; Excel scientific-notation EANs
  (`8.05123E+12`) never match.

## 3. Channel-sync defects (the Owner's real-time ask)

**What already works (do not rebuild):** target=WAREHOUSE goes through
`applyStockMovement` → in-transaction `cascadeQuantityToListings`
(stock-movement.service.ts:571) → only listings with
`followMasterQuantity=true`, FBM only (FBA hard-excluded), `stockBuffer`
honored, per channel×marketplace, eBay shared SKUs via
SharedListingMembership → OutboundSyncQueue → BullMQ/60s-cron push.
That IS "update eBay if listed on eBay, not Amazon". Prod latency ~70s–2.5min
(instant lane down; Owner accepted 2026-07-06 — not re-proposing).
Manual adjustments carry a 30s undo-hold by design.

**What's broken:**
- **CHANNEL / BOTH target never reaches any marketplace**
  (`stock-import.service.ts:415-444`): writes `quantityOverride` +
  `followMasterQuantity:false` only — never updates `quantity`, never sets
  `lastSyncStatus`, never enqueues OutboundSyncQueue. DB-only write.
- **Silently detaches the listing from the pool**: `followMasterQuantity:false`
  means all FUTURE warehouse imports/sales stop syncing that listing — the
  exact opposite of the Owner's intent, applied as a hidden side effect.
- **ADJUST math wrong for multi-listing products**: `newQty` computed once
  from `cls[0]` (arbitrary listing) then written to ALL matched listings.
- **ENDED listings updated on apply** while preview filters them out;
  preview also ignores the row's channel/marketplace filter that apply honors.
- **No-match counted as success**: CHANNEL row matching zero listings →
  `succeeded++`, `applied:true`, nothing done.
- **Falsy-zero bug** in amazon/ebay/shopify-sync.service.ts (~:122):
  `quantityOverride || product.totalStock` — an override of **0** pushes FULL
  stock. `??` semantics + explicit 0 handling needed.
- Preview for duplicates: two ADJUST rows for one SKU each preview against
  the same base (10→15, 10→15) but apply sequentially (final 20). SET dupes =
  silent last-write-wins. No aggregation warning.
- Apply not idempotent (no content-hash/job guard; double-submit doubles
  adjustments; job row is created only at apply so no draft linkage).

## 4. Proposed fix plan (phased; approval per phase)

**Phase P1 — one parser, one truth (kills "No rows found after mapping")**
- `/parse` returns ALL rows (cap 5000 exists) parsed server-side; client drops
  `readAllRows()` entirely; MAP + RESOLVE consume server rows only.
- Server parser upgrades: extend `sniffDelimiter` → `, ; \t |` by content
  score (never let `.csv` force comma); route JSON → `parseJson`; reject `.xls`
  with a clear "save as .xlsx" 400; paste flow sends raw text (no fake `.csv`
  name) so the sniffer sees tabs; scalar-coerce ExcelJS dates.
- Robust quantity coercion server-side (`+5`, `1,5`, `1.234`, thin spaces,
  `(2)` negatives, drop currency/text suffixes) with per-row drop REASONS
  returned — MAP step shows "142 of 150 rows valid; 8 dropped (view/download)".
- Align size caps (50 MB) + preview label.

**Phase P2 — mapping & resolution intelligence**
- Fix assign/alias search wiring (`search=` param, `items` key) — 2-line fix,
  unblocks every unresolved row.
- Expand SMART_HEADER_MAP (EN + IT + Amazon/eBay export headers) with
  identifier priority sku > barcode > name; never let name-ish headers claim
  identifier when a sku-ish header exists.
- New resolver tiers: exact `SharedListingMembership.sku` (eBay custom
  label), `Product.fnsku`, ASIN (via listings), whitespace/case-insensitive
  exact; barcode tier BEFORE fuzzy; fuzzy ambiguity gate (top-2 near-tie ⇒
  UNRESOLVED with candidates listed inline for one-click pick).
- RESOLVE table: render candidates inline for fuzzy/unresolved rows.

**Phase P3 — channel target correctness + real sync**
- CHANNEL/BOTH apply: per-listing arithmetic; skip ENDED; update `quantity` +
  `lastSyncStatus=PENDING` + enqueue OutboundSyncQueue rows (same shape as
  cascade) so pushes actually fire; failure/no-match surfaced per row.
- `followMasterQuantity:false` becomes an EXPLICIT opt-in checkbox
  ("Pin as channel override — stops following warehouse pool"), default OFF;
  without it CHANNEL writes are one-shot pushes that leave follow-mode intact.
- Fix `quantityOverride || totalStock` → null-safe in the 3 sync services.
- Preview parity: same listing filter as apply, per-listing expandable rows,
  duplicate-SKU aggregation warning.
- UI copy: target selector explains sync semantics ("Warehouse — auto-syncs
  to every channel where listed (recommended)").

**Phase P4 — apply safety + polish**
- Idempotent apply: create StockImportJob at preview-confirm (status DRAFT)
  with rows snapshot; apply consumes the jobId exactly once.
- Use `applyStockMovementBatch` for large files; history drill-down UI
  (endpoint `GET /stock/import/history/:id` already exists); optional RBAC
  (`stock.write`) on write endpoints when RBAC program resumes.

**Out of scope / guarded:** legacy `/bulk-operations/imports` untouched; FF2
flat-file import untouched; FBA guard + oversell clamp untouched (import
already routes through `applyStockMovement`, which keeps both); no Redis /
instant-lane re-proposal.
