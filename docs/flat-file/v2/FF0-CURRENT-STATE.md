# FF0-CURRENT-STATE — Teardown of the existing flat-file pipeline

> Phase FF0 (read-only). Verified against the live codebase 2026-07-05 via six parallel subsystem audits (export, import, grid registry, data model, surfaces, market discovery). Every path below carries `file:line` references. Nothing in this document changes code.

---

## 0. The one-paragraph reality

There is no single flat-file pipeline. There are **two export paths, three import shapes, four column-schema definitions, two grid engines, and two unrelated "bulk" backends**, and the Amazon and eBay sides use **fundamentally different write models** (Amazon = async SP-API feed; eBay = direct DB writes). The pieces FF v2 needs already exist in fragments — a proven dry-run/diff idiom, a job-persistence model, a portable column schema, a dynamic market-discovery query — but they are scattered, partially dead, and never unified. FF v2's job is consolidation onto one deterministic workbook + one audited apply path, **not** greenfield invention.

---

## 1. Export pipeline

### 1.1 Two parallel export paths

| | Path A — generic ExportJob wizard | Path B — flat-file grid export |
|---|---|---|
| Entry | `POST /api/export-jobs` | `POST /api/amazon/flat-file/export`, `POST /api/ebay/flat-file/export` |
| Service | `apps/api/src/services/export-wizard.service.ts` | `apps/api/src/routes/amazon-flat-file.routes.ts:981-1034`, `ebay-flat-file.routes.ts:1269-1307` |
| Persisted? | Yes — `ExportJob` row lifecycle | No — stateless, renders client-supplied grid rows on the fly |
| Rows from | DB (`fetchRows`, product entity) | Whatever the grid POSTs |
| Used by | `/bulk-operations/exports` builder | **The actual flat-file editors** |
| Renderer | shared `renderExport()` in `services/export/renderers.ts` | same `renderExport()`, bypassing the job lifecycle |

Both funnel into the **same renderer** (`services/export/renderers.ts`, `renderExport()` at `:206`). The XLSX branch (`renderXlsx :113-140`) is **confirmed single-worksheet** (one `wb.addWorksheet()` at `:122`), uses **exceljs**, and applies **zero Excel-proofing** — no forced-text on identifiers, no number formats, and it uniquely **bypasses `formatCell`** (`:126` writes `readPath(row,c.id) ?? ''` raw), so currency/date/number directives that CSV/TSV/PDF honor are dead in XLSX.

### 1.2 ExportJob lifecycle (Path A — the reusable spine)

`ExportJob` model at `packages/database/prisma/schema.prisma:5954-6001`: `format`, `targetEntity`, `columns Json`, `filters Json?`, `status (PENDING|RUNNING|COMPLETED|FAILED)`, `rowCount`, `bytes`, `artifactBase64`, `artifactUrl`, `errorMessage`, `scheduleId`. `create()` persists then runs **inline, synchronously, in-request** (`export-wizard.service.ts:88-96`); `run()` → `fetchRows()` → `renderExport()` → store. Row order is deterministic (`orderBy: { sku: 'asc' }`, `:135`), 50k cap. Scheduled exports (`scheduled-export.service.ts`) reuse this whole spine via `fireOnce()` → `create({ runImmediately:true })`.

**FF v2 guidance:** extend this job lifecycle (add a `workbook` renderer branch + real artifact storage); do **not** fork it.

### 1.3 The canonical Amazon TSV generator (keep it)

`buildTsvExport` (`apps/api/src/services/amazon/flat-file.service.ts:2133-2148`) is the **only** generator that emits the real Amazon multi-row template header (meta / labelEn / labelLocal / fieldRef / Required, CRLF-joined). The generic `flatFileExportColumns` (`:908-914`) flattens to a **single English-label header row** and therefore produces CSV/XLSX that is **not re-uploadable to Seller Central** — only the TSV path round-trips. FF v2's per-market grouping must generalize `buildTsvExport`, carrying its metadata rows into the XLSX (frozen headers).

---

## 2. Import pipeline

### 2.1 Wiring status — read this first

| Service | Wired? | Semantics |
|---|---|---|
| `import.service.ts` (Rithum "relational importer") | **DEAD / zero callers** | create/upsert-only, no tx, unconditional overwrites |
| `import-wizard.service.ts` | ✅ `POST /import-jobs/preview → /apply` | **update-only, product-only**, blanks skipped |
| `ebay-import.service.ts` | ✅ `catalog.routes.ts:2029` | create + update (Product only) |
| `ebay-flat-file-create.service.ts` (+`.logic.ts`) | ✅ `ebay-flat-file.routes.ts:349` | create + reparent/promote (per-family `$transaction`) |
| `ebay-flat-file-delete.service.ts` | ✅ `ebay-flat-file.routes.ts:1922` | soft-delete Product + hard-delete membership |
| `ebay-flat-file-pull-preview.service.ts` | ✅ | read-only staging (→ `PullDiffModal`) |
| `scheduled-import.service.ts` | ✅ cron | delegates to wizard, **auto-applies (no gate)** |
| `stock-import.service.ts` | ✅ | update-only quantities, with a real preview |
| `amazon-flat-file-feed.service.ts` | ✅ | feed-report reconciler — **not a catalog importer** |

### 2.2 The dominant architectural asymmetry

- **Amazon flat-file save = feed submission.** `POST /submit` (`amazon-flat-file.routes.ts:298`) builds a `JSON_LISTINGS_FEED`, calls SP-API `createFeed`, and writes only an `AmazonFlatFileFeedJob` row (`:511`) — **no direct catalog mutation**. Amazon is the system of record; `amazon-flat-file-feed.service.ts` reconciles the processing report back.
- **eBay flat-file save = direct DB writes.** `PATCH /ebay/flat-file/rows` runs the create pre-pass (per-family tx) then a **bare, non-transactional per-row `ChannelListing` update/create loop** (`ebay-flat-file.routes.ts:388-449`).

FF v2's fidelity contract must span both write models under one preview → diff → apply contract.

### 2.3 The proven dry-run/diff idiom (the FF2 template)

Lives in `apps/api/src/services/marketing/ebay-ads-csv.service.ts`, exposed at `ebay-ads.routes.ts:685` (`POST /ebay-ads/import`). Three stages:

1. **`parseAdsOpsCsv` (`:101`) — PURE.** CSV → discriminated-union ops + `errors:{row,error}[]`; every op keeps its 1-based source row. Unit-testable, no DB.
2. **`diffOps` (`:152`) — diff vs live state.** Loads current state once, emits `CsvDiffRow { row, kind, target, from, to, note, error }` classifying add-vs-update-vs-remove per row with human-readable from→to; validation folded into `error`.
3. **Gated apply — `applyOps` (`:183`).** `dryRun` **defaults to true** (`!== false`); the **same diff object both previews and gates** (rows whose diff has an `error` are excluded); apply routes through the audited write service returning per-row `{row, ok, mode, detail}`.

**This is the pattern to generalize to per-cell granularity over the product chain.** A weaker second precedent is `stock-import.previewImport` (`:224`, would-be vs current qty).

### 2.4 Job persistence today

`ImportJob` / `ImportJobRow` (`schema.prisma:5777+`) store `columnMapping`, per-row `parsedValues` / `beforeState` / `afterState` / `status` / `errorMessage`, and aggregate counters. **It does NOT store the uploaded file bytes and does NOT store a pre-apply diff** — before/after are captured *during* the write, so they are an audit trail, not a preview. `beforeState` is, however, the seed for FF v2's inverse-diff rollback.

---

## 3. The grid + column registry

### 3.1 Four divergent column schemas (drift)

The same concept is defined four times, and they already disagree:

| Definition | File | Notable shape |
|---|---|---|
| `FlatFileColumn` (canonical web) | `apps/web/src/components/flat-file/FlatFileGrid.types.ts:5-50` | `kind`, `enumMode 'open'\|'strict'`, `multiValue`, `applicableParentage`, `maxLength`, `maxUtf8ByteLength`, `readOnly` |
| `EbayColumn` (web eBay) | `products/ebay-flat-file/ebay-columns.ts:11` | superset-ish + `variantEligible`; **lacks** `applicableParentage`, `maxUtf8ByteLength` |
| `Column` (web Amazon) | `products/amazon-flat-file/AmazonFlatFileClient.tsx:125-170` | split `labelEn`/`labelLocal`, `selectionOnly` (not `enumMode`), `applicableProductTypes`; **no** `kind:'readonly'` |
| `FlatFileColumn` (server) | `apps/api/src/services/amazon/flat-file.service.ts:49-128` | **authoritative** Amazon shape, derived from live Amazon JSON Schema; typed `applicableParentage`, `guidance`, `STRICT_ENUM_FIELDS` Set |

Only the **server** definition is derived from live Amazon schema. The web-shared `FlatFileColumn` is ~90 % pure data (only React coupling is `RenderCellContent` + the presentational `width`/`frozen`/`color` fields), so it is portable into a shared registry.

### 3.2 Two grid engines

- **Shared `FlatFileGrid.tsx`** (`components/flat-file/`, ~2,650 lines) — used by **eBay + bulk-ops**. Schema-driven via `columnGroups: FlatFileColumnGroup[]`.
- **Bespoke Amazon grid** inside `AmazonFlatFileClient.tsx` (~9,100 lines) — its own `Column` type + its own `cellErrors` validator (`:1379-1412`); reuses only `useFlatFileCore`, `FlatFileToolbar`, `HistoryModal`.

This split is the **single biggest blocker** to "one registry" — any grid fix (e.g. the byte-clamp in `FlatFileGrid.commitCells:1314-1326`) must be duplicated into the Amazon grid or it silently diverges.

### 3.3 Where columns come from at runtime

- **Amazon:** `GET /api/amazon/flat-file/template?marketplace=&productType=` → `generateManifest()` (`flat-file.service.ts`) → columns derived from **live Amazon JSON Schema**. Fully dynamic per (market, productType), cached.
- **eBay:** **static registry** `ebay-columns.ts` (`EBAY_FIXED_GROUPS` + `MARKET_COLUMN_GROUPS`) patched at runtime + a dynamic "Item Specifics" group from `GET /api/ebay/flat-file/category-schema`.
- **Bulk-ops:** reuses the Amazon `/template` endpoint.

### 3.4 Validation enforcement points (reusable by an importer)

All schema-expressible rules are enforced in `FlatFileGrid.tsx`:
- **read-only write-gate** `isWritableCol` (`:71-73`) on every bulk mutation (delete/paste/fill/replace/AI);
- **`maxLength` + `maxUtf8ByteLength` clamp + boolean coercion** centralized in `commitCells` (`:1314-1326`, `byteLen = new TextEncoder().encode(s).length`);
- **strict enum** → allowed-but-flagged (`:546-548`);
- **`required`** → visual only (blocking is per-channel: eBay gates *push* at `EbayFlatFileClient.tsx:1029`).

Cross-row rules (duplicate SKU, parent/child integrity) live outside the schema in `validateRows.shared.ts`. **An importer must re-implement required-gating and cross-row rules itself** — the grid does not guarantee them on typed edits (only on paste/fill/replace/AI).

### 3.5 History / undo

Two unrelated mechanisms: (a) **in-memory undo/redo** duplicated in both `useFlatFileCore.ts:157-192` and `FlatFileGrid.tsx:812-838` (the grid's stack is the live one; core's is dead in the eBay path) — lost on reload/market-switch; (b) **`HistoryModal.tsx`** is *not* undo — it's a durable push/pull/versions viewer (Amazon versions are localStorage-only, max 15).

---

## 4. Surfaces (user-facing)

### 4.1 Surface map

| Route | Client | Role |
|---|---|---|
| `/products/amazon-flat-file` | `AmazonFlatFileClient.tsx` (9,112 ln) | **UNTOUCHABLE** Amazon editor (grid + Smart Import + Pull diff + AI + feed submit) |
| `/products/ebay-flat-file` | `EbayFlatFileClient.tsx` (2,594 ln) | **UNTOUCHABLE** eBay editor (grid + Import wizard + Inventory-API push) |
| `/bulk-operations` | `page.tsx` → re-hosts the two editors | "ditto copy" of the untouchable editors |
| `/bulk-operations/imports` | `ImportsClient` | generic CSV/XLSX/JSON import → **generic `Product`** (counts-only preview) |
| `/bulk-operations/exports` | `ExportsClient` | export builder (14 columns, CSV/XLSX/JSON/PDF) |
| `/bulk-operations/history` | `HistoryClient` | `BulkActionJob` history + rollback |
| `/bulk-operations/schedules`, `/automation` | — | `ScheduledBulkAction` / `AutomationRule` builders |
| `/command-matrix`, `/catalog/matrix` | — | PIM matrices (consume `_shared/bulk-edit/*`) |
| `/catalog/import` | — | stub → `redirect('/products/upload')` |

### 4.2 The dry-run UI already exists (twice)

- **`ImportWizardModal.tsx`** (Amazon, file-in): upload/paste → `parse` → `suggest-mapping` → `coerce` → `plan-import`, producing a **full per-cell dry-run** — `PlanCell { columnId, from, to, willApply, reason: 'fill'|'overwrite'|'skip-existing'|'skip-column' }`, split into `newRows` vs `updates`, plus `skippedNoSku`/`duplicateSkus`/stats. eBay parallel: `EbayImportWizard.tsx`.
- **`PullDiffModal.tsx`** (Amazon, pull): per-cell `Current → From Amazon` diff **with conflict detection** (unsaved local edits flagged) + row-level cherry-pick.

Both live **inside the untouchable editors**. The generic `/bulk-operations/imports` wizard is **counts-only** (no per-cell diff). **FF2 extends the plan-import pattern; it does not rebuild a diff renderer.** The gaps to close: no unified cross-channel dry-run; no **delete** semantics in the plan (only fill/overwrite/skip); the diff lives inside the editors so any new surface must re-host them or lift the plan backend into a shared service.

### 4.3 Untouchable boundary (confirmed)

Zero changes without explicit approval: `apps/web/src/app/products/amazon-flat-file/**` and `apps/web/src/app/products/ebay-flat-file/**` (page + client + ~18/~24 siblings). **Editable extension points:** `apps/web/src/components/flat-file/**` and `apps/web/src/app/products/_shared/**`. The two editors do **not** share a live row-store; they persist per-market state to `localStorage` and broadcast coarse invalidations over `BroadcastChannel` (`lib/sync/invalidation-channel.ts:129`).

---

## 5. Market handling

- **Config registry:** `model Marketplace` (`schema.prisma:1631`, unique `[channel, code]`, `marketplaceId`, `region`, `currency`, `isActive`). **No `enum Marketplace`** — markets are free strings.
- **Per-listing markets:** `ChannelListing.marketplace` (indexed) / `VariantChannelListing.marketplace`.
- **Dynamic discovery already exists** at `GET /api/fulfillment/facets` (`fulfillment.routes.ts:11542`): `channelListing.findMany({ where:{listingStatus:'ACTIVE'}, distinct:['marketplace'] })` — its comment: *"Replaces the hardcoded ['IT','DE','FR','ES','UK','GLOBAL'] list with the seller's actual presence."* This is the reference implementation.
- **The flat-file path is the anti-pattern:** it **hardcodes** `COVERAGE_MARKETS = ['IT','DE','FR','ES','UK']` (`flat-file.service.ts:1432`; `AmazonFlatFileClient.tsx:692/7177/8700`) and **never queries `/api/marketplaces`**. A newly activated market (NL/SE/PL…) would be swept by orders and seeded, yet **never appear** in the flat file. See `FF0-MARKET-DISCOVERY.md` for the full 20-site hardcode inventory.

---

## 6. What survives vs. what is replaced

**Survives (reuse as substrate):**
- ExportJob lifecycle + scheduled-export spine (§1.2); `buildTsvExport` as the canonical Amazon template (§1.3).
- `import/parsers.ts` (CSV/XLSX/JSON → `{headers, rows}`, BOM strip, delimiter sniff) and `import/column-mapping.ts` (`suggestMapping` + `applyMapping`) — pure and reusable.
- `ImportJob`/`ImportJobRow` job persistence; `beforeState` seeds inverse-diff rollback.
- The `parse → diffOps → gated applyOps` idiom (§2.3) and the eBay create **pure planner** (`planEbayFamilyCreates`).
- The web-shared `FlatFileColumn` schema (portable to a shared registry) and the grid's schema-expressible validation (§3.4).
- The `ImportWizardModal` / `PullDiffModal` per-cell dry-run UI (§4.2).
- Dynamic market discovery (`/api/fulfillment/facets` query, §5).

**Replaced / retired:**
- Single-worksheet `renderXlsx` → deterministic multi-sheet workbook; `flatFileExportColumns` single-header CSV/XLSX (lossy) → metadata-carrying workbook.
- `import.service.ts` (dead Rithum importer) — delete or fully rewrite.
- `import-wizard.writeRow` (update-only, product-only) → create + update + **delete** across `Product → ChannelListing`.
- Inconsistent blank-cell semantics (§7) → one explicit, operator-selectable blank policy.
- Non-transactional apply loops → batched transactional apply with real rollback.
- Four column schemas + two grid engines → one shared registry (Amazon grid migration is the hard part).
- Hardcoded market lists → dynamic discovery.

---

## 7. Risks in today's system (summary — full detail in FF0-FINDINGS.md)

1. **Scope-changing:** the spec's named data chain (`ProductVariation → VariantChannelListing`) is **deprecated**; the live chain is `Product → ChannelListing`. (FF0-FINDINGS #1)
2. **Silent structural data loss:** eBay create-logic can **detach a child** from its parent when `platformProductId`/`parentage` are blank (`ebay-flat-file-create.logic.ts:679-690`). (FF0-FINDINGS #4)
3. **Blank-cell overwrites:** several paths clear fields on blank — `ebay-import` wipes `bulletPoints`/forces `productType:'APPAREL'` every run; route does `Number('')→0` on price and `title??''`. (FF0-FINDINGS #5–7)
4. **Export data-loss:** any export >1 MB silently becomes undownloadable (`artifactUrl` dead, base64-in-Postgres). (FF0-FINDINGS #8)
5. **Misleading rollback:** `import-wizard` "abort" does not roll back (no transaction); docstring is wrong. (FF0-FINDINGS #6)
6. **Market drift:** flat-file hardcodes markets in 20 sites + a real **BE/PL marketplace-ID conflict**. (FF0-FINDINGS #3)
7. **XLSX correctness:** `renderXlsx` ignores `format` and mishandles `Decimal`/dates. (FF0-FINDINGS #9)

None were fixed (FF0 is read-only). All are catalogued in `FF0-FINDINGS.md` with recommended dispositions.
