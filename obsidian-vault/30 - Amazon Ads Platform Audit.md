# Amazon Ads Platform Audit

→ [[00 - Nexus Commerce MOC]] | [[20 - Advertising]] | [[31 - Amazon Ads Competitor Teardown]] | [[32 - Amazon Ads Import-Export & Sync Spec]]

Audit date: 2026-07-28. Read from the live repo, not the vault notes. Route counts, file sizes and code excerpts are from `apps/api` and `apps/web` as of this date.

---

## 0. Headline

The platform is far more built out than "needs working" suggests — **276 advertising endpoints, 132 services, 13 ads cron jobs, 30+ UI route groups**, with an outbox write path, a write gate, dead-lettering, a write-reconcile sweep, rollback, and Marketing Stream already wired. This is not a rebuild.

What it lacks is concentrated in three places, and they are the three you named:

1. **Import/export is a stub.** The exporter is ~40 lines producing a single unstyled sheet capped at 500 campaigns; the importer accepts JSON rather than a file, supports 4 of ~20 operations, and cannot change a keyword bid — the single most common bulk action in Amazon PPC.
2. **The real-time story stops halfway.** Marketing Stream is subscribed to performance datasets only. The `campaigns` / `adgroups` / `ads` / `targets` change datasets — the exact signal for "someone edited this in Seller Central" — are deliberately not subscribed. Without them there is no way to distinguish external change from write lag.
3. **Two generations of data model coexist.** `Campaign`/`AdGroup`/`AdTarget` and `AmazonAdsCampaignDetail`/`CampaignTarget`/`CampaignBudget`/`CampaignMetric` both exist, as do `BudgetPool*` and `CampaignBudget*` triplets. Inconsistency is structural, not accidental.

Plus one dated landmine: **from 2026-07-30 Amazon refresh tokens expire 365 days from consent.** Nothing in the codebase tracks token age. Left alone, every connection dies silently a year after it was authorised.

---

## 1. What is actually there

### 1.1 API surface

`apps/api/src/routes/advertising.routes.ts` — **410,995 bytes, 276 route registrations.** Second-largest route file in the repo after `fulfillment.routes.ts`.

Functional clusters, all real:

| Cluster | Representative endpoints |
|---|---|
| Core entities | `/campaigns`, `/ad-groups`, `/targets`, `/product-ads`, `/portfolios`, `/audiences` |
| Campaign creation | `/campaign-builder/launch`, `/campaign-builder/single/launch`, `/campaign-builder/sp-super-wizard/launch`, `/architect/preview`, `/architect/apply` |
| Budget | `/budget-manager`, `/budget-pools`, `/budget-schedules`, `/budget-manager/scenario/commit`, `/pacing/preview`, `/pacing/apply` |
| Bidding | `/bid-optimizer/preview`, `/bid-optimizer/apply`, `/bid-suggestions`, `/bid-history`, `/ad-targets/bulk-bid`, `/campaigns/:id/cpc-ceiling` |
| Rank | `/rank-plans`, `/rank-targets`, `/rank-templates`, `/rank-schedule-groups`, `/rank-controller/simulate`, `/rank-defend/run-now` |
| Automation | `/automation-rules`, `/rule-templates`, `/automation/autonomy`, `/automation/halt`, `/automation/resume`, `/autonomy/pause-all`, `/automation-health` |
| Autopilot | `/autopilot-plans`, `/autopilot-plans/:id/backtest`, `/autopilot-plans/:id/decisions/stream` |
| Harvest / negatives | `/harvest/preview`, `/harvest/apply`, `/negative-keywords/bulk`, `/reports/negative-keyword-candidates`, `/search-terms/promote` |
| Reporting | `/reports/create-cycle`, `/reports/create-search-terms-cycle`, `/reports/create-placements-cycle`, `/reports/poll`, `/reports/ingest-completed` |
| Exports API | `/v1/exports`, `/v1/export-cycle`, `/v1/exports/poll`, `/v1/exports/refresh-expired` |
| Marketing Stream | `/marketing-stream/status`, `/marketing-stream/subscriptions`, `/marketing-stream/ingest`, `/marketing-stream/debug-sample` |
| Consistency | `/reconcile`, `/reconcile/targets`, `/campaigns/reconcile`, `/campaigns/:id/pending-writes`, `/delivery-state`, `/mutations/:outboundQueueId`, `/queued-mutations/:queueId/cancel` |
| Write safety | `/connection/enable-writes`, `/connection/disable-writes`, `/connection/preview-writes`, `/connection/set-mode`, `/campaigns/:id/live-writes` |
| Analysis | `/incrementality`, `/share-of-voice`, `/momentum`, `/ngrams`, `/top-of-search`, `/campaigns/:id/self-competition`, `/campaigns/:id/keyword-conflicts`, `/profit/by-campaign`, `/profit/daily` |
| Product-centric | `/by-product`, `/by-product/campaigns`, `/by-product/variants`, `/by-product/family-dayparting`, `/by-product/bulk` |
| Rollback | `/actions/:executionId/rollback`, `/actions/:executionId/log` |

**Worth saying plainly:** `/incrementality`, `/self-competition`, `/keyword-conflicts`, `/by-product/*` and `/actions/:executionId/rollback` are capabilities that **no competitor in the teardown ships**. They exist here already.

### 1.2 Services — 132 files in `apps/api/src/services/advertising/`

Including `ads-mutation.service.ts` (732 lines), `ads-api-client.ts` (1,099), `ads-v1-sync.service.ts` (748), `ads-reconcile.service.ts` (228), `ads-write-reconcile.service.ts` (200), `ads-write-gate.ts` (222), `ads-bayesian-bidding.service.ts`, `ads-incrementality.service.ts`, `rank-controller.ts`, `rank-self-competition.ts`, `true-profit-rollup.service.ts`, `sqp.service.ts`, `keyword-conflicts.service.ts`.

### 1.3 Jobs and workers

13 ads cron jobs: `ads-sync`, `ads-sync-drain`, `ad-autopilot`, `ad-budget-enforce`, `ad-budget-schedule`, `ad-dayparting`, `ad-rank-defend`, `ads-tos-defense`, `ads-tos-is-ingest`, `advertising-rule-evaluator`, `budget-pool-rebalance`, `ams-sqs-poll`, `marketing-sync-drain`. One dedicated worker: `ads-sync.worker.ts`.

### 1.4 The write path — genuinely well designed

`ads-mutation.service.ts` implements, in order: write an `AdvertisingActionLog` row → enqueue an `OutboundSyncQueue` row with `syncType=AD_*` → add a BullMQ job keyed `ads-sync:${queueRowId}` with a **grace-period delay** → drain via `ads-sync.worker.ts` with retries and dead-lettering.

Around it:

- **`ads-write-gate.ts`** — every live write must pass env-live + production-connection + **per-campaign allowlist**. Sandbox-safe by default.
- **`ads-write-reconcile.service.ts`** — sweeps entities whose last live write failed (`lastSyncStatus='FAILED'`) and re-pushes the current local value with `forceResync`, while correctly **skipping permanent 4xx errors** so they don't loop forever. The self-superseding stamp design is right.
- **`ads-reconcile.service.ts`** — separate read/metric drift reconciliation.
- **`rollback.service.ts`** + `/actions/:executionId/rollback`.
- If BullMQ is unavailable the mutation still succeeds and the queue row sits `PENDING` for the drain job. Correct failure posture.

This is better than anything documented at Pacvue, Perpetua or Skai.

### 1.5 UI

30+ route groups under `apps/web/src/app/marketing/ads/`: `campaigns` (+`[id]`, `_grid`), four campaign builders (`quick`, `guided`, `single`, `sp-super-wizard`), `budget-manager`, `autopilot`, `rules-automation` (+`_rank`, `_schedule`, `builder`, `tabs`), `suggestions`, `recommendations`, `health`, `portfolios`, `reporting` (+`brand-metrics`), `analytics`, `amc` (+`audiences`), `ai-advertising`, `changelog`, `account-overview`, `account-settings`, `dashboard`, plus the eBay subtree.

Largest components: `CampaignsGrid.tsx` (109 KB), `RuleBuilder.tsx` (90 KB), `ControlPlane.tsx` (39 KB), `AdsDataGrid.tsx` (38 KB).

### 1.6 Note on the eBay work from the previous session

`ebay-ads.routes.ts` (86 KB) already exists, as do `EbayCampaign`, `EbayAd`, `EbayAdGroup`, `EbayKeyword`, `EbayNegativeKeyword`, `EbayAdsDailyPerformance`, `EbayAdsRule`, `EbayAdsProposal`, `EbayAdsReportTask` and a full `/marketing/ads/ebay` UI subtree with campaigns, automation, change-log, digest and products. **The EA-series spec should be re-read as a gap list against that, not as a greenfield build.** That is the same error being flagged here, and it applies to both platforms.

---

## 2. Import / export — the stub

### 2.1 The exporter

`GET /advertising/bulk/export`, `advertising.routes.ts:4054`. Roughly 40 lines. Findings:

| # | Finding | Severity |
|---|---|---|
| **E1** | `limit` is clamped to `min(500)` campaigns and targets to `take: 200` per ad group. **Silent truncation** — the user gets a file that looks complete and isn't. | **Critical** |
| **E2** | One worksheet, `Sponsored Products Campaigns`. **No Sponsored Brands, no Sponsored Display, no Portfolios tab.** | **Critical** |
| **E3** | Entity coverage is Campaign / Ad group / Keyword / Product targeting only. **Missing: Product Ad, Negative Keyword, Campaign Negative Keyword, Bidding Adjustment (placement modifiers), Negative Product Targeting.** | **Critical** |
| **E4** | `Targeting type` is inferred by **regex on the campaign name** — `isAuto = /\bauto\|close match\|loose match\|substitute\|complement/i`. A manual campaign named "Autumn Boots" exports as `auto`. Read the real field. | **High** |
| **E5** | 31 columns vs Amazon's ~48. No `ASIN`, no informational mirror columns, no performance metrics, `Portfolio ID` present but never populated. | High |
| **E6** | **Long numeric campaign/ad-group/keyword IDs written as raw values.** Excel coerces to scientific notation and float64 loses precision above 2^53. The exported file corrupts its own identity columns. | **Critical** |
| **E7** | No `_row_key`, no `_baseline` hash, no `_meta` sheet. **There is no round-trip identity**, so a re-upload cannot be safely joined or conflict-checked. | **Critical** |
| **E8** | No data validation dropdowns, no number formats, no freeze panes, no column widths, no header styling, no conditional formatting, no autofilter. | High |
| **E9** | No README, Dictionary or Lists sheet. | Medium |
| **E10** | `wb.xlsx.writeBuffer()` — the entire workbook is materialised in memory inside the request handler. No streaming, no async job, no progress, no S3. Will time out and OOM well before a real account's row count. | **Critical** |
| **E11** | No date-range selection, no performance columns, no filter-scoped export ("export what I'm looking at"). | Medium |
| **E12** | No locale handling. `it-IT` decimal comma and `;` list separator are unaddressed. | Medium |

### 2.2 The importer

`POST /advertising/bulk/apply`.

| # | Finding | Severity |
|---|---|---|
| **I1** | **Accepts `{ rows: [...] }` JSON, not a file.** There is no multipart upload, no XLSX parsing. The round trip is broken at the interface: the user must convert the spreadsheet to JSON themselves. | **Critical** |
| **I2** | **Keyword `Update` is not supported.** Only `Keyword Create`. Changing bids in bulk — the most common Amazon PPC operation there is — is impossible through this path. | **Critical** |
| **I3** | Supported operations are Campaign Update/Archive, Ad group Update/Archive, Keyword Create, Negative keyword Create. Everything else falls to `push('skipped', \`${entity} · ${op} not supported yet\`)`. That is 4 of ~20 entity×operation combinations. | **Critical** |
| **I4** | `const bidEur = Number.isFinite(bid) && bid > 0 ? bid : 0.5` — **an unparseable bid silently becomes €0.50.** With `it-IT` decimals (`1,25`), every bid in the file silently becomes €0.50. | **Critical** |
| **I5** | Match type parsing collapses anything unrecognised to `EXACT`: `mt.includes('PHRASE') ? 'PHRASE' : mt.includes('BROAD') ? 'BROAD' : 'EXACT'`. A typo silently creates the wrong match type — which on Amazon is immutable and requires archive-and-recreate to fix. | **High** |
| **I6** | **No validation pass.** Rows are validated as they are applied, inside the apply loop, so errors are discovered mid-flight and the file lands partially applied with no plan and no record of intent. | **Critical** |
| **I7** | **No dry-run / preview diff.** No "N will change, M will fail, spend delta €X". | **Critical** |
| **I8** | Synchronous `for` loop in the request handler. No BullMQ job, no progress, no resumability, no cancellation. 2,000-row cap is the symptom, not the design. | **Critical** |
| **I9** | **No idempotency.** Re-submitting the same file re-applies every row. Combined with I6, the natural recovery action after a partial failure is the one that double-applies. | **Critical** |
| **I10** | No annotated error workbook returned. Results come back as JSON, so the user cannot fix in place and re-upload. | High |
| **I11** | No conflict detection. A row edited in Seller Central since export is silently clobbered. | High |
| **I12** | Errors are counted but the response is not persisted — no import job record, no history, no audit link to `AdvertisingActionLog`. | High |

### 2.3 What this means

The export and import are two halves of a round trip that do not meet. The exporter emits columns the importer cannot consume; the importer expects a shape the exporter never produces. **Neither has ever been exercised end to end**, which is consistent with there being no bulk/import/export UI page under `/marketing/ads` at all — only `campaigns/_grid/bulkActions.tsx` for in-grid actions.

---

## 3. Real-time and consistency

### 3.1 Marketing Stream is half-subscribed

`ads-marketing-stream.service.ts:34` subscribes exactly `sp-traffic` and `sp-conversion`. Line 32 states the rest are *"intentionally NOT subscribed here yet (they need dedicated ingest)"*.

Amazon publishes **15 datasets**. The missing ones that matter:

| Dataset | Why it matters |
|---|---|
| **`campaigns`, `adgroups`, `ads`, `targets`** | **Near-real-time change events** on state / budget / bid / name. This is the only push signal that someone edited in Seller Central. Without it, drift is only ever found by polling. Went GA 2025-12-01, schema-aligned with the unified Campaign Management API. |
| **`budget-usage`** | Event-driven, fires on every **5% consumption increment**. Real-time budget exhaustion — currently derived from polling instead. |
| `sb-traffic`, `sb-conversion`, `sd-traffic`, `sd-conversion` | SB and SD have no stream coverage at all. |
| `sp-budget-recommendations`, `sponsored-ads-campaign-diagnostics-recommendations` | Free recommendation feed, unused. |

Also worth knowing, and worth putting in the UI: the `*-traffic` and `*-conversion` datasets are **hourly rollups delivered 1–3h late**, not real-time. Only `budget-usage` and the four change datasets are genuinely event-driven. Marketing the former as "real-time" would be inaccurate.

### 3.2 The outbox rides on the wrong model

Ad mutations are queued into **`OutboundSyncQueue`** — a model built for product and listing sync. Its fields are `productId`, `channelListingId`, `offerId`, `externalListingId`, `targetChannel`, `syncType` (string), `payload` (Json).

There is **no campaign, ad group or target foreign key**. Ad mutations are therefore identified only by an untyped `payload` blob and a `syncType` string. Consequences:

- Cannot cheaply answer "what writes are in flight for this campaign?" — `/campaigns/:id/pending-writes` has to reconstruct it from JSON.
- Cannot serialize writes per entity, so two concurrent mutations to one campaign can race. Amazon introduced **HTTP 423 `ConcurrentModificationException`** in June 2026 for exactly this, and the client does not handle 423.
- Cannot join queue state to the entity grid to render per-row pending/applied/failed badges.

### 3.3 No three-state model

The system tracks local value and pushes it. It does not separately model:

- **Intended** — what the operator or rule asked for
- **Observed** — what Amazon last told us it is
- **Reported** — what the reporting API attributes to it

Without that separation you cannot distinguish "our write hasn't propagated" from "someone changed it in Seller Central" from "the write failed silently". All three look identical: local ≠ remote.

### 3.4 No data-vintage model

Amazon's numbers move for a long time: clicks and cost settle in 48–72h, conversions settle up to 14 days, and revisions arrive **up to 60 days** after the click. An independent study of 14,991 campaigns found the top 5% of campaigns changed impressions by **≥36.67%** between day 1 and day 17, and 14-day sales rose **≥18.75%** for the top 5% after the initial report.

Nothing in the schema or UI marks a date as provisional, stabilising or final. Two exports of "the same week" will disagree and there is currently no way to explain why. This is the single most common complaint levelled at every competitor in the teardown — and the easiest one to beat.

### 3.5 API version and token exposure

`ads-api-client.ts` runs SP v3 (`vnd.spCampaign.v3` etc.), SB v4, SD v3, plus legacy `/v2/profiles` and `/v2/portfolios`.

| Issue | Detail |
|---|---|
| **Refresh-token expiry** | From **2026-07-30**, refresh tokens expire **365 days from consent**. No `tokenIssuedAt` / expiry tracking exists in `AmazonAdsConnection` or `amazon-ads-auth.routes.ts`. Every connection dies silently a year after authorisation. **Two days from this audit date.** |
| **Legacy v2** | `/v2/portfolios` and `/v2/profiles` — Amazon has been sunsetting v2. Account-management v2 endpoints deprecate 2026-07-20 with 299 warning headers now and **HTTP 404 from July 2027**. |
| **Unified API** | The `/adsApi/v1` Campaign Management API went **GA 2025-12-01** and collapses ~200 endpoints to 16. Amazon's position: *"Use v1 for new integrations."* Covers SP, SB and DSP — **not SD**. We are not on it. Not urgent, but every new surface built on v3 is future rework. |
| **No 423 handling** | `429` appears 3 times, `backoff` once. No `Retry-After` honouring, no jitter, no 423 handling, no separate retry budgets. Amazon publishes no fixed rate limits — they are dynamic, regional and queue-depth-driven, and **adding accounts does not increase throughput**. |

### 3.6 Model duplication

Two generations coexist in `schema.prisma`:

| Generation A | Generation B |
|---|---|
| `Campaign` (2619) | `AmazonAdsCampaignDetail` (13291) |
| `AdTarget` (2765) | `CampaignTarget` (13400) |
| `BudgetPool` (3330) | `CampaignBudget` (13436) |
| `BudgetPoolAllocation` (3365) | `CampaignBudgetAllocation` (13467) |
| `BudgetPoolRebalance` (3392) | `CampaignBudgetRebalance` (13490) |

Line numbers ~2600 vs ~13300 tell the story: two waves, ~10,700 lines apart, never reconciled. Any export, report or rule that reads the wrong one produces numbers that disagree with the other. **This is the most likely source of the inconsistencies you're seeing.** Establishing which is canonical is a prerequisite for trusting any export.

### 3.7 Test coverage

14 `*.vitest.test.ts` files against 132 services — about **11%**. The tested ones are the right ones (`ads-api-client`, `ads-write-reconcile`, `ads-reconcile`, `rank-controller`, `keyword-conflicts`, `ads-autopilot`, `ads-bayesian-bidding`, `ads-target-acos`, `ads-placement-math`, `ads-top-of-search`, `sqp`, `ad-dayparting`, `ad-rank-defend`, `ads-dayparting-refresh`), but the write path and reconciliation invariants are under-covered for a system that mutates live spend.

---

## 4. Ranked remediation list

**P0 — correctness and data integrity**

1. Token-expiry tracking and re-consent prompting (§3.5). Two days out.
2. Resolve the duplicate model generations; declare one canonical, migrate readers, delete the other (§3.6).
3. Fix E6 (ID coercion), E4 (regex targeting type), I4 (silent €0.50 bid), I5 (silent EXACT fallback) — four silent-corruption bugs.
4. Remove silent truncation (E1) or make it loud.

**P1 — the round trip**

5. Rebuild the exporter: all entity types, SP+SB+SD sheets, `_row_key`/`_baseline`/`_meta`, streamed, async job, full formatting and dropdowns (§2.1, and [[32 - Amazon Ads Import-Export & Sync Spec]] §2).
6. Rebuild the importer: multipart upload, streaming parse, two-pass validate-then-apply, dry-run diff, durable BullMQ job, per-row idempotency, annotated error workbook (§2.2, spec §3).
7. Ship the bulk UI page that neither currently has.

**P2 — zero drift**

8. Subscribe the `campaigns`/`adgroups`/`ads`/`targets` change datasets and `budget-usage`; build the ingest they were waiting for (§3.1).
9. Introduce the intended/observed/reported three-state model and a typed ad-mutation queue (§3.2, §3.3).
10. Add the data-vintage model and surface it (§3.4).
11. Handle 423, honour `Retry-After`, add jitter, serialize writes per entity ID.

**P3 — hardening**

12. Raise write-path and reconciliation test coverage; add invariant tests that assert convergence.
13. Plan the `/adsApi/v1` migration for SP and SB; keep SD on v3.
14. Retire `/v2/portfolios` and `/v2/profiles` before the July 2027 404.

---

## Related Notes

- [[31 - Amazon Ads Competitor Teardown]] — what the market does and doesn't do
- [[32 - Amazon Ads Import-Export & Sync Spec]] — the build
- [[20 - Advertising]] · [[24 - Bulk Operations & Automation]] · [[05 - Database Schema]] · [[06 - Background Jobs & Workers]]
