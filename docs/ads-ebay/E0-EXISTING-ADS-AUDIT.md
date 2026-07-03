# E0 — Existing Ads Console Audit & Ads-Core Extraction Plan

> eBay Ads workstream, Phase E0 deliverable 1 of 5. Read-only research; no code changed.
> Sources: full code audit of `apps/web` + `apps/api` + `packages/database/prisma/schema.prisma`, `docs/MARKETING-OS.md`, `docs/ADS_SYNC_MIRROR.md`, `docs/ADS-CONSOLE-AUTOMATION.md`.

## 0. Headline finding

There are **two parallel advertising stacks**, and the extraction story hinges on the distinction:

1. **Legacy Amazon "Trading Desk"** (AD-series backend + AX/CBN UI rebuild). Route monolith `apps/api/src/routes/advertising.routes.ts` (**7,132 LOC**) under `/api/advertising/*`, ~60 services in `services/advertising/*` (~17,700 LOC), models `Campaign`/`AdGroup`/`AdTarget`/`AdProductAd`/`AmazonAds*`. This is what the live UI consumes (the pixel-matched console at `apps/web/src/app/marketing/ads/**`, ≈20,300 LOC). Deeply Amazon-coupled (term frequency across the UI: ACOS ≈390, SP/SB/SD ≈277, portfolio ≈114, ASIN ≈62, profileId ≈19).
2. **Unified Marketing OS (UM-series)** — a channel-neutral seam that **already exists**: `routes/marketing-os.routes.ts` (839 LOC, `/api/marketing/os/*`), `services/marketing/*` (2,014 LOC) around a real **`ChannelAdapter` interface** (`adapters/types.ts`: `pullCampaigns` / `pullMetrics` / `applyMutation` / `setBudget` + `AdapterCapabilities`), with **Amazon, eBay, internal, and stub adapters already registered**, backed by channel-neutral models `MarketingCampaign` + per-channel 1:1 detail tables + `CampaignMetric` / `CampaignAction` / `CampaignBudget` + `MarketingCampaignLink` (per-market fan-out).

**Consequence for E1:** "extract a shared Ads Core" is largely **"finish and adopt the existing UM seam"**, not build a new abstraction. The eBay adapter (`services/marketing/adapters/ebay.adapter.ts`) already exists as a read-only shadow whose `applyMutation`/`setBudget` deliberately throw until `NEXUS_MARKETING_WRITES_EBAY` + scope; `EbayCampaign` (schema:11405) is already synced by `syncEbayCampaigns()` when the token has `sell.marketing`.

⚠️ **But the seam is partly paper**: `AmazonAdsCampaignDetail`, `EbayPromotedDetail`, `ExternalAdsDetail`, `CampaignTarget` have **zero `prisma.*` references** in `apps/api` (defined, dormant); `MarketingCampaign` (27 refs) and `CampaignMetric` (15) are populated only by backfills/shadows; the live Amazon console runs entirely on legacy `Campaign` (100 refs). Also, the existing `EbayCampaign` model + adapter still speak the **pre-2025 eBay vocabulary** (`STANDARD`/`ADVANCED`; comment even mis-glosses STANDARD as "CPM") — the E2 schema must adopt current `COST_PER_SALE`/`COST_PER_CLICK` semantics and rate-at-ad-level truth (campaign-level `bidPercentage` alone cannot represent reality).

## 1. UI inventory (what exists, what's reusable)

Four ads/marketing surface families exist simultaneously:

| Surface | Status | Verdict for eBay |
|---|---|---|
| `/marketing/ads/**` (CBN/AX, H10 pixel-match; ~20.3k LOC) | LIVE, actively developed (rank/dayparting/portfolios frontier) | Shell + grid engine reusable after refactor; content Amazon-only |
| `/marketing/ads-console/**` (older console + automation suite) | live, "kept working until we transfer later" (`nav.ts:2-3`) | Automation suite concepts reusable; page shells legacy |
| `/marketing/advertising/**` (AX2/AX3 intel: SOV, momentum, goals) | live | Amazon-only (Brand Analytics) |
| `/marketing/campaigns` (+`/marketing/automation-os`, `/budgets`, `/analytics`, `/calendar`) — UM cockpit | live, read-mostly | **SHARED-AS-IS: the channel-neutral roster already has an eBay lens** |

Key per-component verdicts (full table in the audit agent's inventory; the ones that matter for E1):

**SHARED-AS-IS**
- `apps/web/src/app/_shared/ads-ui/` — MetricStrip, StatusChip, `format.ts` (channel-neutral, already extracted).
- `apps/web/src/app/marketing/campaigns/**` — UM cockpit UI (channel lens tabs, KPI strip, `useMarketingEvents` SSE).
- `apps/web/src/app/_shared/grid-lens/**` (5,077 LOC): `VirtualizedGrid` (TanStack Virtual, CSS-var column resize, sticky groups), `PreferencesModal`, `SavedViewsButton` (+`SavedView` model), `KpiStrip` (delta chips), `FilterPopover`, `GridToolbar`, `BulkActionShell`, `AutoRefreshSelect`, `KeyboardShortcutsModal`. ~50 workspaces consume it — **notably NOT the Amazon ads pages** (they went bespoke). The eBay console should adopt grid-lens, not the bespoke ads grids.
- Design system (`apps/web/src/design-system`): `FilterBar`, `GridToolbar`, `PreferencesModal`, `MetricStrip`, `DateRangePicker`, `PerformanceGraph`, `Heatmap`, `EmptyState`, `Builder/BuilderSection`, `Stepper`, `Combobox`, `Banner`, `Drawer`, toasts. Case studies already exist: `design-system/studies/00-ads-inventory.md`, `03-ads-campaigns.md`.

**SHARED-AFTER-REFACTOR**
- `marketing/ads/campaigns/_grid/AdsDataGrid.tsx` (587 LOC) — grid engine generic, column catalog Amazon; extract engine or (preferred) converge on grid-lens.
- `marketing/ads/_shell/*` chrome (sidebar/page-header/date-picker) — genericize nav data + market list.
- `rules-automation/_shared/RuleBuilder.tsx` (1,204 LOC) + `_schedule/**` dayparting painter — concepts cross-channel, criteria/action vocabulary Amazon; must become capability-gated (`AdapterCapabilities`).
- `budget-manager/**` — budget pooling concept generalizes (schema already has neutral `CampaignBudget`).
- `AdManagerGraph.tsx`, `dashboard/health/analytics` metric cards.

**AMAZON-ONLY (do not drag into eBay)**: campaign detail ad-groups/search-terms/negative tabs, SP super-wizard, rank goal builder (`_rank/**`), autopilot mission control, AMC/DSP/audiences, portfolios UI, suggestions/harvest UI, brand metrics, SQP/share-of-voice.

## 2. API/services inventory

**The shared seam (adopt):**
- `services/marketing/adapters/types.ts` — `ChannelAdapter` + registry + normalized shapes + `AdapterCapabilities` (supportsKeywords/NegativeTargets/DailyBudget/MultiMarket/BudgetRebalance…).
- `adapters/amazon.adapter.ts` (read-only façade over legacy tables; P8 write cutover exists), `adapters/ebay.adapter.ts` (shadow over `EbayCampaign`; writes throw), `internal.adapter.ts`, `stub-adapters.ts`.
- `marketing-mutation.service.ts` + `marketing-write-gate.ts` (env gate + per-write € cap: `NEXUS_MARKETING_WRITES_EBAY`, `NEXUS_MARKETING_MAX_WRITE_VALUE_CENTS`) + `marketing-action-handlers.ts` + `marketing-budget.service.ts`.
- `marketing-os.routes.ts` — summary/campaigns/analytics/budgets/rules(+rollback)/mutate/sync/backfill/events(SSE) — including `POST /api/marketing/os/sync/ebay` and the eBay go-live runbook in `docs/MARKETING-OS.md`.
- `marketing-events.service.ts` (SSE bus: `campaign.mutated`, `campaign.metrics.refreshed`, `budget.rebalanced`) + web `useMarketingEvents`.

**Amazon Trading Desk (stays, but is the pattern library):**
- `ads-api-client.ts` (1,099 LOC): LWA token cache, region routing, retry/backoff (1→2→4s cap 8s on 429/5xx), sandbox fixtures. eBay equivalent already exists in pieces (`postEbayMarketing`, publish-gate token bucket + circuit breaker).
- `ads-mutation.service.ts` (710): **gated-local pattern** — write locally instantly, enqueue `OutboundSyncQueue` `AD_*` rows with 5-min grace window, BullMQ `ads-sync` worker + Redis-free `ads-sync-drain` cron fallback, `AdvertisingActionLog`/`CampaignBidHistory` audit. **This is the write architecture E4 copies.**
- `ads-write-gate.ts` (222): env=live + connection `writesEnabledAt` + per-campaign allowlist + per-write/daily € caps. Converge with `marketing-write-gate` without weakening Amazon safety.
- `automation-action-handlers.ts` (1,187): `ACTION_HANDLERS` registry idiom → the model for channel automation actions.
- `advertising-rule-evaluator.job.ts` (48 KB) + rules engine; `ads-anomaly-guard.service.ts`; `AdsAutomationState` (autonomy dial OFF/SUGGEST/AUTO + circuit breaker + hourly spend/action caps); `AdsRuleSuggestion` (propose-then-apply with `proposedKey` dedupe); `AutopilotDecision` (PROPOSED/APPLIED/ROLLED_BACK per-decision log); `BulkAutomationApproval` (approval queue with frozen actionPlan + expiry). **E5 composes these, not new tables.**
- Pure, liftable helpers: `ads-metrics-math.ts` (micros→cents, FX→EUR, largest-remainder allocation; unit-tested), `ads-date-range.ts` (Rome-anchored presets + prior-period comparison; unit-tested). Move to a shared home and re-point imports — do not fork.
- `ads-events.service.ts` (action-log reader: diff summarise + rolledBack) and notification hook `ads-automation-notify.service.ts` → `Notification` model.

**Report pipeline (the async pattern E2 generalizes):** two resumable pipelines driven by `ads-sync.job.ts` crons —
1. v3 performance reports: `createReportJob` (idempotent on `{profileId, adProduct, reportTypeId, dates, status}`) → `AmazonAdsReportJob` → `pollPendingJobs` (fair-ordered by `lastPolledAt`, attempts counter) → `ingestCompletedJob` (fetch S3 → `gunzipSync` → upsert `AmazonAdsDailyPerformance` on natural key, absolute counters = rerun-safe, `reportRunId` + `reportedAt` freshness stamps) + 90-day retention cleanups.
2. v1 structure export: `createExportJob` → `AmazonAdsExportJob` → poll → gunzip → upsert `Campaign`/`AdGroup`/`AdTarget`/`AdProductAd`.
Plus the **inbound mirror guards** documented in `docs/ADS_SYNC_MIRROR.md`: fetch-success gating (an errored list never drives deletions), mass-archive circuit breaker, gated-local rows exempt from archival, soft-archive only. **All four guards must carry over to eBay sync.**

**Cron framework:** `node-cron`; each job exports `start<X>Cron()` + `run<X>Once()`; registered in `apps/api/src/index.ts` (ads block ~lines 1289–1372, master gate `NEXUS_ENABLE_AMAZON_ADS_CRON`); manual triggers via `jobs/cron-registry.ts` → `POST /api/sync-logs/cron/<name>/trigger`; every run wrapped in `recordCronRun` → `CronRun` rows (powers `/sync-logs` + health panel); **`dbNow()` DB-clock sourcing** (Railway container clock skew defense) — mandatory for any eBay scheduling.

## 3. Prisma model families (channel coupling)

| Family | Models | State | Verdict |
|---|---|---|---|
| Legacy Amazon core | `Campaign` (2585, 100 refs, `@@unique([externalCampaignId, marketplace])`, no channel column), `AdGroup`, `AdTarget`, `AdProductAd`, `AmazonAdsConnection/Profile/Portfolio`, `AmazonAdsDailyPerformance` (unique `[profileId, adProduct, entityType, entityId, date]`), `AmazonAdsHourly/SearchTerm/Placement/BrandMetric`, `AmazonAdsReportJob/ExportJob`, `AdvertisingActionLog`, `BudgetPool*`, `CampaignBidHistory` | LIVE hot path | Stays Amazon; re-parents under the neutral spine later (schema comments already prescribe this) |
| Rank/dayparting/autopilot | `AdSchedule`, `RankScheduleGroup/Template`, `RankTarget`, `ProductRankPlan`, `BudgetSchedule`, `AutopilotPlan/Decision`, `AdAudience`, `AdBudgetPlan`, `AdProductGoal`, `AdsAutomationState`, `AdsRuleSuggestion` | LIVE | Amazon-only concepts (ToS-IS, bid multipliers); **patterns** reused for eBay, tables not |
| UM neutral spine | `MarketingCampaign` (12586), `MarketingCampaignLink` (12669, `@@unique([externalId, marketplace])`), `CampaignMetric` (12922, `@@unique([channel, entityType, entityId, date])`, `costEurCents` FX-frozen), `CampaignAction` (12977, before/after + rollback), `CampaignBudget/Allocation/Rebalance`, `CalendarEntry` | Partially adopted (shadow-fed) | **The Ads Core.** eBay writes into these from day 1 |
| Channel detail (1:1) | `AmazonAdsCampaignDetail`, **`EbayPromotedDetail`** (12725), `ExternalAdsDetail`, `DiscountDetail`, … | **Dormant (0 refs)** | Light up `EbayPromotedDetail`; extend for current API shape |
| Existing eBay | `EbayCampaign` (11405, 10 refs, synced header mirror; STANDARD/ADVANCED naming), `EbayMarkdown`, `EbayVolumePricing`, `EbayWatcherStats` | Read-side live (pending scope) | Keep as campaign-header mirror or supersede in E2; **naming/shape must be modernized**; no ad/keyword/ad-group children exist — E2 adds them |

## 4. Extraction plan for E1 (ranked, with regression risks)

| # | Extraction | Effort | Risk to in-flight Amazon work | Mitigation |
|---|---|---|---|---|
| 1 | **Adopt the UM seam as the Ads Core** (nothing to move; declare it, document it, add characterization tests around `marketing-os.routes.ts` + adapters — none exist today) | S | LOW (parallel read-only shadow) | Keep Amazon writes on legacy path until P8 cutover; never make UM authoritative for Amazon prematurely (double-write hazard) |
| 2 | Lift `ads-metrics-math.ts` + `ads-date-range.ts` to a shared module; re-point `advertising.routes.ts` imports | S | LOW (unit-tested, pure) | Move, don't fork (fork-drift hazard is real: `amazon.adapter.ts:16-19` already documents a manually-synced copy in `scripts/um2-amazon-backfill.mjs`) |
| 3 | Grid: build eBay grids on **grid-lens** (`VirtualizedGrid` + `KpiStrip` + `SavedViewsButton` + `FilterPopover`); do NOT extend the bespoke `AdsDataGrid`/`CampaignsGrid` | S–M | ZERO (additive) | New `SavedView.surface` values; column catalogs per channel |
| 4 | Converge write gates: eBay writes through `marketing-write-gate` + `marketing-mutation.service` (gated-local + grace + `CampaignAction` audit + `OutboundSyncQueue` + drain) | M | MEDIUM — neutral gate must replicate the legacy gate's per-campaign allowlist + daily caps or Amazon safety weakens when Amazon later converges | Port allowlist/caps into the neutral gate BEFORE any channel switches to it |
| 5 | Capability-gate the rule engine: rule criteria/actions filtered by `AdapterCapabilities` so eBay never offers keyword actions on CPS campaigns etc. | M | MEDIUM-HIGH if done by refactoring the Amazon evaluator | Add a thin capability filter layer; leave `advertising-rule-evaluator.job.ts` untouched for Amazon in E1 (E5 builds the eBay evaluator on the marketing-os rules domain) |
| 6 | Report pipeline: **generalize the pattern, not the code** — new `EbayAdsReportTask` following `AmazonAdsReportJob`'s create→poll→ingest shape; eBay metrics land in `CampaignMetric` (+ eBay fact tables), NOT by refactoring `ads-reports.service.ts` | M | HIGH if you touch `ads-reports.service.ts` (data backbone of the live console) | Zero edits to the Amazon pipeline; share only the pure helpers |
| 7 | Budget pools: eBay uses neutral `CampaignBudget` from day 1 | S | MEDIUM for Amazon later (two pool systems live) | Leave `BudgetPool` alone; converge Amazon post-E6 |

**Explicit non-goals (Amazon-only residue stays behind):** rank-defend loop, ToS-defense, dayparting bid multipliers, autopilot conductor, SP super-wizard, portfolios, AMC/DSP/SQP/Brand Metrics, FBA profit rollup, keyword harvest/negative mining (Amazon grain), LWA auth. Forcing these behind the seam adds abstraction with zero eBay payoff and maximal regression surface on the actively-developed rank features.

## 5. Fragility observed (flagged for the gate)

1. **Dormant-spine hazard**: neutral detail tables defined but unused (0 refs) — do not assume authoritative; backfills are delete-then-insert shadows.
2. **Fork-drift hazard**: `amazon.adapter.ts` normalization manually mirrored in `scripts/um2-amazon-backfill.mjs` (self-documented).
3. **Two-of-everything**: budget pools, write gates, mutation services, and four console surfaces coexist; writing through the wrong path is an easy mistake. (`/marketing/campaigns` redirect + P14 retirement of `/marketing/advertising` and `/listings/ebay/campaigns` are already planned in `docs/MARKETING-OS.md`.)
4. **Report-shape brittleness**: the fixed v2-`location`-vs-v3-`url` bug (`ads-reports.service.ts:284-289`) shows async-report status parsing is version-sensitive — eBay's report task shape must be pinned + fixture-tested.
5. **`dbNow()` clock-skew defense** must be preserved in anything extracted.
6. **Wizard fire-and-forget**: `SpSuperWizard.tsx:116-129` swallows AutopilotPlan provisioning errors (`catch {}`) — campaigns can launch with their AI plan silently missing (pre-existing Amazon bug, noted under Findings).
7. **Test gaps**: pure math well-tested; `advertising.routes.ts` (7,132 LOC), report ingest upserts, and all adapters have no tests. E1 adds characterization tests before touching anything.
8. **eBay UI naming bug (cosmetic but wrong)**: `/listings/ebay/campaigns` grid labels funding as "CPM / CPC" (`EbayCampaignsClient.tsx` column `funding`) and the `EbayCampaign` schema comment calls STANDARD "CPM" — eBay General is cost-per-**sale**, not CPM. Modernized in E2/E3.
