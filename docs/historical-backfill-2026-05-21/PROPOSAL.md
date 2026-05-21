# Historical Backfill — All Surfaces, All Marketplaces

**Date:** 2026-05-21
**Driver:** Re-examine "have we backfilled everything?" question across every Amazon surface, not just orders.

---

## What I just verified against production DB

You're right to probe deeper. The previous M-series (M0-M2 from this morning) only audited **orders** and stopped early after confirming all 2,410 historical orders are IT-customer-placed. The other ~15 ingestion surfaces tell a more nuanced story.

### ✅ Surfaces that ARE complete

| Surface | State | Notes |
|---|---|---|
| **Orders** | IT only (2,410, 24mo) | Confirmed via `raw.MarketplaceId` — every order placed on Amazon.it. Pan-EU FBA visibility duplicates are not real customer orders. |
| **DailySalesAggregate** | IT only (1,941 rows, 567 days) | Mirrors orders. Correct. |
| **Returns** | IT only (33 rows) | All tied to IT orders. Consistent. |
| **ChannelListing** | 4 markets (IT 262 / DE 235 / FR 132 / ES 140) | Listings populated via earlier push. |
| **FxRate** | 24mo for EUR↔GBP/PLN/SEK/USD (731 days each) | ECB rates ready for any future non-EUR currency snapshot work. |

### 🔴 Surfaces with real gaps

| Surface | Current state | Gap | Per-market scope |
|---|---|---|---|
| **AmazonAdsDailyPerformance** | 1 day each across IT/DE/FR (23 rows total) | **24 months of ad-spend history missing.** Single-day backfill from earlier. | Per-marketplace (each market has its own profile) |
| **AmazonAdsSearchTerm** | 4 markets, partial (IT 88 / DE 54 / ES 43 / FR 21) | Probably 24mo of additional search-term data not pulled. | Per-marketplace |
| **AmazonAdsProfile** | 0 rows | Profile metadata missing — links profile → marketplace | Per-profile |
| **AmazonAdsBrandMetric** | 0 rows | Brand-level performance data not ingested | Per-marketplace |
| **SettlementReport** | IT only (26 reports) | DE/FR/ES could have settlements for **Pan-EU FBA storage fees + ad-spend settlements** even without customer orders. SP-API 90-day cap is a hard limit. | Per-marketplace |
| **FinancialTransaction** | 99 rows total | ~2,300+ orders missing per-transaction fee breakdown (commissions/FBA fees/refunds split). Pre-existing gap not tied to multi-marketplace. | Per-order (no marketplace col) |
| **APlusContent** | `AMAZON_IT` only (24 approved + 47 draft + 1 rejected) | DE/FR/ES versions not pulled. Operator may have created A+ Content in non-IT EU markets (Brand Registry covers all participating markets). | Per-marketplace |
| **FBAShipment** | 0 rows | **Operator's entire FBA inbound shipment history is missing** — every box ever sent to Amazon FCs. Big surface area. | Per-shipment (each has destinationFC) |
| **FbaInventoryDetail** | 0 rows | Per-(SKU, FC) inventory snapshots — fee categorization, condition codes | Per-FC |
| **FbaStorageAge** | 0 rows | Inventory age buckets (drives long-term storage fee forecasting) | Per-FC |
| **Review** | 0 rows | Customer reviews per marketplace — important for brand mgmt + listing health | Per-marketplace |
| **FbaRestockReport** | 5 markets backfilled + **2 `XX_INVALID` rows** | Mostly correct but data-quality bug: 2 rows have a bad marketplace value. | Per-marketplace |

### 🟡 Naming convention drift

Different tables use different marketplace column conventions:
- `Order.marketplace` = `'IT'` (2-letter code)
- `AmazonAdsDailyPerformance.marketplace` = `'APJ6JRA9NG5V4'` (SP-API id)
- `APlusContent.marketplace` = `'AMAZON_IT'` (prefixed compound)
- `SettlementReport.marketplaceId` = `'APJ6JRA9NG5V4'`

This is an ongoing pain — cross-surface joins / dashboards have to normalize. Worth a single-sweep cleanup as part of this engagement.

---

## Plus stuff you might have missed (research adds)

| # | Item | Why it matters |
|---|---|---|
| 1 | **Pan-EU FBA reimbursements** | Amazon credits the seller for lost/damaged inventory. Per marketplace. Real money that should show up in /insights/fiscal as P&L positive. SP-API: `GET_FBA_REIMBURSEMENTS_DATA` report. |
| 2 | **Pan-EU FBA storage fees** | Monthly storage charges per FC. Separate from settlement summary; line-item detail comes from `GET_FBA_STORAGE_FEE_CHARGES_DATA`. Without this, /insights/profit underestimates monthly carrying cost. |
| 3 | **FBA inventory adjustment events** | When Amazon transfers your inventory between FCs (Pan-EU rebalancing), it's a real ledger event. `GET_FBA_INVENTORY_ADJUSTMENTS_DATA`. |
| 4 | **FBA removal / disposal orders** | When you ask Amazon to ship back or destroy unsellable inventory, the cost + units are itemized. `GET_FBA_FULFILLMENT_REMOVAL_*_DATA`. |
| 5 | **Brand Analytics market basket** | Which other products customers bought alongside yours. Per marketplace. Drives cross-sell strategy. Brand Registry required. |
| 6 | **Brand Analytics top searched terms** | The 100k most-searched terms per marketplace, weekly. Different table from `AmazonAdsSearchTerm` (which is ad-driven). |
| 7 | **Buy Box / Featured Offer history** | Who's winning the buy box for your listings, per marketplace, over time. SP-API `Pricing/v0/items/{asin}/offers`. Critical for repricing strategy. |
| 8 | **Amazon Order Reports (alternate getOrders surface)** | `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL` covers older orders that getOrders may miss after the 24mo window. Useful for SE/PL (low volume but old). |
| 9 | **VAT Calculation Service reports** | Per-transaction VAT breakdown per marketplace. `GET_VAT_TRANSACTION_DATA`. Required for accurate OSS reporting. |
| 10 | **Long-term storage fee charges** | Inventory older than 365 days gets surcharged. Per-FC, per-marketplace. Missing this means /insights/inventory shows the wrong "true cost of carrying stock". |
| 11 | **Inventory reimbursement reasons** | Lost/damaged/customer-not-returned. Categorization helps spot patterns (e.g. high losses at one FC suggest packaging issue). |
| 12 | **Sales tax collected per marketplace** | Amazon collects + remits in most EU markets under marketplace facilitator rules. Per-marketplace detail required for fiscal compliance. |
| 13 | **Coupon redemption history** | Coupons exist (table is there with 0 rows) but Amazon-side coupon performance metrics not ingested. |
| 14 | **Deal participation history** | Lightning deals, 7-day deals, Best Deals — past participation + performance. |
| 15 | **Subscribe-and-Save metrics** | If any SKU is enrolled in SnS, monthly auto-ship counts + projected revenue. Per-marketplace. |
| 16 | **Vine review counts** | Vine-enrolled SKUs and how many reviews each generated. Per-marketplace. |
| 17 | **A+ Content effectiveness** | Amazon now exposes "A+ contribution to conversion" — was the A+ helping or not. Per-ASIN, per-marketplace. |
| 18 | **eBay + Shopify history** | Previous decisions deferred Shopify entirely and skipped eBay deep work. If "all the history" really means **all** channels, those are gaps too. (Confirm scope.) |
| 19 | **Suppression history** | `AmazonSuppression` table exists. Per-listing suppression events (out-of-stock, policy violations, A+ rejection) — operationally important. |
| 20 | **Listing health audit history** | Quality alerts per ASIN per marketplace. Different from suppression — includes "missing image", "ambiguous title", etc. |
| 21 | **FBA inbound performance score** | Amazon scores how well-prepared your shipments are (correct labels, packing, etc.). Per-marketplace. Drives FBA fee tier. |

---

## Proposed phases (HB-series, gate-before-implementing)

### **Phase HB.0 — Read-only audit + SP-API report inventory** (~1h)
- Walk every surface listed above
- For each: confirm current row count, identify SP-API report type that fills it, confirm operator's SP-API auth scope covers it
- Output: `docs/historical-backfill-2026-05-21/HB0-audit.md` with per-surface gap + ingestion path
- **Gate:** you review and pick which surfaces are worth pulling

### **Phase HB.1 — Ad spend 24-month backfill (per-marketplace, per-profile)** (~3h)
- Pull `AmazonAdsProfile` rows for IT + DE + FR + ES + NL + UK + PL + SE (every market where operator advertises)
- Backfill `AmazonAdsDailyPerformance` for 24 months × every profile
- Backfill `AmazonAdsSearchTerm` 24 months × every profile
- Backfill `AmazonAdsBrandMetric` 24 months × every profile
- Per-profile sequential fan-out (Ads API rate limits are per-profile)
- **Gate:** /insights/advertising shows complete 24mo trend across all markets

### **Phase HB.2 — Multi-marketplace settlement backfill (90-day cap)** (~2h)
- Fan out `reconcileAmazonSettlements` across all participating marketplaces (M1 list)
- SP-API hard limit: only ~90 days of settlements available. Document what's recoverable.
- Spot non-IT settlements (storage fees, ad fees) that confirm presence of activity even without customer orders
- **Gate:** SettlementReport has rows for every market with non-zero settlement activity

### **Phase HB.3 — A+ Content per-market backfill** (~2h)
- Pull `getContentDocument` per `marketplaceId` for IT/DE/FR/ES/NL/UK
- Detect content created in non-IT markets that we don't have locally
- Normalize the `marketplace` column ('AMAZON_IT' → 'IT') as a sweep — also fixes #20 in the missed-items list
- **Gate:** APlusContent rows present for every market with active Brand Registry content

### **Phase HB.4 — FBA inbound shipment history backfill** (~3h)
- Pull `getShipments` for status IN (CLOSED, RECEIVING, DELIVERED, ...) for the last 24 months
- One call per marketplace (UK + EU pools separate)
- Populate `FBAShipment` + `FBAShipmentItem` rows so the operator can see their full inbound history
- **Gate:** FBAShipment count plausibly matches operator's recollection of historical inbound volume

### **Phase HB.5 — FBA cost detail (reimbursements + storage + adjustments)** (~3h)
- `GET_FBA_REIMBURSEMENTS_DATA` — populate `FbaReimbursement` (new table needed)
- `GET_FBA_STORAGE_FEE_CHARGES_DATA` — populate `FbaStorageAge` rows (already exists, empty)
- `GET_FBA_INVENTORY_ADJUSTMENTS_DATA` — populate adjustment ledger (new table)
- Per-marketplace where applicable
- **Gate:** /insights/profit shows realistic FBA fees + reimbursements in monthly P&L

### **Phase HB.6 — FinancialTransaction backfill for all historical orders** (~2h)
- Walk every Order (2,410 rows) without a linked FinancialTransaction
- Pull `listFinancialEventsByGroupId` or `listFinancialEvents` for the order's window
- Populate the per-fee breakdown (amazonFee, fbaFee, paymentServicesFee, otherFees)
- **Gate:** /insights/profit shows real fees instead of estimated 15% Amazon rate

### **Phase HB.7 — Review backfill per marketplace** (~3h)
- Brand-Registry-only feature; requires brand-registered SKUs
- `GET /catalog/2022-04-01/items/{asin}/reviews` per marketplace
- Per-(ASIN, marketplace) → Review rows
- Useful for /insights/products quality monitoring
- **Gate:** Review rows present; per-SKU star-rating breakdown visible in /products

### **Phase HB.8 — Marketplace-naming consistency sweep** (~2h)
- Pick a canonical convention: I'd recommend `code` ('IT', 'DE') matching `Order.marketplace`
- Migrate `AmazonAdsDailyPerformance.marketplace`, `AmazonAdsSearchTerm.marketplace`, `APlusContent.marketplace`, `SettlementReport.marketplaceId` → all to 2-letter code
- Update all readers
- Fix the 2 `XX_INVALID` FbaRestockReport rows (data-quality bug)
- **Gate:** /insights surfaces all join cleanly without runtime code-vs-id normalization

### **Phase HB.9 — Brand Analytics (search terms + market basket)** (~3h)
- Different from `AmazonAdsSearchTerm` (which is ad-spend-driven)
- `GET_SALES_AND_TRAFFIC_REPORT` + `GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT` + market basket
- Per-marketplace, weekly granularity (Amazon publishes weekly)
- **Gate:** /insights/products shows top organic search terms per marketplace

### **Phase HB.10 — Buy Box history** (~3h)
- Hourly snapshots of who wins the buy box per (ASIN, marketplace)
- New schema: `BuyBoxSnapshot` table
- Polling every ~hour (rate-limited)
- Drives /pricing/repricing decisions
- **Gate:** Buy-box win-rate trend per SKU visible

### **Phase HB.11 — Suppression + listing health** (~2h)
- `AmazonSuppression` already exists; backfill from current state
- Listing-health alerts per (ASIN, marketplace)
- **Gate:** Suppressed listings + health-alert SKUs surface in /products with reason codes

### **Phase HB.12 — VAT Calculation Service backfill** (~2h)
- `GET_VAT_TRANSACTION_DATA` per marketplace
- Required for accurate OSS reporting + fiscal compliance
- Per-transaction VAT amount + buyer country + seller country
- **Gate:** /insights/fiscal can produce OSS-ready quarterly returns

### **Phase HB.13 — eBay + Shopify history (if in scope)** (~4h)
- Confirm scope first (memory says "skip Shopify, skip WooCommerce, skip Etsy")
- If yes: eBay orders + financials backfill (24mo); Shopify orders if connected
- **Gate (conditional):** operator confirms intent

### **Phase HB.14 — Pan-EU FBA observability** (~2h)
- New aggregation: per-FC, per-marketplace inventory snapshots over time
- Tracks Pan-EU rebalancing (when did the IT-pool drop and DE-pool gain)
- Drives /insights/inventory "where is my stock right now and how is it moving"
- **Gate:** historical FC-level movement visible in /insights/inventory

### **Phase HB.15 — End-to-end verification** (~2h)
- Per-surface row-count checks vs SP-API count endpoints
- Cross-surface joins (Order × FinancialTransaction × SettlementReport) reconcile within rounding
- Document remaining known gaps (e.g. 90-day settlement cap)
- **Gate:** sign-off — backfill engagement closed

---

## Estimated wall-clock

| Phase | Hours | Notes |
|---|---|---|
| HB.0 audit | 1 | Read-only; informs scope |
| HB.1 ad spend 24mo | 3 | Big surface, multi-profile |
| HB.2 settlements per market | 2 | 90-day SP-API cap |
| HB.3 A+ Content per market | 2 | + naming sweep |
| HB.4 FBA inbound history | 3 | 24mo of shipments |
| HB.5 FBA cost detail | 3 | New tables + 3 report types |
| HB.6 FinancialTransaction | 2 | Pre-existing P0 gap |
| HB.7 Reviews | 3 | Brand Registry only |
| HB.8 naming sweep | 2 | Migration + reader updates |
| HB.9 Brand Analytics | 3 | New ingestion surface |
| HB.10 Buy Box history | 3 | New polling + schema |
| HB.11 Suppression + health | 2 | Existing tables |
| HB.12 VAT data | 2 | Fiscal compliance |
| HB.13 eBay + Shopify (conditional) | 4 | Operator-confirm scope |
| HB.14 Pan-EU FBA observability | 2 | New aggregation |
| HB.15 verification | 2 | Sign-off |
| **Subtotal (core, excluding HB.13)** | **~32h** | ~4 working days |

---

## Risk + sequencing notes

- **HB.1 (ad spend) is the biggest immediate-value phase** — it's the surface where non-IT data demonstrably exists (search terms for DE/FR/ES already in DB) but daily-performance history is missing.
- **HB.2 (settlements 90-day cap) is a hard limit** — older settlements literally can't be pulled. Document the gap; don't promise full historical.
- **HB.6 (FinancialTransaction) is independent of multi-marketplace** — purely fixing a pre-existing per-order ingestion gap. Could happen first if /insights/profit precision matters more than multi-market visibility.
- **HB.10 (Buy Box) introduces new polling load** — at 1 snapshot/hour × 279 SKUs × 4 markets = ~27k API calls/day. Plan for SP-API quota impact.
- **HB.13 (eBay + Shopify) needs explicit operator scope confirmation** — current memory says skip.
- **HB.8 (naming sweep) should NOT happen until HB.1-HB.5 land** — migrating columns mid-backfill risks losing rows that just got written.

---

## My recommendation

**Start with HB.0 (read-only audit) only** — same pattern as M0 and F.6.0. The audit confirms scope before committing to multi-day ingestion work. Tells us:
- Which SP-API reports the operator's auth scope actually permits
- Per-surface expected volume so we know if HB.7 (reviews) is worth doing vs deferring
- Whether a surface has nuances (e.g. some reports require Brand Registry; some are paid)

After HB.0, the highest-value phases are:
- **HB.1 (ad spend 24mo)** — immediate /insights/advertising payoff
- **HB.6 (FinancialTransaction)** — fixes /insights/profit estimation gap
- **HB.4 (FBA inbound history)** — gives operator visibility into their own inbound history
- **HB.5 (FBA cost detail)** — completes the /insights/profit P&L picture

The other phases are valuable but more incremental.

Reply with:
- **"proceed HB.0"** — read-only audit (Recommended)
- **"proceed HB.0 → HB.1 (ad spend)"** — audit + immediate high-value phase
- **"different prioritization"** — propose changes

---

## What this changes vs the previous M-series finding

The previous M-series concluded: **"no other marketplaces have real customer orders to backfill."** That conclusion stands — verified again today (all 2,410 orders have `raw.MarketplaceId = IT`).

**But "no orders" ≠ "no other historical data."** This proposal covers the other ~14 surfaces (ads, settlements, A+, FBA cost detail, reviews, etc.) where data DOES exist per non-IT marketplace but hasn't been backfilled. The user's instinct was right.
