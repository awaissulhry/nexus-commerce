# HB.0 Audit — Per-Surface Backfill Readiness

**Date:** 2026-05-21
**Audit sources:**
- Production DB queries (read-only)
- Production `/api/amazon/{aplus,finance}/probe` endpoints (read-only SP-API calls)
- AmazonAdsConnection table state
- Previous M0 audit (SP-API marketplace participations)

---

## 🎯 Headline findings

1. **Amazon Ads is actively connected across 9 marketplaces** — all `isActive=true`, all verified 2026-05-18:

```
┌─────────────────────┬──────────────────┬───────────────────────┐
│ profileId           │ marketplace      │ account               │
├─────────────────────┼──────────────────┼───────────────────────┤
│ 4117374346144545    │ APJ6JRA9NG5V4 IT │ Xavia Racing Italia   │
│ 2009298984696893    │ A1PA6795UKMFR9 DE│ XAVIA                 │
│ 1132205598741194    │ A13V1IB3VIYZZH FR│ XAVIA                 │
│ 344314473826746     │ A1RKKUPIHCS9HS ES│ XAVIA                 │
│ 3527174089273291    │ A1805IZSGTT6HS NL│ XAVIA                 │
│ 779385059383471     │ A1F83G8C2ARO7P UK│ XAVIA                 │
│ 295908218284169     │ A1C3SOZRARQ6R3 PL│ XAVIA                 │
│ 3245410914913624    │ A2NODRKZP88ZB9 SE│ XAVIA                 │
│ 4392237479209848    │ AMEN7PMS3EDWL ??│ XAVIA (untracked mkt)  │
└─────────────────────┴──────────────────┴───────────────────────┘
```

The `AMEN7PMS3EDWL` profile is for a marketplace not in our `Marketplace` table — likely IE (Ireland) or BE (Belgium). Worth investigating during HB.1.

2. **Ad data is essentially empty despite the active connection** — only 1 day of data (2026-05-20) across some markets. This is the single biggest backfill opportunity in the engagement. **HB.1 is unambiguously the priority phase.**

3. **A+ Content backfill is probably already complete** — `aplus-listDocs` SP-API call returns 72 records, which matches the 72 rows we have in `APlusContent` (24 approved + 47 draft + 1 rejected, all under `AMAZON_IT`). The operator likely only publishes content to IT (consistent with IT-only customer orders).

4. **A+ ASIN listing is auth-gapped** — `aplus-listAsins` returns 403. Means we can list documents but not drill from ASIN → document. Probably affects reviews too (same Brand Registry permission).

5. **Finance API endpoints are accessible** — all 4 finance probes returned 200. HB.6 (FinancialTransaction backfill) is unblocked.

---

## Per-phase readiness

### **HB.1 — Ad spend 24-month backfill** 🔴 highest priority

| Aspect | State |
|---|---|
| Auth | ✅ 9 marketplaces connected via OAuth, all verified |
| Surface | `AmazonAdsProfile` (0 rows), `AmazonAdsDailyPerformance` (23 rows / 1 day / 3 markets), `AmazonAdsSearchTerm` (206 rows / 1 day / 4 markets), `AmazonAdsBrandMetric` (0 rows), `AmazonAdsPortfolio` (?), `AmazonAdsPlacementReport` (?) |
| Gap | **Effectively all of 24 months × 9 profiles is missing.** Plus `AmazonAdsProfile` rows for metadata. |
| Ingestion path | Amazon Ads Reports API v3 (separate from SP-API). One report per (profile, day, report-type) — async. |
| Rate limits | Per-profile, per-report-type. Plan for ~30s/report × ~7,300 day-profile combos = potentially many hours. |
| Risk | Amazon Ads daily-perf reports have a ~95-day historical limit per single report request. May need to chunk into smaller windows. |
| Recommendation | **PROCEED in HB.1** — biggest gap, biggest payoff for /insights/advertising |

### **HB.2 — Multi-market settlement backfill** 🟡

| Aspect | State |
|---|---|
| Auth | ✅ SP-API participations confirmed |
| Surface | `SettlementReport` (26 rows, IT only, 2026-02-23 → 2026-12-05) |
| Gap | DE/FR/ES/NL likely have Pan-EU storage fee settlements + ad-spend settlements. UK/PL/SE/US unknown. |
| Ingestion path | SP-API Reports API: `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE` per marketplace |
| Hard limit | **90-day SP-API cap** — older settlements literally unrecoverable. |
| Recommendation | **PROCEED** but document the 90-day limit upfront so expectations are calibrated |

### **HB.3 — A+ Content per-market backfill** 🟢 likely complete

| Aspect | State |
|---|---|
| Auth | ✅ `aplus-listDocs` returns 200; ⚠️ `aplus-listAsins` returns 403 (Brand Registry gap) |
| Surface | `APlusContent` (72 rows, `AMAZON_IT` marketplace) |
| Gap | Need to verify by calling `listContentDocuments` per `marketplaceId` — current 72 matches IT count, but separate calls per market might return different results |
| Recommendation | **Verify with 4-5 read-only calls** (per-market `listContentDocuments`); if zero non-IT docs, DEFER HB.3 |

### **HB.4 — FBA inbound shipment history** 🔴

| Aspect | State |
|---|---|
| Auth | ✅ FBA Inventory + Inbound access confirmed via existing reconciliation route |
| Surface | `FBAShipment` (0 rows), `FBAShipmentItem` (?) |
| Gap | **Entire historical inbound ledger missing.** Every box ever sent to Amazon FCs. |
| Ingestion path | SP-API `GET /fba/inbound/v0/shipments` paginated (read-only — separate from the deprecated v0 transport endpoint) |
| Recommendation | **PROCEED** — operationally critical for inventory cost-basis + supply chain audit |

### **HB.5 — FBA cost detail (reimbursements + storage + adjustments)** 🟡

| Aspect | State |
|---|---|
| Auth | ✅ Same Reports API surface as HB.2 |
| Surface | `FbaStorageAge` exists but empty; no schema yet for reimbursements or adjustments |
| Gap | All 3 report types unfilled |
| Ingestion path | SP-API Reports API: `GET_FBA_REIMBURSEMENTS_DATA`, `GET_FBA_STORAGE_FEE_CHARGES_DATA`, `GET_FBA_INVENTORY_ADJUSTMENTS_DATA` |
| Schema work | New tables `FbaReimbursement` + `FbaInventoryAdjustment` (FbaStorageAge already exists) |
| Recommendation | **PROCEED** but bundle with HB.6 since it materially improves /insights/profit |

### **HB.6 — FinancialTransaction backfill** 🔴

| Aspect | State |
|---|---|
| Auth | ✅ All finance endpoints return 200 in production probe |
| Surface | `FinancialTransaction` (99 rows vs 2,410 Orders = 96% gap) |
| Gap | Per-order fee breakdown (amazonFee, fbaFee, paymentServicesFee, otherFees) missing for ~2,300 orders |
| Ingestion path | SP-API `listFinancialEventsByOrderId` per order — slow but accurate |
| Risk | Per-order calls × 2,300+ orders = potentially hours. Better: walk `listFinancialEvents` by date window and bulk-upsert. |
| Recommendation | **PROCEED** — fixes /insights/profit fee estimation. Independent of multi-marketplace work. |

### **HB.7 — Review backfill per marketplace** ⚠️ auth-gapped

| Aspect | State |
|---|---|
| Auth | ⚠️ `aplus-listAsins` returns 403 — likely same permission applies to reviews |
| Surface | `Review` (0 rows) |
| Ingestion path | `GET /catalog/2022-04-01/items/{asin}/reviews` per (asin, marketplace) — Brand Registry required |
| Recommendation | **GATE on auth fix** — investigate the 403; if it's the operator's Brand Registry permission, ask them to grant; if it's our app's role, document as deferred |

### **HB.8 — Marketplace-naming consistency sweep** 🟢

| Aspect | State |
|---|---|
| Scope | Migration to canonicalize all `marketplace` columns to 2-letter code |
| Tables affected | `AmazonAdsDailyPerformance`, `AmazonAdsSearchTerm`, `AmazonAdsBrandMetric`, `AmazonAdsConnection`, `APlusContent`, `SettlementReport`, `FinancialTransaction` (when populated) |
| Data-quality bug | 2 `XX_INVALID` rows in `FbaRestockReport` to clean up |
| Recommendation | **DEFER until HB.1-HB.6 land** — migrating columns mid-backfill risks data loss. Run sweep at end. |

### **HB.9 — Brand Analytics (search terms + market basket)** ⚠️ Brand Registry gated

| Aspect | State |
|---|---|
| Auth | Unknown — needs explicit probe of `getBrandAnalyticsSearchTerms` report type |
| Surface | New tables needed |
| Recommendation | **GATE on auth probe** in HB.0 follow-up |

### **HB.10 — Buy Box history** 🟡

| Aspect | State |
|---|---|
| Surface | New schema `BuyBoxSnapshot` needed |
| Polling cost | ~279 SKUs × 4 markets × 1 snapshot/hour = ~27k API calls/day |
| Quota impact | SP-API pricing endpoint allows ~10 req/s per account. Sustainable but eats into the shared budget. |
| Recommendation | **DEFER pending operator priority** — high ongoing cost vs episodic-value |

### **HB.11 — Suppression + listing health** 🟢

| Aspect | State |
|---|---|
| Surface | `AmazonSuppression` exists; row count unknown |
| Ingestion path | Reports API `GET_MERCHANT_LISTINGS_DEFECT_DATA` per marketplace |
| Recommendation | **PROCEED** as part of HB.5 surface bundle |

### **HB.12 — VAT Calculation Service backfill** 🟡

| Aspect | State |
|---|---|
| Auth | Unknown — `GET_VAT_TRANSACTION_DATA` requires special access (often enabled for VAT-registered EU sellers) |
| Surface | No schema yet |
| Recommendation | **GATE on auth probe** — operator may or may not have VCS enabled |

### **HB.13 — eBay + Shopify history** ⚠️ scope-confirm

| Aspect | State |
|---|---|
| Memory | "Skip Shopify, skip WooCommerce, skip Etsy" |
| Recommendation | **Operator-confirm only** before doing anything |

### **HB.14 — Pan-EU FBA observability** 🟢

| Aspect | State |
|---|---|
| Scope | New aggregation surface (per-FC, per-marketplace snapshots over time) |
| Dependency | Builds on HB.4 (FBA inbound) + existing inventory ledger |
| Recommendation | **AFTER HB.4 + HB.5** as a polish layer |

### **HB.15 — End-to-end verification** 🟢

Standard close-out phase. Always last.

---

## Revised phase priority (post-audit)

Based on what I just verified:

| Priority | Phase | Reason |
|---|---|---|
| 🔴 1 | **HB.1** ad spend 24mo | Biggest gap, active 9-market connection, immediate /insights/advertising payoff |
| 🔴 2 | **HB.6** FinancialTransaction | Fixes /insights/profit fee estimation — independent of multi-market work |
| 🔴 3 | **HB.4** FBA inbound history | Operator's entire inbound ledger missing — supply-chain audit blocker |
| 🟡 4 | **HB.5** FBA cost detail | Completes /insights/profit P&L (reimbursements + storage + adjustments) |
| 🟡 5 | **HB.2** settlements per market | Hard 90-day cap means limited value but worth doing for the recoverable window |
| 🟢 6 | **HB.3** A+ verify per-market | Quick read-only check — if no non-IT content exists, skip the rest |
| 🟢 7 | **HB.11** suppression + listing health | Operationally useful, low complexity |
| 🟢 8 | **HB.14** Pan-EU FBA observability | After HB.4 + HB.5 |
| 🟢 9 | **HB.15** verification | Always last |
| ⚠️ 10 | **HB.7** reviews — auth check needed | 403 on aplus-listAsins suggests Brand Registry permission gap |
| ⚠️ 11 | **HB.9** Brand Analytics — auth check needed | Needs `getBrandAnalyticsSearchTerms` probe |
| ⚠️ 12 | **HB.12** VAT data — auth check needed | VCS access varies per seller |
| 🟡 13 | **HB.8** naming sweep | After HB.1-HB.6 |
| 🟡 14 | **HB.10** Buy Box history | High ongoing polling cost; defer unless explicitly wanted |
| ❓ 15 | **HB.13** eBay/Shopify | Operator-scope confirm only |

Revised wall-clock estimate for the **core engagement (HB.1 + HB.2 + HB.4 + HB.5 + HB.6 + HB.8 + HB.15)**: ~**17h** (vs 32h original estimate, because we can skip HB.3 + HB.7 + HB.9 + HB.10 + HB.12 + HB.13 + HB.14 based on the audit).

---

## Findings + recommendations

### What changed since the proposal

| Proposal assumption | Reality from HB.0 |
|---|---|
| "Amazon Ads connection state unknown" | ✅ 9 markets connected, all active |
| "A+ Content gap per non-IT marketplace" | 🟢 Likely no non-IT content exists (72 == 72) — verify with per-market calls before doing HB.3 work |
| "Settlement multi-market potential" | 🟡 90-day cap limits scope but worth attempting |
| "Reviews Brand-Registry-dependent" | ⚠️ 403 confirmed on related endpoint — likely same gap applies |
| "FinancialTransaction backfill straightforward" | ✅ All endpoints accessible; just slow |

### Pre-existing tech-debt surfaced

1. **AmazonAdsConnection has `writesEnabledAt = null` for all 9 profiles** — writes are gated until explicitly enabled. Backfill is read-only so this won't block HB.1.
2. **`AMEN7PMS3EDWL` profile is connected but the marketplace is not in our `Marketplace` table** — should add Ireland (or whatever) so per-market reads work.
3. **2 `XX_INVALID` rows in `FbaRestockReport`** — drop these or fix the marketplace value.

---

## Approval needed

Reply with:
- **"proceed HB.1 (ad spend 24mo)"** — start with the highest-priority phase. ~3h. (Recommended)
- **"proceed HB.1 + HB.6 (ad spend + FinancialTransaction)"** — two independent high-value phases together. ~5h.
- **"proceed HB.1 → HB.6 in sequence (top 5)"** — full priority stack. ~13h across multiple sessions.
- **"different prioritization"** — propose changes
