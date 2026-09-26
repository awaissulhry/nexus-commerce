# Product sheet — import and export rebuild

Branch `feat/product-sheet-import-export` · worktree `/private/tmp/nexus-product-sheet-import-export` · from `origin/main` 4f2e860b8 · 2026-09-26.
Status: **APPROVED 2026-09-26 by the Owner — D1 (a) import saves in Nexus only + a "Send to channels" button; D2 (a) native Amazon/eBay export files later (phase 2).**
**BUILT locally 2026-09-26 — not committed, not pushed.** What was built, and where it differs from this plan: §8 at the end. Evidence: `PROGRESS.md`.

## Summary

- **Today:** the product sheet has one real import/export engine ("catalog transfer"). It sits behind a 900 px drawer with up to 5 choices, and 4 other buttons also say "Import" or "Export" but do different things. Reading the file is fast (under 1 s). The slow part comes after that: every record is checked again, then saved in its own strict database transaction, one after another. Each save also rebuilds the readiness of the whole family. The editing file sends back **every cell, changed or not**, so all of that work runs for cells nobody touched.
- **Measured** (local DB copy, read → review → save, `docs/channel-file-import/records/proof/cfi-proof-3.json`):
  - Amazon DE/FR/ES files: median 7.8–11.7 s, worst 30.1 s.
  - Amazon IT files: median 2.0 s, worst 11.6 s.
  - eBay IT workbooks: median 7.1 s, worst 11.9 s.
  - The worst file has 6,326 rows. Only 1,796 cells changed, on 41 listings. **4,406 rows were already empty** and were still carried through every stage.
  - Nobody has measured a split by stage. Step 0 measures it.
- **Proposal:** one engine, two buttons, three screens.
  - **Export** → one small dialog → **Download**.
  - **Import** → drop the file → one summary ("128 changes · 3 problems") → **Apply** → done, with **Undo**.
  - The file holds exactly what the sheet holds: the same columns for each channel, market, account and language, and one row for each listing alias.
  - Only changed cells go to the server.
  - The save runs in large batches, and the follow-up work runs once per job, not once per row.
- **Reuse:** the file readers (Nexus workbook, Amazon templates, eBay workbooks, CSV), the sniffers, the value checks and the store writers. They are tested, fast, and correct.
- **Rebuild:** the job runner, the planner, the screens, and the export's column source.
- **Delete** (after the new flow passes): the old drawers, the four-tab catalog-transfer page, the variants CSV drawer, and the legacy routes.

---

## 1. Map — what exists today

Path shorthand: `pim/` = `apps/api/src/services/pim/`, `studio/` = `apps/web/src/app/products/[id]/edit/_studio/`, `ct/` = `apps/web/src/app/products/catalog-transfer/`.

### 1.1 Entry points (web)

| Where | Label | What it really does |
|---|---|---|
| Sheet toolbar, Information tab (shared + every channel scope) | `Export` / `Import` (fold into `⋯`) | Opens `studio/import/ProductTransferDrawer.tsx` → catalog-transfer engine (`studio/sheet/SheetToolbar.tsx:267-285`) |
| Variants tab | `Export` / `Import` | Export downloads `variants.csv` at once. Import opens the **older** `studio/import/ImportDrawer.tsx` (different engine, different diff UI, the only one with Revert) (`studio/import/VariantTransfer.tsx:41-54`) |
| Matrix tab | `Export`; import disabled | Screen CSV (`studio/matrix/MatrixToolbar.tsx:24-26,85`) |
| `/products` header | `Import & export`, `Export table` | Catalog-transfer page with 4 tabs; grid CSV, which cannot be imported |
| `/products/catalog-transfer` | 4 tabs | "Create workbook", "Import & review", "Export existing products", "Sources & history" (`ct/page.tsx:79`) |
| `/bulk-operations/imports` | — | Redirect to the page above. `ImportsTabs` / `ImportsClient` / `ScheduledImportsPanel` in that folder are dead |
| `/bulk-operations/exports` | — | Old export wizard on `/export-jobs` (Product columns only) |
| Amazon / eBay flat-file pages | File menu | Their own import/export. They read **another store** (see §1.6) |

Dead code: `studio/import/fixture.ts` is shipped in the bundle but never used. `liveTransport` and the `studio/import/index.ts` barrel have no callers. The server `/products/:id/import/*` (`apps/api/src/routes/product-studio.routes.ts:571`) has no web caller. `studio/sheet/sheetExport.ts` `exportSheet` has no caller.

### 1.2 API routes the sheet uses

All in `apps/api/src/routes/catalog-transfer.routes.ts`:

- `GET products/:id/options` (:75)
- `POST products/:id/export` (:81) — synchronous, builds the file in memory
- `POST products/:id/inspect` (:89) — multipart; reads the file on a worker thread; stores the parsed rows as JSON in `BulkOperation.changes` for 24 h
- `POST products/:id/preview` (:105) — stages `ImportJobRow`s, 100 at a time, then runs the preview in the background inside the API process
- `GET jobs/:id` (polled every 1.5 s), `GET jobs/:id/outcomes`, `POST jobs/:id/apply` (202, background), `errors`, `retry`, recovery timer every 30 s (:192-245)

### 1.3 Formats and limits

**Import accepts:**
- CSV: `,` `;` tab `|`, `sep=`, BOM (`pim/catalog-csv-dialect.ts`)
- The long format (`packages/shared/catalog-transfer.ts:10`)
- The Nexus wide workbook v2/v3 (`pim/catalog-workbook.ts`)
- The editing ZIP
- Amazon templates, `.xlsm`/`.xlsx`, old and new grammar (`pim/catalog-amazon-workbook.ts`)
- Our eBay workbooks (`pim/catalog-ebay-workbook.ts`)
- "Map a supplier file": CSV/XLSX/JSON (`pim/catalog-source-file.ts`)

**Export writes** only the Nexus workbook (ExcelJS, in memory), plus a ZIP when it is split. It writes no CSV and no native Amazon/eBay file.

**The file today:**
- One tab per (entity, channel, account, market, locale, category).
- Row 1 = labels. Row 2 = machine keys (`field`, `field@de`, `field@amazon:IT:it`).
- Hidden `action:<field>` columns (SET/CLEAR/INHERIT).
- Hidden `sku` / `aliasKey` / `version` columns.
- A hidden manifest, a `Dictionary` sheet, and a `Valid values` sheet with named-range dropdowns (`pim/catalog-workbook.ts:30-216`).

**Limits:**
- 10 MB per workbook and 50 MB per drawer upload
- 50,000 rows per workbook and 250,000 per drawer
- A drawer product group can hold at most 500 products and 5,000 listings
- 100 scopes and 2,000 columns per workbook

### 1.4 Validation today

**Checked** (`pim/catalog-transfer-plan.ts`, `pim/catalog-transfer-file.ts`, `mapping/validate-channel-value.ts`):
- row shape and duplicates
- stale versions
- declared, read-only and managed fields
- value shape (`coerceForShape`)
- channel choice lists, deprecated values, max length
- parent rules, category, account/market/alias
- price and sale windows, formula guards
- Amazon currency, language and market

One bad cell refuses its whole record.

**Not checked:**
- required attributes that are missing from the file
- cross-field rules (these wait until publish)
- GTIN checksum (only 8–14 digits)
- eBay values outside the choice list from a channel file (these give only a warning)

### 1.5 Identity and aliases

- A row finds its product by exact `Product.sku` only (`pim/catalog-transfer.service.ts:82`).
- **`SkuAlias` (alternate codes) is not used anywhere in import or export.** I checked `pim/` and `catalog-transfer.routes.ts` and found 0 hits.
- **Listing aliases (PES.5 `ProductListingAlias` / `aliasKey`):**
  - Export from the drawer: complete. One row per alias, with a label and a hidden key; archived aliases are left out.
  - Catalog page: shows the raw key, not the label, and includes archived aliases.
  - Import can write to existing aliases but cannot create one.
  - The formula guards skip aliases (`pim/catalog-transfer-plan.ts:688,691`).
  - A product that has aliases cannot change its parent.
- **Seller SKU:**
  - It is read from 6 JSON places with no index (`pim/catalog-amazon-workbook.ts:660-673`).
  - Only channel-file import writes it.
  - Nexus files cannot match by seller SKU, ASIN or eBay Item ID.

### 1.6 Channels, markets, languages, stores

**Export columns:**
- The shared tab uses the grid's `getSheetColumns`, with **one market for the whole export** (`pim/catalog-transfer-plan.ts:109`).
- Channel tabs use `getFieldCatalogue`, the mapping page's builder, **not** the grid's `getStudioColumns` (`pim/catalog-transfer-plan.ts:114`). This is the known "two column builders drift" trap.
- 🔴 **No account id is passed:**
  - Shopify store metafields are never exported.
  - Amazon seller-specific schemas are never used.
- 🔴 **A stored value whose key the current schema does not declare is dropped without a word** (`pim/catalog-transfer-export.ts:186`).
- 🔴 **One listing without an account stops the whole export** (`pim/catalog-transfer-export.ts:162`).

**Language:**
- Taken from `Marketplace.languages` (`market-languages.ts`). This is correct and reusable.
- The catalog page export has no language choice.

**Stores:**
- Import and export read and write the same stores, so the sheet's own round trip holds (955/955 in the CFI proof):
  - `Product`, `ProductTranslation`
  - `ChannelListingTranslation` for listing text
  - listing columns / `platformAttributes` / `overrideData` for listing facts
- The **Amazon flat-file page and its `.xlsm` export read other columns and `flatFileSnapshot`**. An import from the sheet stays invisible there. This is known, and out of scope here.

### 1.7 Why it is slow (verified in code)

1. **Every exported cell comes back as a change row, even an unchanged one.** A blank or equal cell re-pushes its baseline row (`pim/catalog-workbook.ts:315,323`). So all of them are staged, planned and walked record by record.
2. **One Serializable transaction per record, one after another** (`pim/catalog-transfer-jobs.ts:250-310`). Each one reloads the context (about 8–12 queries), re-plans, reads snapshots, and retries up to 3×3. A record with no change still pays for its transaction.
3. **Readiness for the whole family is rebuilt inside every record's transaction.** `produceReadiness` → `reconcileFamilyReadiness` → `getStudioSheet` for every market × account × language (`pim/readiness-index.service.ts:24-96`, called from `pim/catalog-transfer.service.ts:310`).
4. **The schema caches are cleared every 100 records**, in both preview and apply (`pim/catalog-transfer-jobs.ts:171`).
5. **Large JSON:**
   - full snapshots in `parsedValues`
   - `BulkOperation.changes` rewritten every batch and read on every 1.5 s poll
6. **Smaller costs:**
   - `productTransferOptions` runs up to 4× per upload
   - seller-SKU lookups by JSON path, 50 at a time
   - O(n²) `find` calls inside loops
   - live eBay/Amazon reference calls inside the transaction

Reading the file is **not** the problem: under 0.7 s for 500k cells (`docs/2026-09-25-product-transfer-performance.md`, `docs/2026-09-16-studio-import-wedged-production.md`).

### 1.8 Other defects found

- 🔴 **"Import never publishes" is false for shared text.** A primary-language content write queues `CONTENT_UPDATE` outbound rows for every listing that follows it (30 s hold) (`pim/content-write.ts:46` → `apps/api/src/services/master-content.service.ts:137-151`). The workbook's own instructions say the opposite (`pim/catalog-transfer-file.ts:160`). See decision D1.
- "Map a supplier file" parses XLSX with ExcelJS **on the main thread** (`pim/catalog-source-file.ts:53-58`). This is the same class of problem as the 2026-09-16 production wedge.
- The drawer can reopen onto an old review from sessionStorage. Reading a file silently switches the scope to "custom".
- A row whose product changed in Nexus after export fails **every cell** with "Keep the exported SKU, alias and version intact" (`pim/catalog-workbook.ts:313`).

---

## 2. What the rebuild must do (the Owner's asks, made testable)

| Ask | Test |
|---|---|
| Super simple, direct buttons | Common import = **3 actions** (Import → drop file → Apply) and **0 choices**. Common export = **2 actions** (Export → Download) |
| Fast | Speed targets in §4.5, measured against the §5 step 0 baseline on the same machine and DB |
| Many channels, markets, languages | Each channel tab has exactly the columns the sheet shows for that channel · market · account, in that market's language(s). Nothing is dropped without a message |
| Multiple aliases | Every listing alias is its own row, both ways. Rows also match by seller SKU / ASIN / eBay Item ID and by `SkuAlias` codes |
| AAA | One engine, one file format, one review screen, Undo, honest messages, full tests + a corpus gate |
| Reuse what is done | §4.7 keep list |

---

## 3. Design rules (short)

1. **The file is the sheet.** Export uses the sheet's own column builder (`getStudioColumns` with the account). Import writes through the sheet's own store writers. There is one list of columns, so nothing drifts.
2. **One engine, one file.** Every Import/Export button in the app opens the same two dialogs.
3. **The file decides the scope.** The file says which products and listings it holds. The user picks no scope on import.
4. **Only changes travel.** A blank or unchanged cell is not a change. To empty a cell, type `#clear`. To make a listing follow the shared value again, type `#shared`. There are no hidden action columns.
5. **Nothing is lost without a message.** A missing schema, an unknown column or an undeclared stored value is shown on screen and in the file.
6. **Import saves in Nexus.** Sending to channels is its own button. See decision D1.
7. **Every import can be undone** while the changed values have not moved since.

---

## 4. The new design

### 4.1 Export — one dialog

```
Export                                            [×]
Products   ( This product | Whole family | Selected rows )
Channels   [✓ Shared details]  [✓ Amazon IT · 3 listings]  [ eBay DE · 1 ]  [ Shopify · 1 ]
Language   Italian (from Amazon IT) · Shared: IT, DE, EN
Columns    ( All columns | Only columns on screen )
                                              [ Download ]
```

- **Defaults:** "Whole family", plus the channel you are looking at, plus Shared. In most cases the user just presses **Download**.
- **Languages are not a choice.** They come from each market. Amazon BE gives French and Dutch.
- **Small exports** (up to about 5,000 rows) download at once. Bigger ones run as a job with a progress bar, and download when done.
- **Missing schema:** if a schema is missing, the dialog loads it first ("Loading Amazon IT schema…"). If it cannot load it, the dialog blocks that one channel and says why. It never drops columns without a message.

### 4.2 Import — drop, check, apply

```
Import                                            [×]
┌──────────────────────────────────────────────┐
│  Drop your file here  (.xlsx .xlsm .csv .zip) │
└──────────────────────────────────────────────┘
        ↓ (reads in about 1 s; format found automatically)
Nexus file · exported 26 Sep · 42 products · Amazon IT, eBay DE
128 changes · 40 products · 6 listings          3 problems
[ grid: SKU · Listing · Column · Now → New ]   ( All | Problems )
[ Download file with problems marked ]
                         [ Apply 125 changes, skip 3 ]
        ↓ (progress bar with counts)
Done · 125 changes saved      [ Undo ]  [ Send 6 listings to channels ]
```

- **One review screen:** a flat grid of changed cells only. There are no nested panels, no modal on top, and no scope selects.
- **Problems** have plain reasons, for example "Row 14 · Colour: 'Nero opaco' is not an Amazon IT choice." **Download file with problems marked** returns the same file with those cells red and a note on each. The user fixes it and drops it again.
- **Only risky actions need a tick in the summary:** new products, ending a listing, or a new seller-SKU link. Nothing else asks for confirmation.
- **A row changed in Nexus after export:**
  - A cell the user did not change is ignored.
  - A cell the user did change, which also changed in Nexus, is a problem: "Changed in Nexus after your export: now X".
  - The rest of the row still applies.
  - This replaces today's "whole row fails".
- **Other files:** Amazon templates, eBay workbooks and plain CSVs use the same screen. The existing readers find the format. A CSV with unknown headers gets one small column-matching step. This is the only extra step, and only for supplier files.

### 4.3 The file

- **Tabs:**
  - `Shared` — one row per SKU; text columns per language, for example `Title (IT)` and `Title (DE)`.
  - One tab per channel · market · account · product type, for example `Amazon IT · JACKET`.
  - `Lists` (dropdown values, hidden).
  - `About` (how to use the file, 6 lines).
  - A hidden manifest.
- **Rows on channel tabs:** one per listing. The first columns are `SKU`, `Listing` (`Primary` or the alias label) and the read-only channel id (`Seller SKU` / `ASIN` / `Item ID`). The hidden columns are `aliasKey` and `version`.
- **Headers:** row 1 is the English label, with `*` when required. Row 2 is a hidden machine key, using today's grammar `field@channel:MARKET:lang`. The account is kept in the manifest.
- **Cells:**
  - A choice field gets a dropdown (from `Lists`).
  - A read-only field is grey and locked.
  - A field that does not apply to the row's product type is grey.
  - A value the current schema does not declare goes in an `Other stored values` block at the end, clearly marked.
- **The export ID** is kept in the manifest. The server keeps the exported values (the baseline) for 30 days, as today. With it, import knows exactly what the user changed.
- **Amazon price columns stay out** until the sale-price wipe is fixed (`amazon-sp-api.client.ts` `patchListingPrice`). This follows the sheet's own rule (`ebay-price-held.vitest.test.ts`).

### 4.4 Engine

```
READ (worker thread, existing readers)
  → CELLS: one list {product, listing coordinate or Shared, field, language, value}
  → MATCH  (bulk: SKU → SkuAlias → aliasKey → seller SKU / ASIN / Item ID; about 5 queries, not per row)
  → DIFF   (bulk-load current values once; keep only changed cells; three-way diff with the export baseline)
  → CHECK  (column contracts loaded once per channel·market·account·type for the whole job; existing value checks)
  → PREVIEW rows saved in one new table `ImportChange` (one row per changed cell: before, after, status, problem)
  → APPLY  (chunks of about 200 products per transaction, READ COMMITTED + version guard, set-based writes
            through the existing store writers; a conflict refuses that product only)
  → AFTER  (once per job: readiness per family, read-cache refresh, audit createMany, outbound only if D1 says so)
  → UNDO   (apply the `before` values of `ImportChange` where the value is still the job's `after`)
```

- **Jobs:** they run in the background with a lease, and the existing recovery timer stays. When PR #4 lands, they move to the separate worker process.
- **The poll** reads a small status row (counts only), never the big JSON.
- **`ImportChange`:** one additive migration (additive migrations are pre-approved). It gives review paging, the problems file, audit and undo from one place.

### 4.5 Speed targets (to confirm after step 0)

| Case | Today | Target |
|---|---|---|
| Family file 42 SKUs, 50 cells changed: drop → summary | not measured | < 2 s |
| Same: Apply → done | not measured | < 3 s |
| Amazon DE file, 6,326 rows / 1,796 changed cells / 41 listings: drop → done | 30.1 s (local) | < 6 s |
| All 89 corpus files together | 587 s (local) | < 150 s |
| Export family 42 SKUs × 4 channels | not measured | < 3 s |
| 500 SKUs × 300 columns import, 5,000 changes | not measured | < 20 s |

### 4.6 Aliases — both ways

- **Export:** one row per active listing alias, with its label, hidden `aliasKey`, and seller SKU / Item ID. Archived aliases stay out (the catalog page gets this fix too).
- **Import order of matching:** `aliasKey` (Nexus file) → seller SKU / ASIN / eBay Item ID → `SKU` + `Listing` label. The `SKU` column also accepts `SkuAlias` codes. An ambiguous match is a problem, never a guess.
- **Also:**
  - The formula guards cover alias listings too (fixes `pim/catalog-transfer-plan.ts:688,691`).
  - A seller-SKU index (one normalised column or a lookup table) replaces the 6-place JSON scan.
- **Not in v1:** creating a new alias from a file. Aliases are still created in the sheet.

### 4.7 Keep, rebuild, delete

**Keep (reuse as is):**
- `pim/catalog-csv-dialect.ts`
- `pim/channel-file-sniff.ts`
- `apps/api/src/services/amazon/template-workbook.ts` (`detectAmazonTemplate`)
- the readers and matchers in `pim/catalog-amazon-workbook.ts` and `pim/catalog-ebay-workbook.ts`
- `pim/workbook-parse.ts` + worker
- `readCatalogWorkbook` / `parseTransferRecords`
- `validateChannelValue`, `coerceForShape`, `channelValuePatch`, `writeContent`
- the content readers (`resolveContent`, `storedChannelState`)
- `market-languages.ts`
- `packages/shared/content-header.ts` (header grammar)
- `apps/api/scripts/cfi-corpus-proof.mts` (becomes the speed and correctness gate)

**Rebuild:**
- the job runner (`pim/catalog-transfer-jobs.ts`)
- the planner (`pim/catalog-transfer-plan.ts` — its rules are split into small tested functions, and its tests become the spec)
- the export (`pim/catalog-transfer-export.ts` on `getStudioColumns`, with a streaming writer)
- the preview effects (`pim/catalog-transfer-effects.ts`, `pim/catalog-transfer-preserved.ts`)
- all web screens

**Delete (after the new flow passes):**
- `ProductTransferDrawer`, `ImportDrawer`, `ImportJobPanel`, `VariantTransfer`, `fixture.ts`, `transport.ts`, `diffModel.ts` (+ tests replaced)
- the 4-tab `ct/` page (`/products/catalog-transfer` keeps the route, with the same two buttons)
- the dead `/bulk-operations/imports` components
- `/products/:id/import/*`
- `exportSheet`
- the v1 engine in `pim/catalog-transfer.service.ts`, once `presentation-assignment.service.ts` moves off it

The supplier-file mapping and scheduled imports move onto the new engine. They are not deleted.

### 4.8 Design system

- Compose these from `apps/web/src/design-system`: `Modal`/`Drawer`, `FileDropzone`, `SegmentedControl`, `CheckboxCard`, `DataGrid`, `ProgressBar`, `Banner`, `useToast`, `MetricStrip`.
- Add these missing pieces to the design system, mirror them to `apps/factory`, and add each to the catalog, the changelog and `.claude/DS-GAPS.md`:
  - `FileRow` (the chosen file: name, size, replace)
  - `downloadFile()` (hand-rolled 3× today)
  - `JobProgress` (polling, counts, "continues if you close")
- `DESIGN.md` is at the repo root. `AGENTS.md` says it is in the DS folder; that note is wrong.

---

## 5. Build order (each step ends with proof)

| Step | What | Proof |
|---|---|---|
| 0 | Private DB copy (name contains `test`), own API :8093 + web :3003 with `NEXUS_AMAZON_ENV_TOKEN=off`, benchmark script over the CFI corpus + one family round trip, split by stage | Baseline table filled in §4.5 |
| 1 | `ImportChange` table + CELLS/MATCH/DIFF/CHECK engine (pure, bulk) reusing the readers | Corpus proof: same decisions as today on all 89 files; round trip 100 %; one planted change caught |
| 2 | APPLY in chunks + AFTER once per job + UNDO | Race test on `concurrent-database.ts` (not PGlite); undo restores; speed targets |
| 3 | Export on `getStudioColumns` + streaming writer + aliases + seller SKU | Every channel tab = the sheet's columns (parity test); Shopify metafields present; no silent drops |
| 4 | Web: Export dialog + Import dialog, DS gaps filled | Real browser: 3-action import, 2-action export, light and dark, keyboard, 375 px width |
| 5 | Switch every button to the new dialogs; delete the old code; update the presence-vocabulary baseline | Guards green; no dead imports |

**Coordination:**
- Another session (`/private/tmp/nexus-product-sheet-20260926`, branch `feature/product-sheet-20260926`) edits `SheetToolbar.tsx` and both sheet adapters today. Step 5 touches only the two button hand-offs there, and rebases onto their work.
- Before step 1, write a claim row in `docs/pes-claims.md`.

---

## 6. Decisions for the Owner

**D1 — Does an import send changes to the channels?**
- **(a) Recommended:** no. Import saves in Nexus only. The done screen shows **Send N listings to channels**. Bulk mistakes do not go live without a second click.
- (b) Same as editing the sheet today. A change to shared text queues channel updates after 30 s. The summary must then say so.

**D2 — Native channel files (Amazon `.xlsm`, eBay workbook) as an export format?**
- **(a) Recommended:** later, as phase 2, built from the same store. That also closes the flat-file split. v1 exports the Nexus file only. Import of Amazon/eBay files works from day 1, because those readers exist.
- (b) In v1. This adds about one step. The Amazon template writer must then read the product-sheet store.

---

## 7. Traps to respect

- Run api vitest **only from `apps/api`**, and print the DB host first. The DB name must contain `test`.
- Start the local API with `NEXUS_AMAZON_ENV_TOKEN=off`. Stop servers by PID only.
- A zero-change round trip cannot test the write. Always flip one cell as a positive control.
- PGlite cannot show a race. Use `concurrent-database.ts`.
- The Shopify schema is cache-only and silently empty when cold. Export must warm it or refuse.
- `grep` here is ugrep and skips gitignored files. Use `/usr/bin/grep`.
- Shared design-system edits must be mirrored to `apps/factory`.

---

## 8. Built — 2026-09-26 (local; where the build differs from §1–§7)

**Result (GALE-JACKET, 21 products, 130 listings, 40 changed cells, fresh DB copy):**
with readiness after the save (load 8.9): export 1.4 s · read 0.8 s · check 0.3 s · **save 2.1 s** · **total 4.7 s (was 85 s)** · readiness
rebuilt 4.6 s after the save. Before that change (load 13): save 9.3 s, total 12.7 s. · 0 problems (was 284 false ones) · 0 failed (was 5) ·
Undo put back 40/40 · 0 channel updates queued. VENTRA (41 products, 136 listings, 136 changed cells): total 17–20 s, 12 real problems found.

**How it differs from the plan, and why:**
1. **The planner's rules were kept, not rewritten** (§4.7 said "rebuild the planner"). `buildTransferPlan` holds ~30 measured production rules
   (parents, aliases, channel files, prices, formulas, languages). Rewriting them would reopen each one. The speed came from what the
   planner is FED (changed cells only) and how records are SAVED (many per transaction), not from the rules. One rule was relaxed:
   a variant's `INHERIT` on a native field (e.g. `name`) is no longer refused as "Name cannot be empty" — its parent's value is used.
2. **No new table, no migration** (§4.4 proposed `ImportChange`). The existing `BulkOperation` + `ImportJob` + `ImportJobRow` hold the
   job (kind `sheet-import-v1`), one row per record, cells inside. Undo reads the saved records' before/after.
3. **Undo = a second import** of the saved cells' before-values, each expecting the import's after-value (three-way), saved on its own
   when clean. Not undone: listings created or ended by a channel file, prices, seller SKUs, parent/family/category.
4. **"Send N listings to channels"** is the product's own **Publish…** dialog (the one door that reviews what goes out).
5. **Problems file** is a CSV list (sheet · row · column · SKU · reason), not the same file with red cells (that needs the upload's bytes kept).
6. **Export writer is still ExcelJS in memory** (1.9 s for GALE — not a measured problem). Streaming is left for a larger family.
7. **The Amazon seller-specific schema is not used** (only Shopify gets the account): an account-specific Amazon read is a live SP-API call
   on a cache miss, and neither export nor import should wait on one.

**Left for later (not built):**
- **Variants tab** keeps its own Import/Export (variant structure: axis values and inclusion per account and market — a different job).
- **`/products/catalog-transfer`** (catalog-wide page, 4 tabs) is unchanged; the product sheet no longer uses it. Import-wizard,
  scheduled imports and the supplier-file mapping still run on the old catalog runner (unchanged behaviour; the named rule in memory).
- ~~Readiness rebuild at commit~~ **DONE 2026-09-26 (the Owner chose B):** an import notes each family and rebuilds its readiness once,
  right after the save commits (`deferReadiness` + `refreshSheetReadiness`); the job says `readiness: pending → done | failed`, the page
  reloads the sheet again when it lands, and `recoverSheetImports` finishes a rebuild a restart interrupted. Every other writer is unchanged.
- **SkuAlias matching** (alternate SKU codes in the SKU column) and **seller-SKU / ASIN matching for Nexus files** are not built: a Nexus
  file carries the hidden listing key, so it never needs them; they matter for supplier CSVs.
- **Narrow screens:** the dialogs fit a 390 px width with no page overflow; the four number tiles stack in one column (a `MetricStrip`
  design-system behaviour) and the change table scrolls sideways inside its box.
- **Native Amazon `.xlsm` / eBay export** — D2 (a), phase 2.
