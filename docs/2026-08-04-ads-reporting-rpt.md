# RPT — the Ads Reporting page: audit, market research, and phased plan

**Status:** PROPOSAL AWAITING GATE · 2026-08-04
**Surface:** `/marketing/ads/reporting` (Ads console rail → `Reporting`)
**Nothing has been changed.** This document is read-only analysis plus a plan.
**Companions:** `2026-08-04-ads-market-research.md` · `2026-08-04-competitor-deep-dives.md` · `2026-08-03-legacy-ads-retirement-h1.md`

---

## 0. Decisions already taken (operator, 2026-08-04)

| # | Decision |
|---|---|
| **D1** | **Scope = ads data only** (Amazon + eBay), but the report/export engine is built **domain-agnostic** so sales/inventory/orders can register as datasets later without a rewrite. |
| **D2** | **Reporting = data. Analytics = meaning.** Reporting owns the numbers and how they move (library, runner, exports, imports, scheduling, pipeline health). Analytics owns interpretation (coverage/SOV, funnel, n-grams, momentum, incrementality) — as already assigned in the ADX plan. |
| **D3** | **Export targets:** CSV/XLSX download + scheduled email · Google Sheets live connection. **Warehouse/BI (BigQuery, Snowflake, S3) is explicitly OUT** for now. |
| **D4** | **Import is in scope**, specifically the Amazon console reports the API will not give. |
| **D5** | **No new sidebar entries.** Growth happens as children of the existing `Reporting` item, or as tabs/panels/drawers inside its pages. |
| **D6** | **One feature at a time**, each finished and gated before the next begins. |

---

## 1. What exists today

### 1.1 The page is a stub

```
apps/web/src/app/marketing/ads/reporting/page.tsx               10 lines
apps/web/src/app/marketing/ads/reporting/brand-metrics/page.tsx 10 lines
```

Both render `<div className="h10-stub">` with the text *"This screen is being rebuilt to match Adtomic — filled in as we work through each page."* So do `analytics`, `account-overview`, `amc`, `amc/audiences`. **Reporting has never been built.**

### 1.2 The nav item cannot be clicked

`apps/web/src/app/marketing/ads/_shell/AdsSidebar.tsx:107` — a rail item **with children** renders as a `<button>` whose only job is `toggle(it.route)`. It never navigates. So `Reporting` and `AMC` are unreachable by clicking their own labels; only their children are.

The commerce rail already solved this. `apps/web/src/app/_shared/AppRail.tsx:197-220` renders the parent as a `<Link>` for the label **plus a separate chevron `<button>`** for expand/collapse, with the wrapper carrying the active fill. **This is a port of an existing, working pattern — not a new invention.** That is exactly the behaviour requested.

### 1.3 The data substrate is real, and almost entirely unexposed

| Table | Grain | Source | Surfaced today |
|---|---|---|---|
| `AmazonAdsDailyPerformance` | profile × adProduct × entityType × entityId × **date** | Ads Reports API v3 | partially (grids) |
| `AmazonAdsHourlyPerformance` | + **hour** (0-23 UTC) | Amazon Marketing Stream | dayparting heatmap only |
| `AmazonAdsSearchTerm` | campaign × search term × date | v3 `spSearchTerm`/`sbSearchTerm` | legacy page only |
| `AmazonAdsPlacementReport` | campaign × placement × date (+ true `topOfSearchIS`) | v3 `spCampaigns` groupBy `campaignPlacement` | no |
| `SearchQueryPerformance` | marketplace × query × ASIN × period, with **market totals and our share** | SQP ingest | no |
| `AmazonAdsBrandBuildingMetric` | brand × week × **categoryNodeName** | Brand Metrics API | no |
| `AmazonEconomicsDaily` | ASIN/MSKU × day, **net proceeds** | SP-API Data Kiosk | no |
| `EbayAdsReportTask`, `EbayListingEconomics` | eBay ads | eBay | partially |
| `AmazonAdsReportJob`, `AmazonAdsExportJob`, `DataKioskQueryJob`, `AmazonReportRun` | job rows | pipeline | legacy page only |

Ingest already runs on cron (`ads-metrics-ingest`, `tos-is-ingest`, `sqp-ingest`, the ads-report cycle — 113 distinct cron jobs fired in 14 days per ADX.0). **The data is being collected and thrown at a wall no one can read.**

### 1.4 A legacy tree is waiting to land here

From `2026-08-03-legacy-ads-retirement-h1.md`: 25 legacy areas under `/marketing/advertising` have no home in the current console. The ones that belong to **Reporting** under D2:

| Area | Lines | Disposition |
|---|---|---|
| `reports` | 593 | **Port** → RPT.9 pipeline health |
| `feeds` | 257 | **Port** → RPT.9 |
| `profit` | 241 | **Port** → a report in the library (RPT.2/3) |
| `insights` (396), `funnel` (160), `share-of-voice` (111), `incrementality` (107), `momentum` (87), `ngrams` (63) | 924 | **Analytics**, not Reporting — out of this series |

Nothing is deleted by this plan. H1.2 remains a separate gate.

### 1.5 Existing surfaces to reuse, not duplicate

- `/insights/amazon-reports` — a working "every Amazon feed, its source and freshness" hub built on `amazon-report-catalog.ts` + `amazon-report-registry.service.ts`. **The catalogue pattern for RPT.2 already exists; copy the shape, change the contents.**
- `/insights/builder` (578 lines) — a pivot builder. Prior art for a later RPT builder phase.
- `/insights/exports` (272 lines) — an export hub with scheduled email. Prior art for RPT.4/RPT.6.
- `/marketing/ads/bulk` — the bulksheet round trip (download → edit → upload → preview → apply → undo). **This is the import UX we already ship and should match.**

---

## 2. Market research

### 2.1 ⭐ The finding that sets the deadline

**Amazon Ads unified reporting went GA on 8 June 2026, and the Sponsored Ads reports page and the Amazon DSP reports page are being retired on 31 December 2026.**

| | |
|---|---|
| **Templates** | 12 pre-built: Advertised Product, Audience, Converted Product, Geography, Placement, Campaign, Live Events, Search Term, Reach and Frequency, … |
| **Scope in one report** | multiple manager/advertiser accounts × multiple ad products (Sponsored + DSP) × multiple countries × chosen metrics and dimensions |
| **History** | **15 months** daily/weekly · **6 years** monthly/yearly/summary |
| **Delivery** | Ads Console (GA), Marketing Stream (beta), **Reporting API (beta)** |
| **Migration** | an automated subscription-migration tool "soon"; Amazon's own advice is to rebuild on the unified schema and run both in parallel for two cycles |

Two consequences for us:

1. **Any saved report definition, BI job or spreadsheet built on the legacy schema needs a rewrite before 31 Dec 2026.** Our v3 ingest is not affected yet (the v3 *reporting API* is separate from the console pages being retired), but the unified Reporting API is in beta and will become the path forward.
2. **Our report vocabulary should mirror Amazon's unified dimensions and metrics**, so an operator reading our Reporting page and Amazon's see the same words for the same numbers. Free consistency, and it makes the eventual migration a mapping rather than a redesign.

### 2.2 ⭐ The file you attached is that unified export — and it is an asset

`~/Downloads/Campaign_-_07_29_2026T04_39_35.csv` — 17.6 MB, **91 columns, 20,687 rows**. Profiled in full:

| Property | Value |
|---|---|
| **Window covered** | **Apr 12 → Aug 02 2026** (~113 days) |
| **Ad product** | Sponsored Products (only) |
| **Account** | XAVIA (`amzn1.ads-account.g.d2i7ytta8b7qldk7k4yo2lu87`) |
| **Campaigns** | 74 · **Distinct search terms: 9,368** |
| **Marketplaces** | `AMAZON_IT` 12,992 · `AMAZON_DE` 3,903 · `AMAZON_ES` 2,059 · **`UAMAZON_FR`** 1,686 · blank 47 |
| **Placement classes** | Other on-Amazon 12,143 · Top of Search on-Amazon 4,998 · Detail Page on-Amazon 3,522 |
| **Match types** | `TARGETING_EXPRESSION_PREDEFINED` 9,179 (auto clauses) · PHRASE 5,845 · BROAD 3,413 · EXACT 1,623 · `TARGETING_EXPRESSION` 573 |
| **Totals** | **5,871,130 impressions · €12,629.12 spend · €55,856.03 sales · 633 purchases · 22.61% ACOS** |
| Columns populated | 42 of 91 |
| Columns always empty | 49 — all DSP (`Insertion order`, `Flight *`, `Deal *`), all geo (`Country`, `Region`, `DMA®`, `City`, `Postal code`), all device (`OS`, `Browser`, `Device type`, `Environment`), plus `Purchases (new to brand)`, `Long-term sales`, `Long-term ROAS`, `Viewable CTR` |

**Why this matters more than it looks:** the grain is **search term × target × ad × placement classification × marketplace**. The v3 API cannot produce that join. `spSearchTerm` gives search terms with no placement and no advertised product; `spCampaigns` + `campaignPlacement` gives placement with no search term. **This file contains a slice of truth our ingest structurally cannot reach**, over the exact period the account has been live.

**Six parsing traps in this file, all of which the importer must handle:**

1. **`Date range` is not a date.** 5,440 distinct values mixing single days (`Aug 02, 2026 - Aug 02, 2026`) and spans (`Jun 13, 2026 - Aug 02, 2026`). Each row is one dimension-combination aggregated over the window in which it had activity. **Rows cannot be summed across overlapping windows without double-counting**, and this is not a time series.
2. **IDs are Excel-escaped**: `="170516348103758"`. Naive parsing yields the literal string with `="` and `"`.
3. **Percentages are formatted strings**: `CTR` = `"12.5000%"`, not `0.125`. Same family as the ads-console "metrics are STRINGS" trap already in the memory index.
4. **`UAMAZON_FR`** — an Amazon-side marketplace label anomaly (leading `U`). Must be normalised to `FR`, not dropped as unknown.
5. **`Portfolio ID` = `-1`** is Amazon's sentinel for "no portfolio", not a real ID.
6. **BOM-prefixed header** (`﻿Date range`) — must read as `utf-8-sig`.

### 2.3 The tools you named

| Tool | What it is | What to take |
|---|---|---|
| **Openbridge** | Code-free pipelines: Amazon SP-API, Ads, Vendor, Attribution, Marketing Stream, **Search Query & Catalog Performance** → BigQuery/Redshift/Snowflake/Databricks/Athena, then dbt/Looker | **Reporting is a pipeline, not a page.** Named feeds, explicit destinations, backfill as a first-class operation. (Destinations themselves are OUT per D3.) |
| **Saras Daton** | 200+ connectors, ~5,000 APIs, 15-minute replication, **table-level CRON schedules**, append/upsert/truncate load modes | ⭐ **Data-delay alerts** and **job logs replicated as a queryable table**. Pipeline health is a product, not a debug page. |
| **DataHawk** | SKU-level Amazon/Walmart analytics; SOV specialists | ⭐ **Full data access without lock-in** — Snowflake, Power BI, Looker Studio, **Google Sheets**, API, MCP. Also: white-label reports, daily anomaly alerts. |
| **Nova (novadata.io)** | $29/mo; **200+ cost lines into a daily P&L**, 21 marketplaces, hourly refresh, BSR tracker, "Connect to Claude" | Cost-line completeness as the credibility claim. We already compute profit-native ACOS from real fees + COGS — **we should say so numerically**. |
| **Tableau** | The BI grammar | Saved definitions · parameters · **subscriptions** · **data-driven alerts** · extracts-vs-live · row-level security. The vocabulary, not the product. |
| **Pacvue** | Report Builder canvas: tables/charts/KPI cards, snap-to-grid, **version history**, scheduled refresh, PDF/share-link, DaaS | ⭐ **Version history on a saved report definition.** Nobody else in the study has it, and it is cheap for us. |
| **Intentwise** | Analytics-first; Foundation (Data Store/Pipelines/MCP) → Intelligence → Optimize | ⭐ **The three-layer separation as an organising principle** — exactly D2's Reporting-vs-Analytics split, arrived at independently. |
| **Amazon Data Kiosk** | SP-API GraphQL; `economics` = per-ASIN net proceeds | Already shipped (`data-kiosk.service.ts`, `AmazonEconomicsDaily`), **cron still gated off** on `NEXUS_ENABLE_DATA_KIOSK_CRON`. A Reporting phase should surface it. |

### 2.4 From the prior study (`~/Desktop/COMMERCE-PLATFORM-RESEARCH`)

- ⭐ **Tags as the default reporting dimension** — Pacvue's Campaign Tags, Rithum's Labels. The synthesis (§58, §164) already flagged a **general tag primitive** as a four-payoff build: reports, bulk actions, rules and policy all target the tag instead of re-deriving the set. **This is the highest-leverage idea in the whole study for Reporting**, and it is not built.
- **Stackline** — *"a data company that ships dashboards."* Its lesson: share-of-shelf/competitor data is **buyable, not buildable**. Reinforces the standing refusal to scrape.
- **Akeneo (bulk-operations study)** — ⭐ best-in-class import reporting: **diff before writing**, then report *"read 38, no differences 37, processed 1"* plus a downloadable error file naming **the offending value and field**. **This is the exact standard RPT.7's import preview must hit.**

### 2.5 What we refuse, and why — stated once

| Refusal | Reason |
|---|---|
| **Scraping for SOV / share of shelf** | Every vendor does it; Amazon's ToS prohibits it; the asset at risk is the selling account. Prior research landed on "approximate (option C), buy if insufficient (B), never scrape (A)". |
| **AMC and DSP reporting** | Probed live 2026-07-29: AMC has no instance provisioned, DSP has no advertiser. Blocked at Amazon, not in code. The 49 always-empty DSP columns in your export are the same fact from the other side. |
| **Warehouse / BI destinations** | Operator decision D3. Revisit only if a real warehouse exists to load. |
| **A generic BI tool** | We are not rebuilding Tableau. We are building a small number of exact, well-wired reports over data we own. |

---

## 3. The goal

> **Every number the ads console shows must be obtainable, exportable, scheduleable and explainable — with its source, its grain and its freshness attached — and any Amazon report the API cannot give must be importable without losing precision.**

Success is not "a page with charts". Success is:

1. An operator can find **any** ads figure without asking anyone.
2. They can get it **out** — exactly, with the columns they chose, in a file that describes itself.
3. They can have it **arrive** on a schedule without asking again.
4. They can bring in what Amazon only gives via the console, and know it landed correctly, **row by row**.
5. Every figure states **where it came from and how stale it is**, so a decision made on it is a decision made knowingly.

---

## 4. Approach and design system

### 4.1 Where this lives

`/marketing/ads` is a **standalone surface** (`AppShell.tsx:26` `STANDALONE_PREFIXES`): no Nexus chrome, its own rail, its own CSS language in `ads.css` (3,088 lines of `.h10-*`). Per D5, everything grows under the existing `Reporting` rail item as children, tabs, panels and drawers.

### 4.2 The composition rule

The ads console already blends both systems — **34 files under `/marketing/ads` import from `@/design-system`**. That is the established pattern, and this series follows it exactly:

| Layer | Use |
|---|---|
| **Page shell / chrome** | `h10-*` classes from `ads.css` — so Reporting looks like the console it lives in |
| **Anything interactive** | `@/design-system/components` — `DataGrid`, `DateRangePicker`, `MetricStrip`, `Tabs`, `Drawer`, `Modal`, `Menu`, `Combobox`, `MultiSelect`, `Pagination`, `Toast`, `EmptyState`, `PerformanceGraph`, `Heatmap` |
| **Tables** | The shared DataGrid stack (DataGrid + GridToolbar + FilterBar), all four DS stylesheets imported |

**Known traps that apply to this surface** (all already recorded, all must be honoured):
DataGrid `table-layout` trap · sticky-cell stacking (portal menus to `document.body`) · grid-card clipping the last dropdown option · Drawer-over-Modal z-order (use the `overlay=` slot) · ads frozen-column overlap (scope `position: static` per page) · the DS pre-push guard greps comments · `advertising.routes.ts` needs `grep -a` (the `€` char reads as binary) and a duplicate route crashes boot · ads metrics arrive as **strings or null**, and `Number(null) === 0`.

### 4.3 The four consistency guarantees

These are what "no inconsistencies, properly wired" means concretely. Each is a build constraint, not an aspiration.

1. **One metric registry.** A single canonical definition per metric — id, label, unit, formatter, derivation, null-policy — imported by the grid, the CSV writer, the XLSX writer, the email renderer and the Sheets sync. ACOS is computed once. It cannot mean 22.61% in one place and 0.2261 in another.
2. **One date-range semantic.** `ads-core/date-range.ts` already exists and already handles the `AT TIME ZONE 'UTC' AT TIME ZONE 'Rome'` rule. Every report uses it. No report invents its own window arithmetic.
3. **One provenance model.** Every row and every export carries `source` (v3 API · AMS · SQP · Data Kiosk · Brand Metrics · **console import**), `asOf`, and `coverage`. Imported data is never silently mixed with API data.
4. **Export equals what you see.** The export path runs the *same query object* the grid ran — same filters, same columns, same ordering — only without pagination. There is no second code path that can drift.

---

## 5. Phases

Ten phases. **Each is separately gated: nothing starts until you approve it, and nothing else starts until it is finished and verified on prod.** Sizes are relative, not promises.

| # | Phase | What ships | Size | Depends on |
|---|---|---|---|---|
| **RPT.0** | **Ground truth** | Read-only. Row counts, date coverage, per-marketplace and per-ad-product coverage for all 9 reporting tables + the 4 job tables. Output is one table telling us which reports have data and which would ship empty. **No code changes.** | S | — |
| **RPT.1** | **Nav + shell** | Port `AppRail`'s Link + separate-chevron pattern into `AdsSidebar` so `Reporting` (and `AMC`) navigate *and* expand. Replace the Reporting stub with a real landing page. No new rail entries. | S | — |
| **RPT.2** | **The report library** | A catalogue of every report we can produce: name, description, source, grain, dimensions, metrics, **freshness, row count, coverage window, provenance**. Modelled on the working `/insights/amazon-reports` + `amazon-report-catalog.ts` pattern. Every entry is runnable. | M | RPT.0, RPT.1 |
| **RPT.3** | **The runner + grid** | The core. Date range, marketplace, ad product, campaign/portfolio/tag filters; column chooser; sort; group-by; server-side pagination. Makes Campaign, Search Term, Targeting, Placement, Advertised Product, Brand Metrics and Economics real. DS DataGrid stack. | **L** | RPT.2 |
| **RPT.4** | **Export — CSV / XLSX** | Full result set (not the page), streamed. Chosen columns, deterministic formatting (numbers as numbers, ISO dates, explicit currency). **Self-describing manifest**: which query, which window, which source, how fresh. Runs the same query object as the grid. | M | RPT.3 |
| **RPT.5** | **Saved definitions** | Save a configured report by name. **Version history** (Pacvue's idea — cheap for us). Share link. The unit that scheduling and Sheets both consume. | M | RPT.4 |
| **RPT.6** | **Scheduled email delivery** | Recurring run of a saved definition → CSV/XLSX to an address, on a cron. **Delivery log**: what was sent, when, how many rows, and whether the data was fresh at send time. Reuses the existing notification infrastructure. | M | RPT.5 |
| **RPT.7** | **Import — Amazon console reports** | ⭐ Upload the unified-report CSV (yours), STIS/STIR, Search Query Performance. Schema detection → column mapping → **dry-run preview with per-row arithmetic** (*read N · unchanged N · new N · conflicting N*) → commit, with a downloadable error file naming the offending field and value (Akeneo standard). Handles all six traps in §2.2. Stored with `source='console-import'` so it is never confused with API data. | **L** | RPT.3, RPT.5 |
| **RPT.8** | **Google Sheets live connection** | A sheet bound to a saved definition, refreshed on schedule. Requires a Google OAuth connection. | M | RPT.6 |
| **RPT.9** | **Pipeline health** | Absorbs legacy `reports` (593 lines) + `feeds` (257). Per-feed last success, lag, rows, failures, manual re-run. **Data-delay alerts** into the existing Notification inbox (the Daton idea). | M | RPT.2 |

**Deferred, deliberately:** a free-form pivot builder (prior art exists at `/insights/builder`; revisit after RPT.5 proves what operators actually save) · the **tag primitive** from §2.4, which is the highest-leverage idea here but is a cross-cutting build that belongs to its own gate, not buried inside Reporting.

### 5.1 Two notes on ordering

- **RPT.7 (import) is placed after the grid on purpose.** Your file's grain — search term × target × ad × placement × marketplace, over variable lifetime windows — **does not fit any existing table.** `AmazonAdsSearchTerm` is daily and campaign-level. Import therefore needs its own storage, and importing into a surface that cannot display it would be work you could not check. If you want the data sooner, say so and I will pull RPT.7 forward — but it grows, because it then has to bring a minimal viewer with it.
- **RPT.0 is not optional.** Memory already records that AMS coverage is **per-campaign, not per-account** (schedules with 1–5 days of data where the account has 56), and that AMS ingest was RBAC-rejected at the door for a month. Building reports before measuring coverage is how a page ships that looks broken but is merely empty.

---

## 6. RPT.0 RESULTS — ground truth, measured 2026-08-04

Read-only, against prod. Harnesses: `apps/api/scripts/_rpt0-ground-truth.mts` and `_rpt0b-verify.mts` (local, uncommitted). Nothing was modified.

### 6.1 What each table actually holds

| Table | Rows | Window | Days | Lag | Verdict |
|---|---|---|---|---|---|
| `AmazonAdsDailyPerformance` | **25,812** | Mar 22 → Aug 02 | 134 | 1d | ✅ the spine |
| `CampaignMetric` (unified mirror) | 25,319 | Mar 22 → Aug 02 | 132 | 1d | ✅ AMAZON 25,153 · EBAY 166 |
| `AmazonAdsHourlyPerformance` (AMS) | 11,107 | May 21 → Aug 03 | 72 | 0d | ⚠️ IT only, in practice |
| `AmazonAdsSearchTerm` | 9,513 | May 20 → Aug 02 | 71 | 1d | ✅ but shallow history |
| `SearchQueryPerformance` | 9,232 | May 17 → Jul 19 | 10 wk | 15d | ✅ weekly by design |
| `AmazonAdsPlacementReport` | 3,205 | Apr 15 → Aug 02 | **43** | 1d | ⚠️ sparse + dirty |
| `AmazonEconomicsDaily` (Data Kiosk) | 1,127 | **Jul 19 → Jul 25 only** | 7 | 9d | ⚠️ one manual backfill |
| `AmazonAdsBrandBuildingMetric` | 73 | Jun 20 → Jul 18 | 5 wk | 16d | ✅ weekly by design |
| `EbayListingEconomics` | 44 | Jul 10 → Aug 03 | 5 | 1d | ❌ unusable (see 6.2-G) |

### 6.2 Seven findings

**A. ⚠️ IT — the primary market — is systematically the stalest.** Not a one-off:

| | DE | FR | ES | **IT** |
|---|---|---|---|---|
| Daily perf, last day | Aug 02 | Aug 02 | Jul 31 | **Jul 27** (−6d) |
| Search terms, last day | Aug 02 | Aug 02 | Aug 02 | **Jul 26** (−7d) |

IT is 52% of all daily rows (13,393 of 25,812). **Any report defaulting to "last 7 days" will show the biggest market as nearly empty.** This must be diagnosed before RPT.3 picks a default window, and the library must surface per-market freshness rather than one global "as of".

**B. ⚠️ The placement table's `marketplace` column is polluted.** 183 rows carry raw Amazon marketplace IDs instead of country codes — `A1PA6795UKMFR9` (121 rows), `APJ6JRA9NG5V4` (38), `A13V1IB3VIYZZH` (12), `A1RKKUPIHCS9HS` (12). All fall in Apr 15 – May 20, so the normalisation was fixed later and the old rows were never backfilled. Grouping by marketplace today yields **8 buckets for 4 markets**. Needs a read-time normaliser or a one-off backfill (additive, pre-approved).

**C. ✅ The 1,002 zero-row Sponsored Brands jobs are correct, not broken.** `sbCampaigns` (529 jobs) and `sbSearchTerm` (473 jobs) have ingested 0 rows — which looked like silent breakage. It isn't: **only 4 SB campaigns exist and all 4 are PAUSED** (3 IT, 1 DE). Sponsored Display: 15 campaigns, **all PAUSED**. The account is effectively **Sponsored Products only** — 82 ENABLED campaigns (70 IT, 8 DE, 2 FR, 2 ES). *Consequence for RPT.2: the library must distinguish "no data because nothing is running" from "no data because ingest is broken", or six reports will look failed when they are simply idle.*

**D. ❌ Target-level performance is not ingested at all — the industry's #1 report cannot be served.** `AmazonAdsDailyPerformance` contains only `CAMPAIGN` (3,608) and `PRODUCT_AD` (22,204). **No `AD_GROUP`, no `AD_TARGET` rows**, and the report-job breakdown has no `spTargeting` entry — we never request it. Meanwhile **5,204 AdTargets exist locally** (4,180 KEYWORD · 764 PRODUCT · 179 AUTO · 32 PRODUCT_CATEGORY · 28 PRODUCT_AUDIENCE · 14 AUDIENCE · 7 PRODUCT_CATEGORY_AUDIENCE). The `impressions`/`clicks`/`spendCents` columns on `AdTarget` are **lifetime counters from entity sync, not a time series** — they cannot answer "how did this keyword do last week".

Every market guide ranks the Targeting report *essential, weekly*. **This is a new-ingest scope item, not a UI item**, and it is the single biggest gap RPT.0 found.

**E. ❌ `AmazonReportRun.rowCount` is never populated.** 4,775 runs, **0 with a row count**, max is `null` — including 1,718 successful Brand Analytics SQP runs. The freshness surface can say a report *ran* but never *how much came back*, so "succeeded with zero rows" and "succeeded with 9,000 rows" are indistinguishable. A defect RPT.9 must fix at the source, not paper over.

**F. ❌ `s3_download_400` is still accruing, daily.** 724 total on `AmazonAdsExportJob` (memory recorded 670 on 2026-07-29 — **+54 in five days, ~11/day**), with failures on every single day through Aug 03. This is the known split-cron-stage bug: the signed URL is minted on completion and expires before a later cron stage downloads it. Not fixed. Belongs to RPT.9.

**G. ❌ eBay margin data is unusable.** All 44 `EbayListingEconomics` rows are `dataStatus = MISSING_COGS`, IT only. Contribution margin, break-even ad rate and break-even CPC are therefore all meaningless. Any eBay profitability report ships blank until COGS is loaded.

**Healthy, for the record:** the cron fleet is fully alive — `ads-report-poll` (2,010 runs/14d), `ads-report-ingest` (1,339), `ads-v1-export-poll` (4,020), `ebay-ads-report-poll` (6,700, 2 failures), `sqp-ingest`, `tos-is-ingest`, `ads-brand-metrics`, `ads-metrics-reconcile` all firing on schedule. All 4,263 `AmazonAdsReportJob` rows are COMPLETED. eBay: 201 tasks, 200 clean, 1 quota back-off.

### 6.3 What RPT.0 changes in the plan

| # | Change | Affects |
|---|---|---|
| 1 | **Add a Targeting-report ingest** (`spTargeting`, groupBy `targeting`) as its own gated item. Without it there is no keyword-level time series to report on. | new phase, before RPT.3 can claim a Targeting report |
| 2 | **Diagnose the IT lag before choosing a default window**, and show freshness **per market**, never one global figure. | RPT.2, RPT.3 |
| 3 | **Normalise `marketplace`** at read time (and consider a one-off backfill of the 183 placement rows). | RPT.3 |
| 4 | **The library must separate "idle" from "broken"** — six reports have no data because nothing is running, and that must read as a status, not a failure. | RPT.2 |
| 5 | **`rowCount` and `s3_download_400` are real defects**, not display problems. RPT.9 fixes causes. | RPT.9 |
| 6 | **Your imported CSV is worth more than first estimated.** It carries Apr 12 → May 19 search-term history that `AmazonAdsSearchTerm` (starts May 20) simply does not have — about **five extra weeks** — at a grain including placement and advertised product that the API cannot return. | RPT.7 |

---

## 7. What I am not proposing

- Deleting anything. The legacy tree stays until H1.2 is separately gated.
- Touching flat-file editors, FBA quantity, or any existing import path.
- Any write to Amazon. This series is read, present, export and import-to-our-own-tables only.
- Building AMC, DSP, warehouse destinations, or a scraper.
