# Paste-ready Claude Code prompt — Amazon Ads import/export + zero-drift

Copy everything below the line into your terminal session at the repo root.

---

We are hardening the Amazon Ads cockpit at `/marketing/ads/campaigns` and building a proper enterprise-grade XLSX import/export round trip plus zero-drift sync.

Three documents in the Obsidian vault are the brief. Read all three **in full** before writing any code:

- `obsidian-vault/30 - Amazon Ads Platform Audit.md` — audit of the live code with a ranked defect and gap list
- `obsidian-vault/31 - Amazon Ads Competitor Teardown.md` — how Pacvue, Perpetua, Skai, Rithum and 14 others are structured, what to steal, what nobody does
- `obsidian-vault/32 - Amazon Ads Import-Export & Sync Spec.md` — the build: workbook design, import pipeline, sync architecture, phase plan

## Rule zero: extend what exists, never create a parallel file

This platform is already large — **276 advertising endpoints, 132 services, 13 ads cron jobs, 30+ UI route groups**. Almost nothing here is new construction.

Before creating **any** file, search for its existing counterpart. Specifically, these already exist and must be **extended in place**:

| Concern | File |
|---|---|
| Ads HTTP surface | `apps/api/src/routes/advertising.routes.ts` — 411 KB, 276 routes. `/advertising/bulk/export` is at line ~4054, `/advertising/bulk/apply` follows it. **Rewrite these two in place.** A duplicate Fastify route registration is a **boot crash, not a 4xx**. |
| Amazon Ads client | `apps/api/src/services/advertising/ads-api-client.ts` |
| Write path | `apps/api/src/services/advertising/ads-mutation.service.ts` |
| Write gate | `apps/api/src/services/advertising/ads-write-gate.ts` — reuse unchanged, every bulk write goes through it |
| Write reconcile | `apps/api/src/services/advertising/ads-write-reconcile.service.ts` |
| Read reconcile | `apps/api/src/services/advertising/ads-reconcile.service.ts` |
| Marketing Stream | `apps/api/src/services/advertising/ads-marketing-stream.service.ts` — line 32 marks the datasets deliberately left unsubscribed |
| Stream ingest | `apps/api/src/jobs/ams-sqs-poll.job.ts` |
| Bulk job substrate | `apps/api/src/workers/bulk-job.worker.ts` + `ImportJob` / `ImportJobRow` / `ExportJob` / `BulkActionJob` — **reuse, do not invent a parallel job model** |
| Rollback | `apps/api/src/services/advertising/rollback.service.ts` + `AdvertisingActionLog` |
| Grid | `apps/web/src/app/marketing/ads/campaigns/_grid/AdsDataGrid.tsx` |
| In-grid bulk actions | `apps/web/src/app/marketing/ads/campaigns/_grid/bulkActions.tsx` |

Genuinely new files are limited to: a spreadsheet adapter module, the workbook schema definitions, the import/export BullMQ jobs, and the `/marketing/ads/bulk` page. Everything else is an edit.

`advertising.routes.ts` contains `€` — use `grep -a`.

Same applies to the eBay side, which I got wrong last time: `ebay-ads.routes.ts` (86 KB), the `EbayCampaign`/`EbayAd`/`EbayKeyword` models and the `/marketing/ads/ebay` UI subtree all already exist.

## Start with the four silent-corruption bugs

These are shipping wrong data right now. Fix them first, independently of the larger build:

1. **`ads-api-client.ts` / `AmazonAdsConnection`** — from **2026-07-30** Amazon refresh tokens expire **365 days from consent**. Nothing tracks token age. Add `tokenIssuedAt`, surface days-to-expiry, alert at 30 days. Every connection dies silently a year after authorisation otherwise.
2. **Exporter, `advertising.routes.ts` ~4054** — `Targeting type` is derived by regex on the campaign *name* (`isAuto = /\bauto|close match|.../i`). A manual campaign called "Autumn Boots" exports as `auto`. Read the real field.
3. **Exporter** — long numeric campaign/ad-group/keyword IDs are written as raw values. Excel coerces them to scientific notation and float64 loses precision above 2^53, so the file corrupts its own identity columns. Write every ID, SKU and ASIN as a **string cell with `numFmt:'@'`**.
4. **Importer** — `const bidEur = Number.isFinite(bid) && bid > 0 ? bid : 0.5`. An unparseable bid **silently becomes €0.50**. With Italian decimals (`1,25`) that is every bid in the file. Same pattern in match-type parsing, which collapses anything unrecognised to `EXACT` — and match type is immutable on Amazon, so the "fix" is archive-and-recreate, losing all history.

Also: the exporter silently truncates at 500 campaigns and 200 targets per ad group. Make it loud or make it complete.

## Then resolve the data model, before anything else is built

`packages/database/prisma/schema.prisma` carries **two generations of the same entities**, roughly 10,700 lines apart:

| Generation A (~line 2600) | Generation B (~line 13300) |
|---|---|
| `Campaign` | `AmazonAdsCampaignDetail` |
| `AdTarget` | `CampaignTarget` |
| `BudgetPool` / `BudgetPoolAllocation` / `BudgetPoolRebalance` | `CampaignBudget` / `CampaignBudgetAllocation` / `CampaignBudgetRebalance` |

Any export, report or rule reading the wrong one produces numbers that disagree with the other. **This is the most likely source of the inconsistencies.** Declare one canonical, migrate readers, delete the other. There is no point building a beautiful exporter over two contradictory models.

## What the export must be

Not a data dump — a **decision surface** the user works in and uploads back. Full detail in spec §2; the shape:

**Nine sheets in tab order:** `README` · `Sponsored Products` · `Sponsored Brands` · `Sponsored Display` · `Portfolios` · `Summary` · `Dictionary` · `Lists` (hidden) · `_meta` (hidden). The Dictionary is generated from the same TypeScript schema object that drives the export and the validation — never hand-maintained.

**Columns:** Amazon's native bulksheet layout (`Product` / `Entity` / `Operation` first, then the full SP column set including `ASIN`, placement `Percentage`, and the 2026 `Off-Amazon ad serving`), plus our additions — hidden `_row_key` and `_baseline`, read-only performance context, and **`Break-even Bid` / `Break-even ACOS` / `Suggested Bid` / `Recommendation` as columns in the grid** (from `true-profit-rollup.service` and `ads-bid-suggest.service`). ACOS is a ratio with no decision attached; break-even bid *is* the decision, and no competitor ships it in the sheet.

**All entity types**, not the current four: Campaign, Ad Group, Product Ad, Keyword, Negative Keyword, Campaign Negative Keyword, Product Targeting, Negative Product Targeting, **Bidding Adjustment (placement modifiers)** — plus the SB and SD entity sets.

**Enterprise formatting, all of it:** frozen panes at 1 row × 3 identity columns · autofilter over the exact used range · column widths at `min(60, max(headerLen, p95(cellLen))+2)` · number formats per column (percentages stored as **fractions** with `'0.00%'`, never `23.14` with a `%` string) · styled header row with the Dictionary definition as a cell comment on each header · **5–7 conditional formatting rules maximum** (ACOS colour scale, spend data bars, `clicks>50 AND orders=0`, `Bid > Break-even Bid`, paused rows greyed) — more than that and Excel recalculates on every edit until the file feels broken · **data-validation dropdowns on every enum column** sourced from named ranges on the `Lists` sheet, with prompt and error text · sheet protection with editable cells explicitly unlocked and sort/filter still permitted · named ranges so users can `=SUMIFS(AdsData…)` in their own workbook · no merged cells, no spacer rows, no interleaved subtotals — totals live on `Summary` with `SUBTOTAL(109,…)` so they respect filters.

**Do not use a real Excel Table (ListObject)** — Numbers handles them worst. Manual banding via `MOD(ROW(),2)=0` plus autofilter.

**Because you are in Italy and read these in Numbers, three things are load-bearing:** XLSX is immune to the `1,25` vs `1.25` decimal problem because numbers are stored invariant and rendered per locale — so **XLSX is primary and CSV is an explicit escape hatch**, and CSV import must *sniff* the decimal separator and `;` delimiter rather than assume. Second, **Numbers silently drops all data validation and ignores sheet protection** — dropdowns are a UX aid, the server-side validator is the only real gate, and the file must stay unambiguously parseable after Numbers has stripped every rich feature from it. Third, **Numbers writes structurally different XLSX** (different `dimension` refs, sometimes missing `r` attributes on rows and cells) — keep a fixture that has been round-tripped through Numbers and test the parser against it in CI.

Library: **`@protobi/exceljs`**, the maintained MIT fork — upstream `exceljs` has been unmaintained since Oct 2023 and npm's `xlsx` is frozen at 0.18.5 with known CVEs. Put every call behind `SpreadsheetWriter` / `SpreadsheetReader` interfaces in one module. Stream above ~20k rows with `WorkbookWriter`, and **guard the backpressure bug (exceljs#2916)** with a drain check every 1,000 rows or RSS grows unboundedly.

## What the import must be

The current importer accepts **JSON, not a file** — so the round trip is broken at the interface. And it cannot update a keyword bid, which is the most common bulk operation in Amazon PPC. Rebuild it as five stages (spec §3):

1. **Pre-import** — "Download template" and "Download current data" on the same screen as the uploader. The template is the spec.
2. **Upload** — `@fastify/multipart` streamed to disk, magic-byte MIME sniff, size cap, **zip-bomb defence** (cap uncompressed size and entry count before parsing), `202 Accepted` + job id.
3. **Structural validation** — all-or-nothing. Headers matched **by normalised slug with an alias table**, not by index. Extra columns allowed and ignored.
4. **Row validation** — never fail fast. Validate everything, collect all errors with sheet + cell address + received value + suggestion, cap at ~5,000. Stage the plan into `ImportJobRow`.
5. **Dry-run preview** — counts, field-level diff, **blast-radius warnings** ("raises total daily budget by €1,240 (+38%)", "pauses 412 keywords", "12 rows archive entities — archive is irreversible on Amazon"), conflict list from `_baseline` mismatches with keep-mine / keep-Amazon's / skip. **Persist the plan with a token and re-validate against that same plan at apply time** so preview and apply cannot diverge.

Apply is per-row independent with partial success by default and a strict-mode opt-out. Every applied row goes through the **existing** `ads-mutation.service` → `ads-write-gate` → outbox path; the importer never calls Amazon directly. Every apply registers as a change set in `AdvertisingActionLog` so `/actions/:executionId/rollback` reverts a whole upload in one click — **no competitor has undo, and we already have the primitive.**

Idempotency via a unique index on `hash(importId, _row_key, fieldName, newValue)`.

On errors, return an **annotated copy of the uploaded workbook**: `_status` / `_errors` / `_applied_at` columns, red fill and a comment on the specific offending cell, autofilter preset to `_status <> ok`, an `Errors` summary sheet, all original columns preserved — and **`_baseline` refreshed to post-apply values for successful rows**, so re-uploading the corrected file processes only what failed. Localise error text to Italian.

## What "real-time" means here

Amazon has hard latency floors, so the goal is **zero drift**, not zero latency: our state always converges to Amazon's, every write verified, every drift detected and surfaced, nothing silently out of sync.

Three things make that possible (spec §4):

**Model three states, not two** — `intended` (what an operator or rule asked for), `observed` (what Amazon last told us), `reported` (what reporting attributes, restated for up to 60 days). Drift is `intended ≠ observed`. Without this separation, "our write hasn't propagated", "someone changed it in Seller Central" and "the write failed silently" are indistinguishable.

**Subscribe the missing Marketing Stream datasets.** `ads-marketing-stream.service.ts:34` subscribes only `sp-traffic` and `sp-conversion`; line 32 says the rest were deliberately deferred. Add `campaigns`, `adgroups`, `ads`, `targets` (near-real-time change events — the *only* push signal that someone edited in Seller Central, GA since Dec 2025) and `budget-usage` (event-driven at every 5% consumption increment), plus the SB/SD performance datasets. Route by dataset in `ams-sqs-poll.job.ts`. **Label them honestly in the UI** — the `*-traffic` and `*-conversion` sets are hourly rollups delivered 1–3h late, not real-time; only `budget-usage` and the four change datasets are event-driven.

**Give ad mutations their own typed queue.** They currently ride `OutboundSyncQueue`, a product/listing model with `productId` and `channelListingId` and no campaign/ad-group/target foreign key — so in-flight writes can only be found by parsing a JSON blob. A typed `AdMutation` (entityType, entityId, field, intendedValue, previousValue, changeSetId, idempotencyKey, actor) unlocks per-entity write serialization, cheap pending-writes queries, per-row grid badges and change-set rollback. Keep the existing grace period, dead-lettering and `ads-write-gate` exactly as they are — that part is already right.

Then harden `ads-api-client.ts`: honour `Retry-After` (note `POST /reporting/reports` doesn't reliably send it), exponential backoff with full jitter, **separate retry budgets for 429 and HTTP 423 `ConcurrentModificationException`** (new June 2026, fires on concurrent writes to one entity), and a **global per-region token bucket** — Amazon's limits are regional and dynamic, and adding accounts does not increase throughput.

## The cheapest win in the whole plan

**Data vintage.** Stamp every performance row `provisional` (D-0/D-1, display only, never a rule input) · `stabilising` (D-2/D-3) · `settling` (D-4/D-14) · `settled` (D-15/D-59) · `final` (D+60). Re-pull at 1, 3, 7, 14, 30 and 59 days. Show it as a badge — "provisional · last synced 14:02 · restated 3×" — and stamp it on every export's `_meta` and README.

Amazon restates for up to 60 days; an independent study of 14,991 campaigns found the top 5% moved impressions **≥36.67%** between day 1 and day 17. Every competitor inherits this and **not one exposes it**, which is why the same complaint recurs verbatim across all of them. Notably, the platform in the teardown with the *least* real-time infrastructure has the *best* reputation for accuracy, purely because it doesn't surprise people.

## How to proceed

1. Read the three vault documents and the related notes (`20 - Advertising`, `24 - Bulk Operations & Automation`, `05 - Database Schema`, `06 - Background Jobs & Workers`).
2. **Do not start coding.** Produce a written plan for **AX-IE.0 and AX-IE.1 only** — the four silent-corruption bugs, and the canonical-model decision. For the model decision I want: which generation is canonical and the evidence for it, every read site that must migrate, the migration order, and the rollback plan.
3. Flag every place the spec conflicts with the real code. The spec was written from a read-only audit; the source is authoritative where they disagree.
4. List which of the spec's open items block AX-IE.0/.1 and which can wait — in particular the exact SP full-download column list, the SB and SD bulksheet schemas under bulksheets 2.0, and per-resource batch maxima, none of which could be verified from Amazon's docs because `advertising.amazon.com/API/docs` is a client-rendered SPA that returns an empty shell to fetchers. Those need one real bulksheet download and one live API probe.
5. Wait for my approval before implementing.
