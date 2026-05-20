# Data Wipe + Backfill — Decision Review (Phase 0+1 results)

**Date:** 2026-05-20
**Status:** ✅ Phase 0+1 complete (read-only audit). Awaiting approval for Phase 2 (destructive).
**Full audit:** [`audit-report.md`](./audit-report.md)

---

## TL;DR — what we actually have

The good news: **there is almost no real production data to lose**. The dataset is much smaller than expected.

| Domain | Current state | What this means |
| --- | --- | --- |
| **Products** | 268 (262 NULL source + 6 MANUAL) | ✅ Real Xavia catalog. **Preserve.** |
| **Variations** | 0 | Xavia uses parent-only SKUs (no size/color matrix). |
| **ChannelListings** | 773 across 4 Amazon markets + 3 eBay stubs | ✅ Real, mostly Amazon. **Preserve.** |
| **DigitalAssets** | 0 | DAM tables exist but no uploads yet. Nothing to wipe. |
| **ProductImage** | 0 | Images live on `ChannelListingImage` only. |
| **Orders** | 7 test orders, €936.51 gross | ☠️ All test data. Wipe. |
| **Customers** | 4 (all from those test orders) | ☠️ Test. Wipe. |
| **Returns / Refunds** | 0 | Nothing to wipe. |
| **FiscalInvoices / FinancialTransactions** | 0 | Nothing to wipe. |
| **Stock Movements** | 363 / 128 levels / 109 cost layers | ☠️ Manual testing + S.20 synthetic backfill. Wipe. |
| **Cycle Counts** | 1 count, 100 items | ☠️ Test. Wipe. |
| **Campaigns (Ads)** | 177 campaigns, 254 ad groups, 3,012 targets, 3,464 product ads, 451 search terms, 2,638 placement reports | ☠️ **All sandbox.** 9 connections, 0 production. Wipe & re-pull from LIVE. |
| **APlusContent** | 1 DRAFT, 0 attachments | ☠️ Test draft. Wipe. |
| **BrandStory** | 0 | Nothing to wipe. |
| **ListingWizard** | 6 drafts (all <30d) | ⚠️ Recent — operator may resume. Preserve. |
| **OutboundSyncQueue** | 445 pending | ⚠️ See concerns below. |
| **OutboundApiCallLog** | 10,320 | ☠️ Operational log. Wipe. |
| **CronRun** | 96,355 (7-day window has tons of healthy traffic) | ☠️ Operational log. Wipe. |
| **AuditLog** | 129 | ☠️ Wipe for clean slate. |
| **ListingReconciliation** | 521 | ⚠️ Re-derive after backfill. Wipe. |

---

## 🚨 Critical concerns surfaced by the audit

### 1. Amazon Ads is 100% sandbox — and full of synthetic data

All 9 `AmazonAdsConnection` rows are `sandbox` mode. None are `production`. The 175 "LIVE_PRODUCT_LINKED" campaigns are sandbox fixtures that happen to reference real product IDs. **Every single ad metric in the DB is fake.**

Phase 8 (Ads LIVE wiring) needs to happen before any real ad data can flow. Until then, post-wipe the Ads dashboards will be empty.

### 2. Amazon ChannelConnection has no OAuth tokens (uses `env` mode)

The single Amazon `ChannelConnection` row is `managedBy='env'` with NULL tokens. This means SP-API auth comes from environment variables (LWA refresh token in `.env`). That's fine but means we can't see at-a-glance whether the credential works — Phase 3 will verify via a dry-run call.

### 3. eBay: 8 ChannelConnection rows but only ONE has tokens

7 of 8 eBay rows have NULL accessToken / refreshToken — stub rows from past OAuth attempts that never completed. **Recommend cleaning these up in Phase 2** (they're not "data", they're abandoned auth attempts).

Only 1 eBay connection is actually authenticated. Phase 4 (Orders backfill) for eBay depends on this working.

### 4. eBay listings exist but have no `externalListingId`

4 eBay `ChannelListing` rows (IT/DE/UK) all have NULL external IDs and NULL titles. These are placeholder stubs from when the eBay flow was being built. **Question:** preserve as scaffolding, or wipe and let real eBay listings flow back from `GetMyeBaySelling`?

### 5. Zero `costPrice` set on any of the 268 products

Without costPrice, COGS, margins, true profit, FBA fee analysis, and repricing floors all break. **This is a data-acquisition gap that backfill from channels cannot fix** — cost data comes from suppliers, not marketplaces.

Recommend a **new Phase 6.5: Cost master import** — operator-facing CSV upload + supplier price-list import, before Phase 10 analytics rebuild.

### 6. 445 rows in `OutboundSyncQueue`

These are pending outbound syncs to channels. Wiping them is fine (the queue is meant to be transient) but doing so means whatever was queued will not get pushed. If any pending row is a real listing update, it will be lost.

**Recommend:** before wipe, run `SELECT * FROM "OutboundSyncQueue" WHERE status='PENDING' LIMIT 20` to spot-check. If they're all sandbox Ads pushes, wipe freely. If they include real listing updates, drain the queue first.

### 7. 102 AMAZON `CONFLICT_DETECTED` warnings in last 7 days

This is the kind of signal that proves the sync IS catching real-world drift. Wiping the SyncHealthLog table loses this telemetry. **Recommend:** export to CSV before wipe so we have an "operating baseline" reference post-wipe.

---

## 🎯 Refined Phase 2 wipe scope

Based on the audit, here's the **exact** delete set for Phase 2:

### Transactional (definitely wipe)
- `Order` (7), `OrderItem` (16) — and CASCADE will get OrderNote, OrderTag, OrderRiskScore, RoutingDecision
- `Customer` (4), `CustomerAddress` (0), `CustomerNote` (0), `CustomerSegment` (0)
- `Shipment` (1), `ShipmentItem` (2), `InboundShipment` (1), `InboundShipmentItem` (1), `FBAShipment` (1), `MCFShipment` (0)
- `Return`, `ReturnItem`, `Refund`, `RefundAttempt` — all already 0
- `FiscalInvoice`, `CreditNote`, `FinancialTransaction`, `FxRate`, `YearEndSnapshot` — all already 0

### Inventory (wipe)
- `StockMovement` (363), `StockLevel` (128), `StockLog` (0), `StockReservation` (3), `StockoutEvent` (2)
- `StockCostLayer` (109) — synthetic seeds from S.20 migration
- `CycleCount` (1), `CycleCountItem` (100)
- `StockBinQuantity` (0), `ChannelStockEvent` (0)

### Inventory PRESERVE
- `Lot` (0), `LotRecall` (0), `SerialNumber` (0), `Bundle` (0) — all empty anyway
- `StockBin` (0), `StockLocation` (2) — keep the 2 locations (Italy main + scratch)

### Advertising (wipe entirely — all sandbox)
- `Campaign` (177), `AdGroup` (254), `AdTarget` (3,012), `AdProductAd` (3,464) — cascade chain
- `AmazonAdsDailyPerformance` (255), `AmazonAdsSearchTerm` (451), `AmazonAdsPlacementReport` (2,638), `AmazonAdsBrandMetric` (0)
- `AmazonAdsReportJob` (173), `AmazonAdsExportJob` (292)
- `BudgetPool*`, `CampaignBidHistory`, `EbayCampaign`, `EbayMarkdown` — all 0
- `AdvertisingActionLog` (0)

### Advertising PRESERVE
- `AmazonAdsConnection` (9) → **but** delete the 8 redundant sandbox rows, keep 1 per profile
- `AmazonAdsPortfolio`, `AmazonAdsProfile` — keep structure

### Marketing content (wipe)
- `APlusContent` (1 DRAFT) + cascade to APlusContentVersion, APlusModule, APlusContentAsin
- `BrandStory*` — all 0

### Operational logs (wipe — clean slate)
- `AuditLog` (129), `SyncLog` (0), `SyncLogErrorGroup` (11), `SyncError` (0)
- `SyncHealthLog` (197) — **export to CSV first** (item #7 above)
- `AiUsageLog` (7), `AlertEvent` (0)
- `CronRun` (96,355) — **only delete rows >7 days old to preserve recent health signal**
- `RateLimitLog`, `TrackingEvent`, `TrackingMessageLog`, `WebhookEvent`, `LoginEvent` — all 0
- `FlatFilePullJob` (1), `FlatFilePullRecord` (1)
- `ImportJob`, `ExportJob`, `RepricingDecision` — all 0

### Analytics aggregates (wipe — derivable)
- `DailySalesAggregate` (14), `ProductProfitDaily` (0), `FbaStorageAge` (0)
- `ListingQualitySnapshot` (0), `ListingReconciliation` (521), `ForecastAccuracy` (0)

### Stale outbound
- `OutboundSyncQueue` (445) — **spot-check before wipe**
- `OutboundApiCallLog` (10,320)

### Wizard artifacts
- `ListingWizard` (6) — **PRESERVE** (all <30d, operator may resume)
- `WizardStepEvent` (28) — wipe (pure telemetry)
- `ScheduledWizardPublish` (0)
- `DraftListing` (0)

### Auth cleanup (NEW — surfaced by audit)
- `ChannelConnection` — delete 7 of 8 eBay rows that have NULL tokens (managedBy='oauth' but never completed). Keep the 1 verified row.

### Listings (NEW — surfaced by audit)
- 4 `ChannelListing` eBay rows with NULL externalListingId + NULL title — **DECISION NEEDED:** wipe (let real eBay listings flow back) or keep as scaffolding?

---

## Decisions needed from you before Phase 2

1. **eBay scaffolding ChannelListings** — wipe the 4 stub rows? (My rec: **yes**, real eBay flow will re-create them via `GetMyeBaySelling`.)
2. **OutboundSyncQueue (445 pending)** — drain first? Or wipe? (My rec: **export to JSON file**, then wipe. Operator can replay any genuine pending operations after the wipe.)
3. **SyncHealthLog (197)** — export to CSV first? (My rec: **yes**, takes 1 sec, preserves the 102 AMAZON conflict signal as a baseline.)
4. **CronRun (96,355)** — wipe everything or keep last 7 days? (My rec: **keep last 7 days** for continuity of the dashboards that read it.)
5. **costPrice gap** — add Phase 6.5 (Cost master import) to the plan? (My rec: **yes**, otherwise margins/COGS/repricing all break.)
6. **eBay ChannelConnection cleanup** — delete the 7 abandoned-OAuth rows? (My rec: **yes**, they're not data.)

---

## Proposed Phase 2 execution plan

A single migration file: `prisma/migrations/20260520_phase_2_data_wipe/migration.sql`

Structure:
1. **Pre-flight exports** (to `/tmp/data-wipe-2026-05-20/`):
   - SyncHealthLog → CSV
   - OutboundSyncQueue (PENDING) → JSON
   - CronRun (last 7 days) → CSV (for restore after table wipe)
2. **Single transaction**:
   - Disable triggers (`SET session_replication_role = 'replica'`)
   - DELETE in FK-safe order (children before parents)
   - Re-enable triggers
3. **Post-wipe canary**:
   - SELECT count(*) FROM "Product" → must equal 268
   - SELECT count(*) FROM "ChannelListing" → must equal 773 (or 769 if we drop eBay stubs)
   - SELECT count(*) FROM "ChannelConnection" → must equal 2 (1 Amazon + 1 eBay) if we drop abandoned

Estimated runtime: <5 seconds (the dataset is tiny).

---

## After Phase 2 — what changes operationally

- All `/orders`, `/customers`, `/fulfillment/stock`, `/insights`, `/advertising` surfaces will show empty state until Phase 4-8 backfills run.
- `/products` and `/products/[id]/edit` (including images, list-wizard) will be unchanged.
- Crons will keep running. Within minutes of Phase 3 (channel sync hardening) finishing, real Amazon orders + inventory will start to populate.
- The 268 products + 773 listings remain intact and visible.

---

## My recommendation

Approve **Phase 2 with these 6 decisions baked in**:
1. ✅ Wipe 4 eBay stub ChannelListings
2. ✅ Export OutboundSyncQueue to JSON, then wipe
3. ✅ Export SyncHealthLog to CSV, then wipe
4. ✅ Keep last 7 days of CronRun, wipe the rest (~95k rows)
5. ✅ Add Phase 6.5 (Cost master import) to plan
6. ✅ Delete 7 abandoned eBay ChannelConnection rows

Reply with **"proceed with my recommendations"** or list any deviations.
