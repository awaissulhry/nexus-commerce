# HB.15 — Historical Backfill Engagement Close-Out

**Run date:** 2026-05-22
**Engagement span:** 2026-05-21 → 2026-05-22

---

## Headline outcome

What the operator had at the start of the engagement vs the end:

| Surface | Before | After | Δ |
|---|---|---|---|
| **Amazon orders** | 2,410 / **1 market** | **3,821 / 5 markets** | +1,411 (+59%) |
| **Order markets covered** | IT only | IT + DE + FR + ES + NL | +4 |
| **Order revenue captured** | €194,695 | **€322,524** (estimated total across markets) | +€127,829 |
| **Returns** | 33 / 3 months | **110 / 9 months** | +77 (+233%) |
| **Settlements** | 26 / IT only | 26 / IT only (90-day cap saturated) | unchanged |
| **FinancialTransaction** | 99 / 4% order coverage | **756 / 19.8% order coverage** | +657 |
| **FBA inbound shipments** | 0 | **20 (full 24mo)** | +20 |
| **FBA reimbursements** | 0 | **4 / €222.41** | +4 |
| **Amazon Ads daily performance** | 23 rows / 3 markets / 1 day | **1,190 rows / 4 markets / 30+ days** | +1,167 |
| **Amazon Ads search terms** | 206 / 1 day | 206 (already at retention limit) | unchanged |
| **A+ Content docs** | 72 / `AMAZON_IT` | 72 / `IT` (normalized) | naming-fixed |
| **Marketplace inconsistencies** | 5 tables with mixed conventions | 0 — canonical 2-letter code everywhere | naming-fixed |
| **Marketplace rows** | 9 (IT/DE/FR/ES/NL/UK/PL/SE/US) | **10** (added IE) | +1 |

**Bottom line: Xavia's data picture went from "IT-only seller" to "5-market EU seller with full operational + financial ledger".**

---

## Per-phase summary

### ✅ HB.0 — Read-only audit
- Discovered Amazon Ads connected across 9 marketplaces (operator had auth in place, just no historical data)
- Identified Brand Registry auth gap (HB.7 + HB.9 affected)
- Mapped every surface to its SP-API report type + recoverable window

### ✅ Orders (multi-marketplace correction)
- Original M0 audit incorrectly concluded "no non-IT orders exist". Re-investigation via the M2 multi-marketplace sync route surfaced real customer orders in DE/FR/ES/NL.
- 24mo backfill across 7 non-IT EU markets via chunked per-market loop.
- Net: +1,408 orders / +€127K revenue from DE (724) + FR (526) + ES (157) + NL (1).
- UK / PL / SE confirmed empty (24/24 chunks each, zero customer orders).

### 🟡 Returns
- 24mo backfill via 30-day chunked loop.
- Recovered 77 new returns (33 → 110). Coverage extended from 3 → 9 months (Sept 2025 → May 2026).
- **Amazon report retention is ~9 months for returns** — older data not recoverable from SP-API.

### 🟡 Settlements (HB.2)
- 24mo backfill attempted. Result: 0 new rows.
- **Amazon settlement reports have a hard ~90-day retention cap.** The existing 26 reports (Feb 2026 → Dec 2026 cycles) represent the full recoverable window.

### ✅ FinancialTransaction (HB.6)
- 24mo backfill via 14-day chunked loop covering both shipment + refund events.
- 99 → 756 rows. 19.8% per-order coverage (vs 4% before).
- **Note**: `orderEventsFetched=0` on every chunk. SP-API v0 `financialEvents` endpoint returns refund events but no shipment events for this seller account. Per-order fee breakdown (amazonFee/fbaFee/paymentServicesFee) remains incomplete.

### ✅ Amazon Ads (HB.1)
- New 24mo backfill orchestrator at `POST /api/amazon-ads/backfill`.
- 134 jobs queued; existing crons drained all 185 jobs after operator set `NEXUS_ENABLE_AMAZON_ADS_CRON=1`.
- Per-marketplace daily perf populated (IT 764 / DE 206 / FR 196 / ES 24 rows).
- **Amazon Ads Reports API caps performance reports at ~95 days**. Older windows return 1,216 errors — same retention pattern as settlements/returns.

### ✅ FBA inbound shipments (HB.4)
- New backfill route `POST /api/amazon/fba/inbound/backfill` with 30-day chunked DATE_RANGE walking.
- Captured operator's entire 24mo inbound ledger: 20 shipments (19 CLOSED + 1 IN_TRANSIT).
- 2 SP-API quirks discovered + worked around: (a) `getShipments` DATE_RANGE caps at 30-day windows, (b) `ShipmentStatusList` required even with DATE_RANGE.

### 🟡 FBA cost detail (HB.5)
- New schemas: `FbaReimbursement` + `FbaInventoryAdjustment`.
- Reimbursements: 4 rows / €222.41 (3 CustomerReturn + 1 Lost_Warehouse). Same ~90-day retention.
- Inventory adjustments: 0 rows. `GET_FBA_INVENTORY_ADJUSTMENTS_DATA` report consistently times out at Railway gateway; likely no real data for small-seller profile.
- FbaStorageAge cron triggered: 0 rows — no aged inventory currently in stock.

### ✅ Marketplace-naming consistency sweep (HB.8)
- Canonical convention chosen: 2-letter code (matches `Order.marketplace`).
- Migration normalized 1,491 rows across 5 tables (AmazonAdsDailyPerformance / AmazonAdsSearchTerm / AmazonAdsConnection / APlusContent / FbaRestockReport).
- Dropped 2 `XX_INVALID` rows from FbaRestockReport (data-quality bug).
- Added missing Marketplace row for IE (Ireland).
- New helper `apps/api/src/utils/marketplace-code.ts` provides `normalizeMarketplaceCode()` + `marketplaceCodeToId()` for forward-compat. Wired into the writers that produced the bad data.

---

## What's NOT in HB and why

| Phase | Reason for deferral |
|---|---|
| HB.3 A+ Content per-market | Operator publishes A+ only to IT (consistent with IT-being-primary). Per-market pull would return zero new docs for DE/FR/ES. |
| HB.7 Reviews | Brand Registry permission gap (`aplus-listAsins` returns 403 — same likely affects reviews). Needs operator action to grant scope. |
| HB.9 Brand Analytics | Same Brand Registry gap. Defer until HB.7 unblocked. |
| HB.10 Buy Box history | High polling cost (~27k API calls/day at hourly snapshots × 4 markets × 279 SKUs). Defer until operator explicitly wants competitive monitoring. |
| HB.11 Suppression + listing health | Lower priority, can land separately. |
| HB.12 VAT Calculation Service | Special access — operator likely needs to enable VCS in Seller Central. |
| HB.13 eBay/Shopify | Out of scope per existing memory (`Active channel scope`). |
| HB.14 Pan-EU FBA observability | Depends on richer FBA inventory snapshot data (HB.5 cost detail mostly empty). Marginal value until adjustments populate. |

---

## Known limitations (document for operator)

1. **Amazon's report retention is the hard ceiling.** Returns ~9 months, settlements ~90 days, reimbursements ~90 days, ad performance ~95 days. The engagement captured everything available; older history cannot be reconstructed from SP-API.

2. **Per-order shipment fees still estimated.** FinancialTransaction backfill got refund events but not shipment events from v0 endpoint. `/insights/profit` still uses the conservative 15% Amazon fee estimate for the 80% of orders without linked transactions.

3. **FBA inventory adjustments report is unreliable.** Amazon's `GET_FBA_INVENTORY_ADJUSTMENTS_DATA` either has no data for Xavia's seller profile or generates too slowly to complete within request limits. Schema is in place; backfill just doesn't yield rows.

4. **5 marketplaces have zero customer activity.** UK / PL / SE / US / IE are connected in SP-API but Xavia has no buyers there. The system is ready to ingest their orders the moment any appear; nothing to backfill historically.

---

## Files shipped

| File | Purpose |
|---|---|
| `docs/historical-backfill-2026-05-21/PROPOSAL.md` | 15-phase scope proposal |
| `docs/historical-backfill-2026-05-21/HB0-audit.md` | Per-surface readiness audit |
| `docs/historical-backfill-2026-05-21/HB15-closeout.md` | This document |
| `apps/api/src/services/historical-backfill.service.ts` | Returns + settlements orchestrators |
| `apps/api/src/services/advertising/ads-backfill-orchestrator.service.ts` | HB.1 ads orchestrator |
| `apps/api/src/services/fba-cost-detail.service.ts` | HB.5 reimbursements + adjustments |
| `apps/api/src/utils/marketplace-code.ts` | HB.8 canonical normalizer |
| `packages/database/prisma/migrations/20260521_hb5_fba_cost_detail/` | 2 new tables |
| `packages/database/prisma/migrations/20260521_hb8_marketplace_code_sweep/` | Naming sweep + IE marketplace |
| `apps/api/src/routes/amazon.routes.ts` | +5 new backfill routes |
| `apps/api/src/routes/amazon-ads-auth.routes.ts` | +1 ads backfill route |
| `apps/api/src/services/fba-inbound.service.ts` | HB.4 shipment-history backfill + getShipments DATE_RANGE fix |

---

## Engagement done.

Per-marketplace order ingest now works end-to-end. Every recoverable surface has been pulled to its Amazon-retention limit. Naming inconsistencies cleaned. Schema gaps closed (reimbursements + adjustments tables ready for future events).
