# Amazon Ads Import/Export & Zero-Drift Sync Spec

→ [[00 - Nexus Commerce MOC]] | [[30 - Amazon Ads Platform Audit]] | [[31 - Amazon Ads Competitor Teardown]]

Series: **AX-IE** (import/export) and **AX-ZD** (zero drift). Scope: SP + SB + SD. Everything here **extends existing files** — see §0.

---

## 0. Files this touches — extend, do not create parallel

| Concern | Existing file | Action |
|---|---|---|
| Ads HTTP surface | `apps/api/src/routes/advertising.routes.ts` (411 KB, 276 routes) | **Extend.** `/advertising/bulk/export` at :4054 and `/advertising/bulk/apply` are rewritten in place. Duplicate Fastify route registration is a boot crash. |
| Amazon Ads client | `apps/api/src/services/advertising/ads-api-client.ts` | **Extend** — 423 handling, `Retry-After`, jitter, token expiry |
| Write path | `apps/api/src/services/advertising/ads-mutation.service.ts` | **Extend** — typed ad-mutation queue |
| Write gate | `apps/api/src/services/advertising/ads-write-gate.ts` | Reuse unchanged — every bulk write passes through it |
| Write reconcile | `apps/api/src/services/advertising/ads-write-reconcile.service.ts` | **Extend** |
| Read reconcile | `apps/api/src/services/advertising/ads-reconcile.service.ts` | **Extend** |
| Marketing Stream | `apps/api/src/services/advertising/ads-marketing-stream.service.ts` (181 lines, line 32 marks the unsubscribed datasets) | **Extend** — add the 5 missing datasets |
| Stream ingest | `apps/api/src/jobs/ams-sqs-poll.job.ts` (70 lines) | **Extend** — route by dataset |
| Bulk job substrate | `apps/api/src/workers/bulk-job.worker.ts`, `ImportJob`, `ImportJobRow`, `ExportJob`, `BulkActionJob` | **Reuse** — do not invent a parallel job model |
| Progress UI | `BulkProgressBanner`, SSE via `/advertising/events` | **Reuse** |
| Grid | `apps/web/src/app/marketing/ads/campaigns/_grid/AdsDataGrid.tsx` | **Extend** — predicate selection |
| Bulk actions | `apps/web/src/app/marketing/ads/campaigns/_grid/bulkActions.tsx` | **Extend** |
| Rollback | `apps/api/src/services/advertising/rollback.service.ts`, `AdvertisingActionLog` | **Reuse** — every bulk apply becomes a revertible change set |

**New files are limited to:** a spreadsheet adapter module, the workbook schema definitions, the import/export BullMQ jobs, and the bulk UI page — none of which have an existing counterpart.

Reminder: `advertising.routes.ts` contains `€`. Use `grep -a`.

---

## 1. Ground truth that constrains the design

- **There is no Amazon API for uploading or downloading bulksheets.** Bulk operations is a console feature. Our XLSX is *our* format; we round-trip it through the Campaign Management API. We can emit an Amazon-compatible bulksheet and parse one, but we cannot submit one programmatically.
- **No idempotency keys exist anywhere in the Amazon Ads API.** Client-side idempotency is mandatory. Campaign names are unique per profile per ad product — the best available natural key.
- **No published rate limits.** They are dynamic, regional and queue-depth-driven. **Adding accounts does not increase throughput** — the bucket is regional. Global per-region token bucket, ~20 concurrent, back off on 429.
- **HTTP 423 `ConcurrentModificationException`** (since 2026-06-03) fires on concurrent mutations to one entity, and is retryable. Serialize writes per entity ID.
- **`archived` is terminal.** No unarchive exists, by API or UI. It is Amazon's delete.
- **Match type is immutable.** Broad→Exact is archive + create, which resets the ID and destroys performance history. Model it as delete+create in the diff engine, never as an update.
- **Data restates for up to 60 days.** Clicks/cost settle in 48–72h, conversions up to 14 days, revisions to 60. Never make ROAS decisions on the last 3 days.
- **Refresh tokens expire 365 days from consent from 2026-07-30.**

---

## 2. The export workbook (AX-IE.1–4)

### 2.1 Workbook structure — sheet order is the tab order the user sees

| # | Sheet | Visible | Purpose |
|---|---|---|---|
| 1 | `README` | ✅ | What this is, what it covers, which columns are editable, how to re-upload, the don't-do list |
| 2 | `Sponsored Products` | ✅ | Flat, pivot-ready, the editable grid |
| 3 | `Sponsored Brands` | ✅ | Same shape, SB entities incl. creatives |
| 4 | `Sponsored Display` | ✅ | Same shape, SD entities |
| 5 | `Portfolios` | ✅ | Portfolio rows |
| 6 | `Summary` | ✅ | `SUBTOTAL(109,…)` aggregates that respect filters |
| 7 | `Dictionary` | ✅ | column · label · type · unit · editable · allowed values · example · definition · source |
| 8 | `Lists` | hidden | Named ranges backing every dropdown |
| 9 | `_meta` | hidden | exportId, schemaVersion, generatedAt, profileId, marketplace, dateRange, rowCount, HMAC |

Generate `Dictionary` from the same TypeScript schema object that drives the export. Never hand-maintain it.

### 2.2 Columns — Amazon-native layout plus our additions

First three columns are the structural invariant Amazon relies on: **`Product` (A), `Entity` (B), `Operation` (C)**.

Then Amazon's SP layout: `Campaign Id`, `Ad Group Id`, `Portfolio Id`, `Ad Id`, `Keyword Id`, `Product Targeting Id`, `Campaign Name`, `Ad Group Name`, informational-mirror name columns, `Start Date`, `End Date`, `Targeting Type`, `State`, `Campaign State (Informational only)`, `Ad Group State (Informational only)`, `Daily Budget`, `SKU`, `ASIN`, eligibility columns, `Ad Group Default Bid`, `Bid`, `Keyword Text`, `Native Language Keyword`, `Native Language Locale`, `Match Type`, `Bidding Strategy`, `Placement`, `Percentage`, `Product Targeting Expression`, and — new since 2026-06-08, US only — `Off-Amazon ad serving`.

**Our added columns**, which are what make the file a decision surface rather than a data dump:

| Column | Why |
|---|---|
| `_row_key` (hidden, locked, col A-adjacent) | Opaque stable key `sp:kw:{profileId}:{keywordId}`. **The only join key on import.** Never infer identity from row position. |
| `_baseline` (hidden, locked) | Hash of the editable field values at export time. On import, mismatch ⇒ conflict, not clobber. Row-level optimistic concurrency, and the single highest-value column in the file. |
| `Impressions`, `Clicks`, `CTR`, `Spend`, `Sales`, `Orders`, `Units`, `CVR`, `ACOS`, `CPC`, `ROAS` | Read-only context beside the editable cells |
| **`Break-even Bid`**, **`Break-even ACOS`** | Computed from `true-profit-rollup.service`. ACOS is a ratio with no decision attached; break-even bid *is* the decision. Nobody else ships this in the grid. |
| **`Suggested Bid`**, `Suggested Bid Low/High` | From `ads-bid-suggest.service` |
| **`Recommendation`**, `Recommendation Reason` | The system's proposal as a column, so bulk accept is just "copy this column into Bid" |
| `Data Vintage` | `provisional` / `stabilising` / `settled` per date — see §5 |
| `Tags` | Multi-valued grouping dimension |
| `Marketplace`, `Portfolio Name`, `Campaign Type`, `Match Type` | Dimension columns repeated on every row — pivots need them even when redundant |
| `Last Synced At`, `Pending Write` | Consistency state, per row |

Editable columns get a **green header**; read-only get **grey**. Stated in the README and in the Dictionary.

### 2.3 Enterprise formatting — every one of these

**Freeze panes.** `ws.views = [{ state:'frozen', xSplit:3, ySplit:1, activeCell:'D2' }]` — header row plus the three identity columns, so horizontal scrolling never orphans a row. Numbers only supports freezing header rows/columns, so keep it to 1 row and ≤2–3 leading columns to maximise survival.

**AutoFilter** over the exact used range, `{ from:'A1', to:{ row:last, column:nCols } }`. Never whole columns — Excel and Numbers both mishandle that.

**Column widths** computed as `min(60, max(headerLen, p95(cellLen)) + 2)`. p95 not max, so one 300-character search term doesn't blow out the layout. Do not use `bestFit` — ExcelJS doesn't measure text.

**Number formats**, the single biggest readability lever:

| Data | `numFmt` |
|---|---|
| Currency | `'#,##0.00'` + a separate `Currency` column (a workbook may span marketplaces) |
| Percent (ACOS/CTR/CVR) | store the **fraction** `0.2314`, format `'0.00%'`. Never store `23.14` with a `%` string — it destroys sortability and re-import |
| Bids / CPC | `'#,##0.00'` |
| Impressions / clicks | `'#,##0'` |
| Dates | `'yyyy-mm-dd'`, written as real `Date` objects |
| Zero suppression | `'#,##0.00;[Red]-#,##0.00;"–"'` |
| **IDs, SKU, ASIN** | **string cells with `numFmt:'@'`** — see §2.4 |

**Header row.** Bold, fill `FF1F2937`, white font, `wrapText`, height 32. Put the Dictionary definition on each header as a **cell comment** so analysts hover instead of switching sheets.

**Conditional formatting — cap at 5–7 rules.** Excel recalculates all CF rules on every edit; 20 rules over 100k rows makes the file feel broken.

1. Three-colour scale on ACOS, midpoint = target ACOS
2. Data bars on Spend and on Impressions — instant magnitude scan
3. `expression` rule: highlight `clicks > 50 AND orders = 0`
4. `expression` rule: highlight `Bid > Break-even Bid` — the money rule
5. `expression` rule `$O2="paused"` → grey italic whole row
6. Icon set on 7d-vs-28d delta

Icon sets and data bars are the usual casualties when Numbers re-saves; colour scales and simple cell-value rules survive best. Design so their loss is cosmetic.

**Dropdowns — every enum column.** `cell.dataValidation = { type:'list', allowBlank:false, formulae:['Lists_State'], showErrorMessage:true, errorTitle:…, error:…, promptTitle:…, prompt:… }`, sourced from named ranges on the hidden `Lists` sheet.

| Column | List |
|---|---|
| `Product` | Sponsored Products · Sponsored Brands · Sponsored Display |
| `Entity` | Campaign · Ad Group · Bidding Adjustment · Product Ad · Keyword · Negative Keyword · Campaign Negative Keyword · Product Targeting · Negative Product Targeting (SP); SB and SD variants on their sheets |
| `Operation` | *(blank)* · Create · Update · Archive |
| `State` | enabled · paused · archived |
| `Match Type` | Broad · Phrase · Exact · Negative Exact · Negative Phrase · Campaign Negative Exact · Campaign Negative Phrase |
| `Targeting Type` | Auto · Manual |
| `Bidding Strategy` | Dynamic bids - down only · Dynamic bids - up and down · Fixed bid |
| `Placement` | Top of search (page 1) · Rest of search · Product Pages · Amazon Business |
| `Off-Amazon ad serving` | enumerated values, US only |
| `Tags` | the tenant's tag vocabulary |

**Numbers silently drops all data validation.** Dropdowns are a UX aid, never a validation guarantee. **The server-side validator is the only real gate.**

**Sheet protection.** All cells `locked: true` by default; explicitly `locked: false` on editable columns; then `ws.protect(randomPassword, { selectLockedCells:true, selectUnlockedCells:true, sort:true, autoFilter:true, formatColumns:true })`. Sorting and filtering stay available so the file remains usable. The password is a speed bump against accidents, not security — and **Numbers ignores protection entirely**.

**Named ranges.** `AdsData` over the used range plus one per dropdown list, so a user can write `=SUMIFS(AdsData…)` in their own sheet.

**Do not use a real Excel Table (ListObject)** — Numbers handles them worst. Use manual banding via an `expression` CF on `MOD(ROW(),2)=0` plus autofilter.

**No totals inside the data sheets.** Aggregates live on `Summary` with `SUBTOTAL(109,…)` so they respect filters.

**Pivot-ready discipline:** one row = one entity at one grain. No merged cells anywhere, no blank spacer rows or columns, no interleaved subtotals, no multi-row headers, every dimension repeated on every row.

### 2.4 Type-coercion defences — non-negotiable

| Damage | Defence |
|---|---|
| Long IDs → scientific notation | Amazon IDs run to 19 digits; float64 loses precision above 2^53. **Write every ID, SKU and ASIN as a string cell with `numFmt:'@'`.** |
| Leading zeros stripped | Same — string cells, and emit XLSX not CSV |
| `= + - @` prefixes become formulas | Prefix-escape with `'` on write. Also mitigates **CSV formula injection**, a real security issue for exports. |
| Date reinterpreted (`03/04/2026` = Mar 4 US, Apr 3 IT) | Write real `Date` objects with `numFmt:'yyyy-mm-dd'`. On import accept a JS `Date`, or parse **ISO only** and reject ambiguous `dd/mm` vs `mm/dd` with a clear error rather than guessing. |
| **Decimal separator (`it-IT`: `1,25`)** | **XLSX is immune** — numbers are stored invariant in the XML and rendered per the user's locale. This alone makes XLSX primary and CSV the escape hatch. For CSV import, sniff: `^-?\d{1,3}(\.\d{3})*(,\d+)?$` ⇒ comma decimal; `^-?\d{1,3}(,\d{3})*(\.\d+)?$` ⇒ period decimal; **if ambiguous (`1,234`)** resolve by file-level majority and **state the assumption in the import preview**. |
| **CSV delimiter (`it-IT`: `;`)** | Emit `;` for European locales; on import sniff the header line counting `,` vs `;` vs `\t`. |
| Whole file in column A | You cannot have both a UTF-8 BOM and a `sep=` line — Windows Excel ignores the BOM when `sep=` is present. Use **BOM + locale-correct delimiter**, skip `sep=`. |
| NBSP / whitespace | Trim, ` `→space, NFC-normalise every string cell on import |
| Localised booleans | Accept `true/false/vero/falso/1/0/yes/no/si/enabled/paused` case-insensitively |

**Formula columns**, if included: lock them, mark read-only in the Dictionary, and **ignore them entirely on import** — read only raw inputs. Numbers hands back cached values or nothing.

Keep any exported formulas to the boring core — `SUM, SUMIFS, AVERAGE, IF, IFERROR, ROUND, XLOOKUP, SUBTOTAL`. Numbers has ~250 functions to Excel's ~450+; avoid `LET`, `LAMBDA`, dynamic arrays, `TEXTSPLIT`.

### 2.5 Library and streaming

**`@protobi/exceljs`** — the actively-maintained MIT fork; upstream `exceljs` has been effectively unmaintained since Oct 2023. `xlsx` (SheetJS) on npm is frozen at 0.18.5 with known CVEs and the current CE is CDN-only, which breaks lockfile integrity and Dependabot.

Put every library call behind `SpreadsheetWriter` / `SpreadsheetReader` interfaces in one module. The maintenance situation is unstable enough that you want a one-file swap.

**Write:** `ExcelJS.stream.xlsx.WorkbookWriter` above ~20k rows. **Known landmine — `WorkbookWriter` has no backpressure ([exceljs#2916](https://github.com/exceljs/exceljs/issues/2916)).** Committing rows in a tight loop grows RSS unboundedly:

```ts
if (i % 1000 === 0) {
  while (stream.writableLength > 1 << 20) await once(stream, 'drain')
}
```

Also: ExcelJS **duplicates `dataValidations` on round-trip write** — rebuild validations from scratch on export, never read-then-rewrite.

**Read:** `ExcelJS.stream.xlsx.WorkbookReader(path, { entries:'emit', sharedStrings:'cache', styles:'ignore', hyperlinks:'ignore', worksheets:'emit' })`. `styles:'ignore'` is a large memory win, and for import you want values not presentation. Treat `.xlsm` as **read-only input** — reject it for round-trip rather than trying to preserve macros.

**CSV:** `csv-parse` / `csv-stringify`, not the spreadsheet libraries' CSV paths — you need per-row control over delimiter, BOM and quoting.

**Numbers parity:** Numbers writes structurally different XLSX — sharedStrings used differently, different `dimension` refs, sometimes missing `r` attributes on rows and cells. **The import parser must not assume Excel-generated XML.** Keep a fixture that has been round-tripped through Numbers, and test against it in CI.

Practical caps, enforced and documented in the README sheet and on the upload UI: **100k rows / 25 MB per upload**; above that, split by campaign type or date range. Keep Numbers-targeted exports under ~50k rows per sheet.

---

## 3. The import pipeline (AX-IE.5–8)

Five stages. The whole design goal is that **nothing is written until a plan exists and the user has seen it.**

### Stage 1 — Pre-import
"Download template" and "Download current data" live on the same screen as the uploader. Guardrails beat error messages; **the template is the spec**.

### Stage 2 — Upload
Drag-drop, click and paste. `@fastify/multipart` streams to disk/S3 with `limits.fileSize` — never buffer in memory. Cheap checks first: extension, **magic-byte MIME sniff** (`.xlsx` is a ZIP starting `PK\x03\x04`), size cap, and **zip-bomb defence** — cap total uncompressed size and entry count *before* parsing. Return `202 Accepted` + `importJobId` immediately; hand the path to a BullMQ job.

### Stage 3 — Structural validation (all-or-nothing)
Schema version, required headers present, `_meta` HMAC valid, row count sane. Reject with one clear message plus a diff against the expected header list.

Column identity is **by header, not index**. Normalise to a slug, match case-insensitively, and support an alias table (`"Bid"`, `"Offerta"`, `"Puja"` → `bid`) so localised or renamed headers resolve. **Extra columns are allowed and ignored** — analysts add scratch columns and punishing that makes the file hostile. Log them.

### Stage 4 — Row validation (never fail fast)
Validate every row and collect all errors. Zod `safeParse` per row into a preallocated accumulator. Emit `{ rowNumber (1-based, matching the sheet), sheet, column, cellAddress, code, message, receivedValue, suggestion }`. Cap at ~5,000 errors with an "and N more" tail so a garbage file can't OOM the worker.

Write the plan into a Postgres staging table (`ImportJobRow`, already exists) in 5k chunks. This makes the plan durable, the preview cheap to render, and the apply resumable.

Entity-specific validation must cover: bid floors (US $0.02) and ceilings, placement percentage 0–900%, ≤1,000 keywords per ad group, campaign name 1–128 chars, ad group name 1–255, keyword ≤10 words (≤4 for negative phrase), state casing, match-type casing, and **match-type change detected as archive+create rather than update**.

### Stage 5 — Dry-run preview — the feature that earns trust
Before anything is written:

- Counts: `will create N · will update M · unchanged K · errors E · conflicts C`
- **Field-level diff table**: entity, field, current → new, formatted the same way the cockpit formats
- **Blast-radius warnings**: "raises total daily budget by €1,240 (+38%)", "pauses 412 keywords", "24 bids change by more than 50%", "**12 rows archive entities — archive is irreversible on Amazon**"
- **Conflict list** from `_baseline` mismatches, each with three choices: keep mine / keep Amazon's / skip
- A hard confirm. **The dry-run result is persisted with a token, and apply re-validates against that same computed plan** — this closes the TOCTOU window between preview and apply.

### Apply
Per-row independent, transactional per row, partial apply by default with an explicit **strict mode** checkbox for users who want atomicity. Refusing 4,000 good rows over 3 bad ones is user-hostile.

Every applied row goes through the **existing** `ads-mutation.service` → `ads-write-gate` → outbox path. The importer never calls Amazon directly. Every apply is a **change set** registered with `AdvertisingActionLog` so `/actions/:executionId/rollback` reverts the whole upload in one click — the thing no competitor has.

**Idempotency:** unique index on `hash(importId, _row_key, fieldName, newValue)` in an `import_operation` table. A double-submitted file is a no-op at the database level.

### The annotated return file
On any run with errors, regenerate the uploaded workbook with:

- Three appended columns: `_status` (`ok` / `error` / `conflict` / `skipped`), `_errors` (semicolon-joined, human-readable, **localised to Italian**), `_applied_at`
- Red fill and a cell comment on the **specific offending cell**, not just the row
- Autofilter pre-applied to `_status <> ok`
- An `Errors` summary sheet: code → count → explanation → how to fix
- **All original columns preserved verbatim, including `_row_key` and `_baseline`**

**And `_baseline` refreshed to post-apply values for successfully applied rows** — so re-uploading the corrected file sees them as unchanged no-ops and processes only what previously failed. The correction loop closes without the user thinking about it.

Error messages always carry sheet + cell address (`Sponsored Products!F412`), the received value verbatim, the expected form, and for enums the closest valid value. Never say "invalid".

### Large-file mechanics
Two-pass (validate→stage, then apply→from-stage). Batches of 1,000–5,000 with an `await` between to yield the event loop and a cancellation-flag check at each boundary. `job.updateProgress({ phase, rowsProcessed, rowsTotal, errors })` throttled to ≤2/sec, surfaced over the existing SSE. `lastProcessedRow` persisted for resume. **Import workers run in a separate BullMQ process** with explicit `--max-old-space-size` and `concurrency: 1–2`, never sharing with API traffic, plus an RSS guard that fails cleanly instead of being OOM-killed mid-write.

---

## 4. Zero-drift sync (AX-ZD.1–6)

### 4.1 Three states, not two

Every mutable field carries three values:

| State | Meaning | Source |
|---|---|---|
| **Intended** | what an operator or rule asked for | our writes |
| **Observed** | what Amazon last told us it is | list/query reads + stream change events |
| **Reported** | what reporting attributes to it | reporting API, restated for 60 days |

Drift is `intended ≠ observed`. The reconciler's only job is to drive observed toward intended, or — when the change came from Amazon's side — to surface it and ask.

This also produces honest per-row UI state: `synced` · `pending` · `applying` · `failed` · `conflict` · `externally-changed`.

### 4.2 Distinguishing external change from write lag

The question "did someone edit this in Seller Central, or has our write not landed?" is answerable only with three facts together:

1. **Do we have an in-flight write for this entity?** — requires the typed mutation queue (§4.4)
2. **Did a stream change event arrive that we did not originate?** — requires the `campaigns`/`adgroups`/`ads`/`targets` datasets
3. **How long has the write been in flight?** — assume eventual consistency, seconds to low minutes for API reads, minutes for reporting surfaces

If a change event arrives whose new value matches an in-flight intended write → that is **our write landing**; mark applied. If it does not match, and no write is in flight → **external change**; raise a conflict, do not auto-clobber.

### 4.3 Subscribe the missing Marketing Stream datasets

`ads-marketing-stream.service.ts:34` currently lists `sp-traffic, sp-conversion`. Add:

| Dataset | Use |
|---|---|
| `campaigns`, `adgroups`, `ads`, `targets` | **Near-real-time change events.** The external-change signal. GA 2025-12-01, schema-aligned with the unified Campaign Management API. |
| `budget-usage` | Event-driven at every **5% consumption increment**. Derive exhaustion as `usage ≥ 100%`, warning at ≥95%. Note it is a percentage stream, not an out-of-budget boolean — you cannot detect the exact instant, only the crossing of the last bucket. |
| `sb-traffic`, `sb-conversion`, `sd-traffic`, `sd-conversion` | SB/SD performance parity |

Extend `ams-sqs-poll.job.ts` to route by dataset rather than assuming performance shape.

Prefer **Firehose → S3** over SNS → SQS where possible: no subscription-confirmation Lambda required. Deploy the consumer in-region (NA `us-east-1`, EU `eu-west-1`, FE `us-west-2`).

**Be honest in the UI:** `*-traffic` and `*-conversion` are hourly rollups delivered 1–3h late, i.e. up to ~4h behind. Only `budget-usage` and the four change datasets are genuinely event-driven. Label them differently.

### 4.4 Typed ad-mutation queue

Ad writes currently ride `OutboundSyncQueue`, a product/listing model with no campaign/ad-group/target FK (audit §3.2). Add a typed queue — `AdMutation` — with: `entityType`, `entityId`, `externalEntityId`, `profileId`, `marketplace`, `field`, `intendedValue`, `previousValue`, `state`, `attempts`, `lastError`, `changeSetId`, `importJobId?`, `ruleId?`, `actor`, `idempotencyKey`, `holdUntil`.

This unlocks: per-entity write serialization (which prevents 423), cheap `/campaigns/:id/pending-writes`, per-row grid badges, and change-set rollback of a whole import.

Keep the existing grace-period, dead-letter and `ads-write-gate` behaviour exactly as-is — that part is already right.

### 4.5 Reconciliation tiers

Run concurrently, not as one job:

| Tier | Cadence | Mechanism |
|---|---|---|
| **Event** | continuous | Stream change datasets → update observed immediately |
| **Incremental** | 15 min | `updated-at` watermark over recently-touched entities; verify in-flight writes landed |
| **Full** | nightly | Exports API enumeration → hash every entity's field set → compare against a stored hash. Only fetch detail where the hash differs. This is how drift detection stays cheap at 10,000s of entities. |

Note the Amazon-native trap: **bulksheet downloads exclude entities with zero impressions in the window.** Never use an impression-filtered source as a drift baseline — use the Exports API.

### 4.6 Client hardening

`ads-api-client.ts`: honour `Retry-After` where present (**`POST /reporting/reports` does not reliably emit it** — fall back to jittered backoff), exponential backoff with full jitter base 1s cap 60s max ~8 attempts, **separate retry budgets for 429 and 423**, global per-region token bucket shared across all connections (the limit is regional, not per-account), ~20 concurrent cap reducing on 429, and a hard timeout on report polling (suggest 3h — reports stick in `PENDING` with no terminal transition; resubmit).

Add `tokenIssuedAt` to `AmazonAdsConnection`, surface days-to-expiry in `/marketing/ads/account-settings` and `/health`, and alert at 30 days.

---

## 5. Data vintage — the differentiator (AX-ZD.5)

Stamp every performance row with a settlement state and never hide it:

| State | Window | Rule |
|---|---|---|
| `provisional` | D-0 to D-1 | Display only. **Never** an input to a rule, bid or export decision. |
| `stabilising` | D-2 to D-3 | Clicks/cost usable; ROAS not. |
| `settling` | D-4 to D-14 | Conversions still landing. |
| `settled` | D-15 to D-59 | Safe for optimisation. |
| `final` | D+60 | Immutable. |

Re-pull a rolling window at **1, 3, 7, 14, 30 and 59 days**.

Surface it as a badge on every metric — "provisional · last synced 14:02 · restated 3×". Every export stamps the pull timestamp, per-date settlement state and attribution window in force on the `_meta` sheet **and in the README**, so two exports of "the same week" that disagree are self-explaining rather than a bug report.

Attribution windows that drive the restatement: SP sellers **7 days**, SP vendors 14, SB 14, SD 14. A conversion is attributed back to the **click date**, so a purchase on day 14 rewrites day 0's ACOS.

**This is the cheapest item in the whole spec and the one competitors most consistently fail.** The platform with the least real-time infrastructure in the market has the best data-accuracy reputation purely because it doesn't surprise people.

---

## 6. UI (AX-IE.9–10)

**New page `/marketing/ads/bulk`** — the one genuinely missing surface.

Tabs: **Export** (scope picker: ad product · marketplace · portfolio/tag · date range · entity types · "export exactly what I'm looking at" from the current grid filter) · **Import** (drop zone, template downloads, history) · **History** (every import/export job, its plan, its result, its rollback button).

Extend `AdsDataGrid.tsx` with **predicate-based selection**: "select all 47,000 rows matching this filter, except these 12". Selection is a filter reference plus an exclusion list, never an ID array. The confirm dialog shows the predicate and the count. Nobody in the market has this — Perpetua caps at 100 rows, Ad Badger at 500.

Extend `bulkActions.tsx` so in-grid bulk edits route through the same plan → preview → apply → change-set pipeline as file imports. One code path, two entry points.

Add to the existing `/marketing/ads/health` page: token expiry countdown, stream subscription status per dataset, drift summary, restatement activity, rate-limit headroom.

---

## 7. Phase plan

| Phase | Scope | Gate |
|---|---|---|
| **AX-IE.0** | P0 correctness: token expiry, ID string cells, regex targeting-type, silent €0.50 bid, silent EXACT fallback, silent truncation | Four silent-corruption bugs closed, connection expiry visible |
| **AX-IE.1** | Canonical model decision — resolve `Campaign`/`AmazonAdsCampaignDetail` and `BudgetPool*`/`CampaignBudget*` | One source of truth; all readers migrated |
| **AX-IE.2** | Spreadsheet adapter module + workbook schema definitions (schema drives export, Dictionary and validation) | Schema object generates all three |
| **AX-IE.3** | Exporter rewrite: all entities, SP/SB/SD/Portfolios sheets, full formatting + dropdowns, `_row_key`/`_baseline`/`_meta`, streamed, async job | 100k-row export completes, opens cleanly in Excel **and** Numbers |
| **AX-IE.4** | Importer: multipart, streaming parse, structural + row validation, staging table | 100k-row file validates with a complete error list, nothing written |
| **AX-IE.5** | Dry-run preview + blast radius + conflict resolution + plan token | Preview matches apply exactly |
| **AX-IE.6** | Apply: durable job, per-row idempotency, change-set registration, rollback | 10k-row import applied and reverted in one click |
| **AX-IE.7** | Annotated error workbook + `_baseline` refresh | Correction loop closes without manual reconciliation |
| **AX-IE.8** | `/marketing/ads/bulk` page + predicate selection + grid integration | Both entry points share one pipeline |
| **AX-ZD.1** | Typed `AdMutation` queue + per-entity serialization + 423/`Retry-After`/jitter | No 423s under concurrent load |
| **AX-ZD.2** | Stream: 5 missing datasets + dataset-routed ingest | External Seller Central edit detected within 60s |
| **AX-ZD.3** | Three-state model + conflict surfacing + per-row grid badges | External change distinguishable from write lag |
| **AX-ZD.4** | Three-tier reconciliation with hash-based drift detection | Nightly full reconcile inside rate budget |
| **AX-ZD.5** | Data vintage model + badges + export stamping | Two exports of the same week explain their own difference |
| **AX-ZD.6** | Scheduled imports (S3/SFTP/Sheet as nightly source of truth) + invariant tests | Convergence asserted in CI |

**AX-IE.0 and AX-IE.1 gate everything.** No point building a beautiful exporter over two contradictory data models.

---

## Related Notes

- [[30 - Amazon Ads Platform Audit]] · [[31 - Amazon Ads Competitor Teardown]] · [[20 - Advertising]] · [[24 - Bulk Operations & Automation]] · [[05 - Database Schema]]
