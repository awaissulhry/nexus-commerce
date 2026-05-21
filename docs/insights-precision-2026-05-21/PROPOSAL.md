# Insights Precision Engagement — Proposal

**Goal:** Make every insights/dashboard number precise, breakdown-aware, currency-aware, and historically accurate.

---

## What the read-only audit found

### 🔴 Three systemic issues across `apps/api/src/services/insights/*`

1. **Date filtering uses `Order.createdAt`** in:
   - `insights-summary.service.ts:70, 108`
   - `insights-profit.service.ts:156, 228`
   - `insights-sales.service.ts:141, 173, 205, 292`
   - Same bug class we fixed in `dashboard.routes.ts` — backfilled orders pile onto today.

2. **No multi-currency conversion**. `insights-summary.service.ts:117` literally sums different currency totals as raw numbers:
   ```ts
   result.currencies.set(code, (result.currencies.get(code) ?? 0) + amount)
   ```
   Then picks "primary currency" = the one with the largest raw amount. **A €10k UK order in GBP (£8,500) + €10k IT order in EUR are treated as different currency buckets that never reconcile.**

3. **Insights summary doesn't use `DailySalesAggregate`** despite the service comment saying it should:
   > "DailySalesAggregate is pre-bucketed per channel/marketplace/SKU and would need extra joins for brand filtering; we revisit if the live query becomes hot."

   Result: every `/insights/summary` request scans up to 50,000 Orders + their OrderItems live. With 2,407 orders today this is fine; at 50k+ it'll be slow. AND it bypasses the canonical channel/marketplace breakdown that DailySalesAggregate provides for free.

### 🟡 Sales-vs-current-price clarification

The user said "sales calculated on selling price, not current prices." Good news: **most aggregation already uses `OrderItem.price` (historical sale price)**, e.g. `insights-profit.service.ts:166-179` and the sales-aggregate service. The headline `DailySalesAggregate.grossRevenue` = `SUM(OrderItem.price × quantity)` — historical.

**But not always.** Spots to verify:
- Inventory valuation in `/insights/inventory` — likely uses `Product.basePrice × totalStock` (current price × current stock). For "inventory at cost" this should be `costPrice`; for "inventory at retail" should clarify if it's *replacement value* (current basePrice) or *historical book value*.
- Any "lost revenue from stockout" metric — uses what price?
- `Product.basePrice` shown in `top SKUs` per-row → that's the current SKU price, not a historical bucket aggregate. Probably intentional but worth flagging.

### 🟡 Per-channel / per-marketplace breakdowns

- `DailySalesAggregate` HAS `channel + marketplace + day + sku` — so the pre-computed aggregate already supports per-channel + per-marketplace breakdowns.
- But `/insights/summary` doesn't use it.
- `dashboard.routes.ts` has `byChannel` but no `byMarketplace`.
- Channel × Marketplace cross-tab (e.g. "Amazon IT vs Amazon DE") doesn't exist anywhere.

### 🟢 What's already correct

- `OrderItem.price` is the historical sale price (Amazon SP-API getOrderItems writes this once on ingest, never updated)
- `DailySalesAggregate.day` is bucketed by `COALESCE(purchaseDate, createdAt)` — correct
- `dayKey()` in summary uses `Europe/Rome` TZ — correct in intent
- Returns/Refunds use their own event dates correctly
- ECB FX rates are loaded for 24 months (2,924 daily rates for EUR→GBP/PLN/SEK/USD) — ready for use, just not used

---

## Plus things you might have missed (research adds)

| Item | Why it matters |
|---|---|
| **Net revenue** (gross − refunds − cancellations) | Today insights show GROSS. Returning customers + chargebacks need to subtract. |
| **Fee-adjusted revenue** for true seller take-home | Amazon commission (~15%) + FBA fees per order should be deducted for "net revenue". FinancialTransaction has the breakdown. |
| **Cost basis: weighted-avg vs FIFO vs LIFO** | `Product.costingMethod` exists; profit calc should respect it (use `weightedAvgCostCents` not `costPrice` for accuracy on stock with mixed purchase costs). |
| **Time zone in filter ranges**, not just display | If `from = "2026-05-01T00:00Z"` (UTC midnight) but operator means "May 1 in Italy", we miss orders 22:00-24:00 UTC on Apr 30. Need TZ-aware range parsing. |
| **DST transition handling** | EU DST ends Oct → 23:00 CEST = 21:00 UTC (vs 22:00 normally). Day buckets shift if not careful. |
| **AOV trend per channel/marketplace** | Average order value moving up/down per channel signals pricing/discount changes. Not currently visualized. |
| **Repeat purchase rate** | Blocked by Customer table being empty (Amazon strips PII). Document the limitation. |
| **Out-of-stock revenue loss** | Estimate revenue forgone when a SKU was stockless during a high-demand window. Needs StockoutEvent + DailySalesAggregate velocity. |
| **Cohort analysis** (first-order month grouping) | Blocked by no Customer data. |
| **Forecast vs actual variance** | `ForecastAccuracy` table exists but probably empty post-wipe. Worth wiring. |
| **Discount/coupon impact** | If a SKU has 20% off, OrderItem.price already reflects discounted price. But "gross at list price" view ("what would they have sold at" might be useful). |
| **Tax treatment per marketplace** | Amazon EU = tax-inclusive (totalPrice = gross including VAT); US/AE/JP/SA = exclusive. Mixing them in revenue rollups overstates EU and understates non-EU. |
| **Pan-EU FBA inventory attribution** | One inventory pool serves 5 marketplaces. "DE stock-out" is meaningless under Pan-EU. Inventory dashboards should treat AMAZON-EU-FBA as one pool. |
| **Mixed currency display strategy** | Show in EUR (single number) vs operator's "home" currency with secondaries (current dashboard pattern) vs per-marketplace native (most accurate for fiscal). |
| **Currency formatting** | EUR: 1.234,56 € (European). en-US: $1,234.56. Format depends on operator locale, not data. |
| **Money math precision** | JS Number loses precision around 15-16 digit decimals. Real money math should use Decimal.js or cents-as-int. Several summed `Number(decimal)` casts in services could drift. |
| **Returns rate per period** | Returns count / Orders count, bucketed by period. Useful for quality + listing-health monitoring. |
| **AOV anomaly detection** | If AOV jumps 50% in a day, something happened (new SKU, fraud, pricing bug). Worth flagging. |
| **Marketplace contribution waterfall** | "DE contributed X% of EU revenue this month" — useful for fiscal/strategic decisions. |
| **Seasonality decomposition** | Time-series analysis to separate seasonal effect from trend. Helps forecast accuracy + anomaly threshold. |
| **Cross-channel attribution** | If we run Amazon Ads and see Shopify revenue rise, is it attribution leakage? Beyond MVP. |

---

## Proposed phases (same approach as the original engagement)

Read-only audit first, get gate approval per phase, test verification per phase.

### **Phase I0 — Read-only audit** (~1 hour)
Walk every insights service + every chart. For each: surface, date-column used, currency handling, per-channel split, precision concerns. Output a matrix `docs/insights-precision-2026-05-21/audit.md`.

**Gate:** you review the matrix; we agree the exact list of fixes.

### **Phase I1 — Date column hardening across `insights/*`** (~1.5h)
Same fix as D3 dashboard but applied to all 11 insights services. Change every `order.createdAt` filter/bucket to `COALESCE(purchaseDate, createdAt)`.

### **Phase I2 — Multi-currency to EUR via historical FX** (~3-4h)
- New helper: `convertToEur(amount, currency, asOf)` reads FxRate
- Every aggregation produces an EUR-equivalent total alongside the native-currency breakdown
- Headline number is EUR (operator's master currency)
- Per-currency breakdown is shown alongside for transparency
- Backfill DailySalesAggregate with `grossRevenueEurCents` column (new migration)

### **Phase I3 — Per-channel + per-marketplace breakdowns** (~3h)
- Every aggregate returns `byChannel`, `byMarketplace`, and a `channelMarketplaceCrossTab` (Amazon-IT, Amazon-DE, ...)
- Operator can filter to a specific channel or marketplace
- New UI surfaces: per-marketplace revenue chart, channel mix waterfall

### **Phase I4 — Insights summary uses DailySalesAggregate** (~2h)
- Rewrite `computeInsightsSummary` to read from DailySalesAggregate
- Brand filter joins DailySalesAggregate → Product on `sku`
- 10-100× faster at scale; preserves per-channel/marketplace

### **Phase I5 — Net revenue (refunds + cancellations)** (~2h)
- Add Return.refundCents + Refund.amountCents to the period
- Subtract cancelled order revenue (already filtered in DailySalesAggregate via `status != 'CANCELLED'`)
- Show both gross and net side-by-side in summary

### **Phase I6 — True profit (sales − fees − COGS − returns)** (~3h)
- FinancialTransaction has `amazonFee + fbaFee + otherFees` already
- COGS uses `Product.weightedAvgCostCents` (or fallback to `costPrice`)
- Subtract refund value
- New per-SKU and per-channel profit-and-loss waterfall

### **Phase I7 — Precision discipline: money in cents** (~3-4h)
- Audit every `Number(decimal)` cast → replace with cents-as-int or Decimal.js
- All aggregation in cents; format at display layer
- Document convention in `docs/etl-conventions.md`

### **Phase I8 — Time zone hardening for ranges + display** (~2h)
- Range parser: "May 1" in Italy → 2026-04-30T22:00Z (CEST) or 2026-04-30T23:00Z (CET depending on DST)
- All `date_trunc('day', purchaseDate AT TIME ZONE 'Europe/Rome')` consistently
- DST transition unit test

### **Phase I9 — Per-surface /insights page fixes** (~4-6h)
For each of: sales, profit, products, customers, inventory, fiscal, anomalies, advertising
- Apply I1-I8 conventions
- Add channel/marketplace filter pills to the page header
- Per-marketplace breakdown chart
- Inventory: separate "at cost" vs "at retail" (replacement value)
- Customers: explicit "Amazon orders anonymized" disclaimer
- Fiscal: per-marketplace VAT, per-period EUR fiscal totals
- Anomalies: flag AOV jumps, returns rate spikes, sudden 0-day periods

### **Phase I10 — Best-in-class extras** (deferred, ~1-3 days each)
Pick & choose:
- Cohort analysis (when Customer data lands)
- Out-of-stock revenue loss estimation
- Seasonality decomposition / trend lines
- Forecast vs actual variance dashboard
- Returns rate trending alert
- Marketplace contribution waterfall (interactive)
- Channel mix moving average

### **Phase I11 — Verification + extended reconciliation** (~2h)
- Reconciliation report extended with per-channel + per-marketplace breakdowns
- Per-marketplace cross-check: SP-API per-marketplace totals match Nexus per-marketplace
- Per-currency cross-check: Sum(EUR-equivalent of each currency) == EUR total
- Spot-check a known period (e.g. "Oct 2024 IT" = €X) against Amazon Seller Central

---

## Estimated wall-clock

| Phase | Hours |
|---|---|
| I0 audit | 1 |
| I1 date column hardening | 1.5 |
| I2 multi-currency FX | 3-4 |
| I3 per-channel/marketplace | 3 |
| I4 use DailySalesAggregate | 2 |
| I5 net revenue | 2 |
| I6 true profit | 3 |
| I7 precision discipline | 3-4 |
| I8 TZ hardening | 2 |
| I9 per-surface fixes | 4-6 |
| I10 extras | (deferred per-pick) |
| I11 verification | 2 |
| **Subtotal (core)** | **27-32 hours** |

That's a real engagement — ~3-4 working days at full focus.

---

## My recommendation

**Start with I0 (read-only audit) only.** It produces a precise file:line matrix for every issue, lets you see scope before authorizing the bigger fixes, and the audit itself is genuinely useful documentation that didn't exist.

**After I0**, the highest-impact phases for "looks right + is precise" are: **I1** (date columns — same fix you saw work for dashboard) → **I2** (currency math — the most impactful precision improvement) → **I3** (per-channel/marketplace — your direct ask).

**I9 (per-surface page fixes)** is where the bulk of UX value lives but it depends on I1-I8 being done first.

**I10 (extras)** is BIG additional scope; defer until the foundation is solid.

Reply with:
- **"proceed with I0"** — I do the read-only audit, you review, then we agree on which subsequent phases
- **"proceed I0 through I3 sequentially, gate before I4"** — incremental autonomy
- **"do everything in order, full autonomy"** — full mandate, multi-session run
- **"different prioritization"** — propose changes
