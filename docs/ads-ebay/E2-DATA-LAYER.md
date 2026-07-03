# E2 — eBay Ads Data Layer & Sync

> eBay Ads workstream, Phase E2. Read side only (campaign/ad WRITES are E4). Every eBay call is read-only or a report task (the read mechanism).

## Pre-flight verified (2026-07-03, after operator re-consent)

- `GET /sell/marketing/v1/ad_campaign` → **HTTP 200** on the new connection.
- **11 existing Seller Hub campaigns discovered** (all EBAY_IT, created Jun–Oct 2024): 5 CPS **RUNNING** (Back Protector, Gale Jacket standard, Xavia Ventra Standard, Xavia Slider Standard, Regal jacket Standard), 4 CPC PAUSED (Xavia Gale manual €5/d, Ventra Automatic SMART €10/d, Ventra Advanced manual €30/d, Sliders Advanced manual €10/d), 1 Offsite ENDED ("Jacket Shopping Ad Google"). The seller has live CPS spend running under any-click **today** — the backfill lands on real money.

## Schema (migration `20260703_e2_ebay_ads_data_layer` — additive only, zero DROPs)

- **`EbayCampaign` extended** (11 columns): `fundingModel` (modern vocabulary; legacy `fundingStrategy` dual-written), `campaignTargetingType`, `channels[]`, `adRateStrategy`, `dynamicAdRatePrefs`, `campaignCriterion`, `isRulesBased`, `nexusManaged`, `budgetUpdatesToday/Day` (15/day quota ledger), `lastEntitySyncAt` + backfill `UPDATE` mapping STANDARD→COST_PER_SALE / ADVANCED→COST_PER_CLICK.
- **New tables (14)**: `EbayAdGroup`, `EbayAd` (**rate-at-ad-level truth**; unique (campaignId, listingId)), `EbayKeyword`, `EbayNegativeKeyword`, `EbayAdsReportTask`, `EbayAdsDailyPerformance` (unique (marketplace, fundingModel, entityType, entityId, date); unmapped TSV columns preserved in `extra`), `EbayListingIndex` (ads-side listing truth), `EbayListingEconomics` (margin read model), plus the E5-ready automation schema: `MarketingAutomationState`, `MarketingSpendCeiling`, `EbayAdsRule`, `EbayAdsRuleExecution`, `EbayAdsProposal`, `EbayAdsDigest`.
- **Rollback**: `DROP TABLE` the 14 new tables + `ALTER TABLE "EbayCampaign" DROP COLUMN` the 11 new columns (exact statements in the gate summary; nothing else touched).

## Services (`apps/api/src/services/`)

| File | Role |
|---|---|
| `marketing/ebay-ads-api.service.ts` | Typed Marketing API client (reads + report tasks). Every call reserves from the ads-core **QuotaLedger** (reports 180/hr headroom under the 200 cap, 9k/day under the 10k app cap); 429 Retry-After ladder; reads fail-open on Redis outage, report creation fails closed |
| `marketing/ebay-ads-entity-sync.service.ts` | campaigns → ads (CPS/SMART) / ad groups + keywords + negatives (CPC manual) with **fetch-success gating**, **mass-stale circuit breaker** (>50% skip), soft `STALE` flips only, legacy `fundingStrategy` dual-write, `nexusManaged` never clobbered |
| `marketing/ebay-listing-index.service.ts` | Trading `GetMyeBaySelling` discovery → `EbayListingIndex`; `GetItem` detail (site/category/SKUs/aspects) for new items (cap `NEXUS_EBAY_DISCOVERY_DETAIL_MAX`=50/run); SKU→product matching; end-flips (>40% breaker) cascade to `SharedListingMembership.status='ENDED'` + `EbayAd.status='STALE'`; **`getLiveEbayItemIds()`** — the product-first resolver (INDEX ∪ SHARED_MEMBERSHIP ∪ CHANNEL_LISTING) |
| `marketing/ebay-ads-reports.service.ts` | create→poll→download→parse→ingest per the ads-core `ReportTaskDriver` contract; one funding model per task; CPS enumerates campaignIds, CPC account-wide; `ad_report_metadata` intersected with desired metrics; TSV parser **fails loud on unrecognized schema**; facts upserted absolute (rerun-safe); campaign-grain facts + the `CampaignMetric` rollup (`attributionModel: 'ebay-any-click'`) are **derived from listing rows' campaign lineage**; first run backfills `NEXUS_EBAY_ADS_BACKFILL_DAYS` (default 28), thereafter trailing 4d (72h Reconciliation Period) |

### Live-API rules the pipeline encodes (learned against production, 2026-07-03)

1. `reportFormat: 'TSV_GZIP'` is required on createReportTask (error 35118).
2. **Max 7-day window per task** (error 35090) → the scheduler chunks.
3. Dimension minimums vary by grain AND funding model (error 35119): LISTING CPS = `campaign_id,listing_id`; LISTING CPC = `+ad_group_id`; KEYWORD = `campaign_id,ad_group_id,seller_keyword_id,keyword_match_type` (`seller_keyword_id`, not `keyword_id`).
4. LISTING/CAMPAIGN reports reject the `day` dimension despite metadata listing it → those run as **single-day tasks** and the parser stamps the window date (`fallbackDate`).
5. There is no usable standalone campaign report (its minimum dims force listing lineage) → **no CAMPAIGN task type; campaign facts are derived** by aggregating listing rows per `extra.campaign_id`.
6. `reportHref` comes back as `http://` — Node fetch drops Authorization on the 301 to https ("Missing access token") → scheme normalized before download.
7. Money cells are **locale-formatted with currency prefix** (`EUR 1.234,56` on the IT site) — `moneyToCents` handles comma-decimal and dot-decimal; regression-tested (a naive parse inflates 100×; caught against live data and re-ingested).
8. Negative keywords list only with `campaign_ids` **and** `ad_group_ids` (error 36329).
9. Empty (header-only) reports are legitimate — the 4 CPC campaigns are paused since 2024 and produce zero rows; the pipeline ingests them as 0-row INGESTED, never errors.
10. Zero-row or FAILED tasks can be re-run by deleting them (scheduler recreates) or flipping INGESTED→SUCCESS (re-download + re-ingest in place, absolute upserts) — both supervised ops, used during bring-up.
| `ads-core/ebay-margin.ts` | `computeEconomics` (break-even ad rate = margin ÷ ad-fee base; loss ⇒ 0%, never negative), `computeBreakEvenCpcCents` (margin × CVR, ≥50 clicks), fee estimator (labeled `CATEGORY_ESTIMATE`, env-tunable `NEXUS_EBAY_FVF_PCT`/`NEXUS_EBAY_FEE_FIXED_CENTS`); `MISSING_COGS` ⇒ "manual only" |

## Crons (`jobs/ebay-ads-sync.job.ts` + `cron-registry.ts`)

| Cron | Default | Manual trigger |
|---|---|---|
| `ebay-ads-entity-sync` | hourly :10 | `POST /api/sync-logs/cron/ebay-ads-entity-sync/trigger` |
| `ebay-listing-discovery` | every 4h :25 | …`/ebay-listing-discovery/trigger` |
| `ebay-ads-report-schedule` | daily 02:40 UTC | …`/ebay-ads-report-schedule/trigger` |
| `ebay-ads-report-poll` | every 3 min | …`/ebay-ads-report-poll/trigger` |
| `ebay-ads-economics-rebuild` | daily 05:15 UTC | …`/ebay-ads-economics-rebuild/trigger` |

Gate: **production default-ON** (ship-live), elsewhere OFF; `NEXUS_ENABLE_EBAY_ADS_SYNC=1/0` overrides. All runs land in `CronRun` (visible in `/sync-logs`).

## Tests

`ebay-ads-reports.vitest.test.ts` (TSV parser incl. cpc_* aliases, extra-column preservation, fail-loud nulls; circuit breakers; Trading `GetItem` XML parsing) + `ebay-margin.vitest.test.ts` (economics formulas, loss floor, missing-data statuses, break-even CPC). Suite total after E2: **90 tests green**; `tsc --noEmit` clean.

## Verification (after migration + first syncs)

1. `node scripts/_e2-verify.mjs` (row counts per table + freshness stamps + sample break-evens).
2. `/sync-logs` → cron panel shows the five `ebay-ads-*` jobs with SUCCESS runs.
3. `POST /api/marketing/os/sync/ebay` still works (legacy header mirror) — the E2 sync coexists; `/marketing/campaigns` eBay lens fills after backfill.
