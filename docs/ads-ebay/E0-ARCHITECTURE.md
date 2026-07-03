# E0 — eBay Ads Console Architecture Proposal

> eBay Ads workstream, Phase E0 deliverable 5 of 5. Proposal only — no code changed. Implementation begins in E1 **after gate approval**.
> All capability claims in this document have been reconciled against `E0-EBAY-CAPABILITY-MATRIX.md` (verified 2026-07-03, Marketing API v1.23.2); items say "VERIFIED" where the matrix confirmed or corrected them.

## 0. Governing decisions (from the E0 audits)

1. **Adopt the existing UM/Marketing-OS seam as the shared Ads Core** (`MarketingCampaign` + `MarketingCampaignLink` + `CampaignMetric` + `CampaignAction` + `CampaignBudget` + `ChannelAdapter` registry). No new abstraction is invented; the eBay adapter already exists read-only and is completed in E2/E4. The Amazon Trading Desk keeps its legacy hot path untouched until its own (separate) cutover — zero regression by construction.
2. **eBay-native truth lives in eBay-specific tables** (rate-at-ad-level, ad groups/keywords for CPC, report tasks, daily facts), mirrored up into the neutral spine for cross-channel analytics — exactly how Amazon's `AmazonAds*` tables relate to `CampaignMetric` today.
3. **Product-first is a resolver + index problem** (see `E0-PRODUCT-LISTING-MAP.md` §6): `EbayListingIndex` + `getLiveEbayItemIds()` are E2 prerequisites for every promote flow.
4. **Writes copy the proven "gated-local" pattern** (`docs/ADS_SYNC_MIRROR.md`): local write instantly → `OutboundSyncQueue` (+grace window) → BullMQ `ads-sync` worker (+Redis-free drain cron) → write-gate (`NEXUS_MARKETING_WRITES_EBAY` + € caps) → eBay API → `CampaignAction` audit with before/after + rollback.
5. **Automation composes existing machinery** — autonomy dial + circuit breaker (`AdsAutomationState` pattern), propose-then-apply (`AdsRuleSuggestion` pattern), approval queue (`BulkAutomationApproval`), per-decision rollback (`AutopilotDecision`), anomaly z-scores (`insights-anomalies`), in-app alerts (`notifyAutomation`), Resend digests + `EmailSuppression`.
6. **Hard EBAY_ES branch**: Priority (manual + smart) is not available in Spain — the console hides/disables Priority for ES everywhere (builder, rules, digest); ES = General + Offsite only.
7. **Suggested-rate strategy per market**: no CPS suggested-rate API exists for IT/FR/ES — the bounded "follow eBay" option is `adRateStrategy: DYNAMIC` with our margin-derived `adRateCapPercent`; the Recommendation API (`sell.inventory` scope, trending `bidPercentage`) is used for DE only. SMART Priority constraints honored: ≤3,000 listings, no ad groups, no post-launch SMART↔MANUAL switch.
8. **External-change drift detection is a requirement, not nice-to-have**: eBay's June-2026 "easy boost" mobile flow silently overwrites General ad rates on ALL promoted listings — the entity sync diffs eBay state vs Nexus intent every hour and alerts on unexplained changes (same posture as the Amazon mirror's deletion-reflection guards).

## 1. Prisma schema (E2 migration set — all reversible)

### 1.1 Extend existing `EbayCampaign` (keep the 10 live references working)

```prisma
model EbayCampaign {
  // …existing fields stay (id, channelConnectionId, marketplace,
  // externalCampaignId, name, status, startDate, endDate, aggregates)…

  // MODERNIZED (migration maps STANDARD→COST_PER_SALE, ADVANCED→COST_PER_CLICK)
  fundingModel        String   // 'COST_PER_SALE' | 'COST_PER_CLICK'
  campaignTargetingType String? // CPC only: 'MANUAL' | 'SMART'
  channels            String[] @default(["ON_SITE"]) // ['ON_SITE'] | ['OFF_SITE']
  adRateStrategy      String?  // CPS: 'FIXED' | 'DYNAMIC'
  // VERIFIED fields: adRateAdjustmentPercent (± vs eBay suggested rate) +
  // adRateCapPercent (hard cap) — our margin engine sets the cap.
  dynamicAdRatePrefs  Json?
  // rules-based CPS: selectionRules + autoSelectFutureInventory (adds AND
  // removes daily). Rules are IMMUTABLE post-create ⇒ clone-or-recreate flow.
  // criterionType: OMIT for Trading-created listings (ours), INVENTORY_PARTITION
  // only for Inventory-API sellers.
  campaignCriterion   Json?
  dailyBudget         Decimal? @db.Decimal(10,2) // CPC
  budgetCurrency      String?
  // Ops
  budgetUpdatesToday  Int      @default(0)      // VERIFIED hard quota: 15/day/campaign
  budgetUpdatesDay    DateTime?
  lastEntitySyncAt    DateTime?
  isRulesBased        Boolean  @default(false)
  nexusManaged        Boolean  @default(false)  // created by Nexus vs discovered
}
```

`fundingStrategy` (legacy column) is kept for one release, dual-written, then dropped — same playbook as the `ChannelConnection` legacy-column migration.

### 1.2 New eBay entity tables

```prisma
// Rate-at-AD-level truth (the campaign "rate" is just what rule-created ads inherit)
model EbayAd {
  id            String  @id @default(cuid())
  campaignId    String  // FK → EbayCampaign
  marketplace   String
  listingId     String  // eBay ItemID — the universal attach key
  inventoryReference String? // SKU / INVENTORY_ITEM_GROUP when applicable
  externalAdId  String?
  adGroupId     String? // CPC only, FK → EbayAdGroup
  bidPercentage Decimal? @db.Decimal(6,2) // CPS ad rate — THE authoritative rate
  status        String   // eBay adStatus + our STALE marker for dead listingIds
  createdVia    String   // 'RULE' | 'KEY_BULK' | 'CONSOLE' | 'AUTOMATION' | 'DISCOVERED'
  hiddenReason  String?  // e.g. OUT_OF_STOCK (surfaced, not an error)
  productId     String?  // resolved Nexus product (nullable until matched)
  @@unique([campaignId, listingId])
  @@index([listingId]) @@index([productId]) @@index([marketplace, status])
}

model EbayAdGroup   { id/campaignId/externalAdGroupId/name/status/defaultBid Decimal? }
model EbayKeyword   { id/adGroupId/externalKeywordId/text/matchType/bid Decimal?/status
                      @@unique([adGroupId, externalKeywordId]) }
model EbayNegativeKeyword { id/campaignId/adGroupId?/externalId/text/matchType('EXACT'|'PHRASE' — VERIFIED; broad unsupported)/status }

// Async report pipeline state (mirror of AmazonAdsReportJob shape)
model EbayAdsReportTask {
  id/reportType/fundingModel/marketplace(s)/dateFrom/dateTo/dimensions Json/metrics Json
  externalTaskId String? @unique
  status String  // PENDING|IN_PROGRESS|SUCCESS|FAILED|EXPIRED|INGESTED
  reportHref String? / attempts Int / lastPolledAt / downloadedAt / ingestedAt / failureReason
  @@index([status, lastPolledAt])
}

// Daily facts (mirror of AmazonAdsDailyPerformance keying; absolute values ⇒ rerun-safe upserts)
model EbayAdsDailyPerformance {
  id String @id @default(cuid())
  marketplace String / fundingModel String
  entityType  String  // ACCOUNT | CAMPAIGN | LISTING | KEYWORD
  entityId    String  // campaignId / listingId / keywordId (external)
  date        DateTime @db.Date
  impressions Int / clicks Int / ctr Decimal? / avgCpcCents Int?
  adFeesCents Int / salesCents Int / soldQty Int
  currency    String
  reportTaskId String? / reportedAt DateTime?   // freshness stamps
  @@unique([marketplace, fundingModel, entityType, entityId, date])
  @@index([entityType, entityId, date]) @@index([date])
}

// Ads-side listing source of truth (see E0-PRODUCT-LISTING-MAP §6)
model EbayListingIndex {
  id/marketplace/itemId @@unique([marketplace, itemId])
  title/categoryId/price Decimal/currency/quantity Int/format
  variationSkus String[] / aspects Json?
  source String  // CHANNEL_LISTING | SHARED_MEMBERSHIP | DISCOVERED
  productIds String[] // resolved Nexus products (may be several variants)
  matchStatus String  // MATCHED | UNMATCHED | CONFIRMED | IGNORED
  firstSeenAt/lastSeenAt/endedAt DateTime?
  relistedFromItemId String?  // relist chain
}
```

### 1.3 Automation + safety (channel-scoped, Amazon tables untouched)

```prisma
model MarketingAutomationState { // clone of AdsAutomationState, channel-scoped
  channel String @unique  // 'EBAY' row created in E5
  globalMode String @default("OFF") // OFF | SUGGEST(=PROPOSE) | AUTO(=AUTOPILOT)
  halted Boolean / haltReason / haltedBy / maxHourlySpendCentsEur / maxActionsPerHour
}
model MarketingSpendCeiling { channel/marketplace/monthlyCapCents/currency
                              @@unique([channel, marketplace]) }
model EbayAdsRule {
  id/name/enabled/mode('PROPOSE'|'AUTOPILOT')/marketplace?/scope Json  // campaign/product filters
  trigger Json     // {metric, window:{days}, operator, threshold} conditions (AND set)
  action  Json     // {type: adjust_ad_rate|adjust_bid|pause_ad|resume_ad|add_negative|move_listing|alert, params, caps}
  guardrails Json  // margin floor, min/max rate, cooldownHours
  lastEvaluatedAt/cooldownUntil
}
model EbayAdsRuleExecution { ruleId/status/evaluated/matched/proposed/applied/summary Json/createdAt }
// Proposals reuse the AdsRuleSuggestion PATTERN but channel-clean:
model EbayAdsProposal {
  id/ruleId?/kind/entityRef Json/proposedAction Json/reasoning Json  // inputs + rule + math
  proposedKey String @unique   // dedupe: one pending proposal per (entity, change-kind)
  status String  // PENDING | APPROVED | REJECTED | APPLIED | ROLLED_BACK | EXPIRED
  estimatedImpact Json? / decidedBy/decidedAt/appliedResult Json?/expiresAt
}
model EbayAdsDigest { weekStart DateTime @unique / payload Json / generatedAt / reviewedAt? }
```

Writes audit into the existing **`CampaignAction`** (channel-neutral before/after + rollback) — no new audit table.

### 1.4 Profitability join (materialized read model, rebuilt nightly + on cost change)

```prisma
model EbayListingEconomics {
  marketplace/itemId @@unique([marketplace, itemId])
  productId?
  priceCents/currency
  cogsCents?           // from cost master; NULL ⇒ "manual only" flag
  ebayFeesCents        // actual FVF from Finances-API history where available, else category schedule
  shippingCostCents?
  contributionMarginCents/contributionMarginPct
  breakEvenAdRatePct   // CPS: margin ÷ ad-fee base (VERIFIED base = total sale
                       // amount incl. item price + shipping + taxes + fees)
  breakEvenCpcCents?   // CPC: margin × trailing CVR (null until enough clicks)
  computedAt
}
```

## 2. Sync & job topology (Railway + Upstash)

All crons: `recordCronRun`-wrapped, `dbNow()` clock, master gate `NEXUS_ENABLE_EBAY_ADS_CRON` + per-cron env overrides, registered in `cron-registry.ts` (manual trigger via `/api/sync-logs/cron/<name>/trigger`).

| Cron | Cadence (default) | Job |
|---|---|---|
| `ebay-ads-entity-sync` | hourly | campaigns → ads (per campaign, paginated) → ad groups/keywords (CPC). Reconciliation guards copied from ADS_SYNC_MIRROR: fetch-success gating, mass-archive circuit breaker, gated-local exemption, soft-archive only |
| `ebay-listing-discovery` | every 4h + on `ebay_push.status_changed` SSE | Trading `GetMyeBaySelling` per site → `EbayListingIndex` upsert; flips `SharedListingMembership.status=ENDED`; relist chain detection; marks `EbayAd.status=STALE` for dead itemIds |
| `ebay-ads-report-scheduler` | daily 03:30 Europe/Rome | creates report tasks per (marketplace × fundingModel × grain): yesterday + **trailing-72h re-pull** (VERIFIED: eBay's official "Reconciliation Period" for sales/ad-fee figures) + weekly 30-day true-up. Never mixes funding models in one task (VERIFIED: multi-model deprecated); **CPS tasks must enumerate campaignIds (≤1,000); CPC tasks may run account-wide** |
| `ebay-ads-report-poller` | every 3 min | fair-ordered poll (`lastPolledAt asc`), download `.tsv.gz`, gunzip, parse, idempotent upsert into `EbayAdsDailyPerformance`, roll up `CampaignMetric` (`costEurCents` FX-frozen) |
| `ebay-ads-automation-evaluator` | daily 07:00 Rome (after facts) | rule evaluation → proposals / autopilot-within-guardrails |
| `ebay-ads-anomaly-guard` | hourly | fee spike / CTR collapse / campaign unexpectedly ended / ceiling breach → `notifyAutomation` + optional halt |
| `ebay-ads-digest` | weekly Mon 06:30 Rome | digest build + in-app notification (email channel pluggable later) |

**Quota budgeting (new, distributed):** the current `utils/rate-limiter.ts` token bucket is in-process; E2 adds a small **Redis-backed limiter** (atomic INCR+TTL windows) with named budgets: `ebay:marketing:daily` (VERIFIED app-level: Marketing **Ads 10,000/day**, Promotion 100,000/day — defaults, raisable via Application Growth Check), `ebay:marketing:reports` (VERIFIED **200/hr per seller**, then blocked 1h), `ebay:marketing:budgetUpdate:<campaignId>` (VERIFIED **15/day**, also persisted on `EbayCampaign` for UI display). Every sync/automation caller reserves before calling; exhaustion ⇒ deferred with visible freshness state, never silent.

**Write path:** new `OutboundSyncQueue.syncType` values `EBAY_AD_*` (`CREATE_BULK`, `BID_UPDATE_BULK`, `REMOVE`, `CAMPAIGN_STATE`, `CAMPAIGN_CREATE`, `KEYWORD_*`, `NEGATIVE_*`, `BUDGET_UPDATE`) consumed by an extended `ads-sync.worker.ts` switch + `drain-ads-sync` fallback; chunked bulk calls (VERIFIED: **500 listings/call**, 50,000 ads/campaign, each variation counts as an ad) with per-item results persisted; idempotency via `proposedKey`/jobId dedup; 429 handling via `channel-batch/rate-limit.ts` ladder. Rate changes use **`updateAdRateStrategy`** (rules-based CPS, exists since v1.12.0) and `updateBid`/bulk bid updates (key-based) — never end-and-recreate; clone-or-recreate is reserved for selection-rule changes only (rules are immutable).

## 3. Report pipeline (generalizing the pattern, not the Amazon code)

`create → poll → download → parse → upsert`, copied shape-for-shape from `AmazonAdsReportJob` (create idempotency on `{reportType, marketplace, dates, status∈(PENDING,IN_PROGRESS)}`; attempts + fair polling; absolute-value upserts on natural keys ⇒ rerun-safe; `reportTaskId`+`reportedAt` freshness stamps on every fact row; retention cleanup). eBay specifics: `TSV_GZIP` only (1M-row cap), `ad_report_metadata(/{type})` fetched + cached to validate dimensions/metrics before task creation. VERIFIED type list (9): ACCOUNT_PERFORMANCE_REPORT, ALL_CAMPAIGN_PERFORMANCE_SUMMARY_REPORT (CPC-only), CAMPAIGN_PERFORMANCE_REPORT, CAMPAIGN_PERFORMANCE_SUMMARY_REPORT, LISTING_PERFORMANCE_REPORT, KEYWORD_PERFORMANCE_REPORT (CPC-only), **SEARCH_QUERY_PERFORMANCE_REPORT (CPC-only — feeds keyword harvesting)**, TRANSACTION_REPORT (per-model; CPC variant carries `sale_type` — feeds the fee-to-order audit), INVENTORY_PERFORMANCE_REPORT (in enum, not currently available). Per-funding-model task separation and the trailing-72h re-pull window are first-class scheduler behavior. v1.22.4 multi-currency metric keys (`*_listingsite_currency`) are ingested for IT/DE/FR/ES currency correctness. Fixtures for every report type; parser pinned to observed column headers with fail-loud on schema drift (lesson: the Amazon v2-`location`/v3-`url` silent-poll bug).

## 4. Margin engine (the differentiator)

Definitions (single source of truth in one pure, unit-tested module `ebay-ads-margin-math.ts`):

- `adFeeBase` = what eBay charges the ad-rate % against (item price + shipping + tax ⚠️VERIFY exact composition per capability matrix §1).
- `contributionMargin` = price + shipping revenue − COGS − actual eBay fees (Finances-API history per listing where available; category fee schedule fallback, labeled) − shipping cost − VAT effect where applicable.
- **CPS break-even ad rate** = contributionMargin ÷ adFeeBase (as %). Displayed on every rate surface; automations clamp `rate ≤ breakEven × safetyFactor` (default 0.8, configurable per rule).
- **CPC break-even max CPC** = contributionMargin × trailing conversion rate (from listing-level report facts; null until statistically meaningful — then "manual only").
- **Any-click reality (already live on ALL our markets — DE since Feb 2025, IT/FR/ES since June 2025; Jan 13 2026 was the US/CA wave)**: attribution is any-click→any-buyer-30d with the fee at the **rate in effect at sale**, so effective fee incidence on multi-quantity listings exceeds naive rate math and **rate increases act retroactively on already-clicked inventory** ("click debt" — surfaced before every rate raise). The digest reports **actual adFees ÷ attributed sales** (eBay ACOS) and **actual adFees ÷ total sales** (TACOS) per product, and the margin panel shows realized-vs-nominal rate.
- Missing COGS ⇒ listing flagged `manual only`: excluded from all automations, badge in UI.

## 5. Automation & weekly agent (E5)

- **Rules** (`EbayAdsRule`): conditions over `EbayAdsDailyPerformance` windows (e.g. `adFeePctOfSales > X over 14d`, `clicks > N && soldQty = 0 over 30d`, `suggestedRate − currentRate > Y`), actions from §1.3, ALL clamped by: margin guardrail → per-marketplace ceiling (`MarketingSpendCeiling`) → quota budget → global `MarketingAutomationState(channel='EBAY')` dial + circuit breaker.
- **Ceiling math must model eBay's pacing**: CPC budgets pace **monthly at 30.4× daily with single days up to 2× daily**, and **General has no native cap at all** — so our ceiling monitor projects General fee run-rate (trailing attributed fees) + CPC actuals against the monthly cap and auto-pauses on breach; it never assumes "daily budget × days".
- **Modes**: `PROPOSE` (default; queue `EbayAdsProposal` with full reasoning: inputs, rule, math) and `AUTOPILOT` (apply within guardrails, log `CampaignAction`, include in digest). Every applied change carries `payloadBefore` ⇒ one-click rollback.
- **Catch-all enrollment**: one rules-based CPS campaign per marketplace (auto-select ON, safe baseline rate = min(default, breakEven×0.5)), plus key-based override campaigns layered per product/category. New listing goes live ⇒ promoted at baseline automatically by eBay's own rule engine; our evaluator then tunes.
- **Keyword intelligence (Priority)**: harvest converting search queries from the CPC SEARCH_QUERY_PERFORMANCE_REPORT + transaction reports → keyword proposals with `suggest_bids`/`suggest_keywords` input; spend-without-sales terms → negative proposals (EXACT or PHRASE — verified; no broad). Not offered on EBAY_ES (no Priority).
- **Weekly digest**: spend, ad sales, eBay ACOS, TACOS, net-margin-after-ads, best/worst movers, autopilot actions taken, pending proposals — rendered in-app at `/…/digest` with bulk approve/reject; data+renderer split so email/WhatsApp can plug in later.
- **Starter rule-pack** (shipped as presets, all PROPOSE): rate-creep-down on high fee%, zero-sale click bleeder pause, suggested-rate tracker within cap, restock re-promote, negative-keyword harvester, budget-exhaustion alert.

## 6. UI information architecture

Placement: **new sibling section inside the existing ads shell** — `apps/web/src/app/marketing/ads/ebay/**` with its own nav group ("eBay" with marketplace switcher) added additively to `_shell/nav.ts`. Zero edits to existing Amazon pages/routes; the eBay pages are built on grid-lens + design-system from day 1 (per `feedback_design_system`), not on the bespoke Amazon grids. (Fallback if the gate prefers isolation: `/marketing/ebay-ads/**` standalone — same components either way; decide at gate.)

Pages (E3 read → E4 writes → E5 automation):
1. `…/ebay` dashboard — KpiStrip (spend, ad sales, eBay ACOS, net margin after ads) + trend + freshness stamps + marketplace switcher.
2. `…/ebay/campaigns` — grid-lens grid; facets: strategy (CPS/CPC), status, marketplace, managed-by (Nexus/Seller Hub/rules); saved views.
3. `…/ebay/campaigns/[id]` — General: ads table (rate-at-ad-level, break-even column, hidden-out-of-stock state); Priority: ad groups → keywords/negatives (bid inputs disabled while DYNAMIC bidding is active); budget quota indicator ("N of 15 budget updates used today" — verified hard cap).
4. `…/ebay/products` — product-first rollup: product → N live listings per marketplace → aggregate ad performance; **Promote** flow (resolver-backed, bulk, chunked progress, per-item results).
5. `…/ebay/automation` — rules list + proposals queue + activity timeline (CampaignAction) + autonomy dial + ceilings + kill-switch.
6. `…/ebay/digest` — weekly review + approve/reject bulk.
7. `…/ebay/settings` — connection/scope status (re-consent CTA), baseline rates, safety factors.

Every monetary value: per-marketplace currency via `design-system/lib/format.ts` (EUR today; GBP-ready). Every panel: "as of …" freshness from sync stamps. Empty/error/degraded states designed (no-scope, quota-exhausted, report-late).

## 7. Security workstream integration (S-series is live)

Register in the S2 permission registry: page `pages.ads` (or `pages.ads.ebay` if page-level granularity is preferred at gate), actions `ads.view`, `ads.manage`, `ads.automations.manage`. Ad spend / ad fees / margin fields are **financial fields** → served through the S-series field-filter (`financials.view`) exactly like order economics. All new endpoints under the RBAC hook with deny-by-default.

## 8. Phase traceability

| Master-prompt requirement | Where in this design |
|---|---|
| E1 shared core, zero Amazon regression | §0.1, audit doc §4 plan items 1–3 (adopt seam, lift pure helpers, grid-lens) |
| E2 data layer + sync + profitability join | §1, §2, §3, §4 |
| E3 read console | §6 pages 1–3 + freshness rules |
| E4 writes (promote flow, builders, CSV, lifecycle) | §2 write path, §6 pages 3–4, CSV round-trip on the campaigns/ads grids |
| E5 automation + weekly agent | §5 |
| E6 benchmark | scored against `E0-COMPETITOR-TEARDOWN.md` checklist |
