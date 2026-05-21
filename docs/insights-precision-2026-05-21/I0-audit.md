# I0 — Insights precision audit

**Generated:** 2026-05-21
**Method:** grep `createdAt|currencyCode|FxRate|basePrice|costPrice|totalPrice|byChannel|byMarketplace` across `apps/api/src/services/insights/*` + cross-ref with `apps/web/src/app/insights/*`

**User direction:** sales must show **exact value + currency per marketplace, as Amazon does** — no implicit currency conversion. Native currency per marketplace stands alone. Mixed-currency overall rollups are misleading and should either be removed or explicitly labeled.

## Severity legend
- 🔴 **Wrong** — uses createdAt date / mixes currencies / drops marketplace dimension
- 🟡 **Tolerable** — fix improves but isn't blocking
- 🟢 **Correct** — already follows the precision/marketplace convention

---

## Per-service matrix

### 🔴 `insights-summary.service.ts` (the headline KPI strip)
| Line | Issue | Fix |
|---|---|---|
| 70, 108 | Filters/buckets by `Order.createdAt` (backfill bug) | `purchaseDate` |
| 106-117 | `Number(o.totalPrice)` summed across mixed currencies → "primary currency" picked by max raw amount = wrong | Per-currency buckets stay separate; **no implicit conversion**. Display per-marketplace native. |
| Missing | No per-marketplace breakdown returned | Add `byMarketplace` + `byMarketplaceCurrency` |
| Architecture | Live-scans 50k orders + items; ignores `DailySalesAggregate` | Switch to DailySalesAggregate for the bulk (it's pre-bucketed by sku/channel/marketplace/day) |

### 🔴 `insights-sales.service.ts` (sales report)
| Line | Issue | Fix |
|---|---|---|
| 141, 173-174, 205, 292 | `Order.createdAt` filter + bucket | `purchaseDate` |
| 113-117 | DTO exposes `currencyCode` per row ✅ but downstream charts probably collapse | Verify chart respects per-marketplace currency split |
| 332 | `result.currencies.set(code, ...)` — keeps per-currency split ✅ | Make UI render per-marketplace native, not blended |

### 🔴 `insights-profit.service.ts` (P&L waterfall)
| Line | Issue | Fix |
|---|---|---|
| 156, 228 | `Order.createdAt` filter | `purchaseDate` |
| 166-181 | Uses OrderItem.price (historical) ✅ + Product.costPrice ✅ — correct | None |
| 179 | `Number(it.price)` — JS Number drift on large sums | Use cents-as-int or Decimal.js |
| 196-212 | Ad spend uses `AmazonAdsDailyPerformance.date` (real date) ✅ | None |
| 219-243 | Returns uses `Return.createdAt` (Return.createdAt IS the actual return date, set by Amazon report) ✅ | None |
| Missing | Doesn't split per-marketplace | Add byMarketplace; per-marketplace profit shown native currency |

### 🔴 `insights-breakdown.service.ts` (per-channel breakdown — already partial)
| Line | Issue | Fix |
|---|---|---|
| 75 | `createdAt` filter | `purchaseDate` |
| 108 | `Number(o.totalPrice)` summed — mixed currency | Per-currency split |
| 95, 108-117 | Has `byChannel` map ✅ | Good |
| Missing `byMarketplace` (line 136 shows it but only returned, never used in summary) | UI needs it surfaced | |

### 🔴 `insights-customers.service.ts` (geographic + behavior segments)
| Line | Issue | Fix |
|---|---|---|
| 117, 125, 209-264 | `createdAt` everywhere for filter + bucket + first-seen detection | `purchaseDate` (esp. line 222-223 "first observed customer" — backfill bug means EVERY customer is "first seen today") |
| 162, 267 | `Number(o.totalPrice)` mixed currency | Per-currency split or per-marketplace native |
| 159, 264 | `geo: o.marketplace` ✅ already keys by marketplace | Good |
| Critical | Customer table is empty (Amazon strips PII) — cohort / repeat-customer features blocked | Document; surface UI disclaimer |

### 🔴 `insights-fiscal.service.ts` (Italian fiscal compliance)
| Line | Issue | Fix |
|---|---|---|
| 134, 158 | `createdAt` filter | `purchaseDate` (CRITICAL for fiscal — wrong fiscal period = wrong tax filing) |
| 142, 163, 205, 208 | `totalPrice + currencyCode` per row, summed by code | Per-marketplace native required for tax-period reporting (DE VAT separate from IT) |
| 227 | Country derivation from shippingAddress.country, fallback marketplace | Solid |
| Missing | No per-marketplace tax-period totals (VAT due per marketplace per quarter) | Add per-marketplace fiscal rollup |

### 🔴 `insights-anomalies.service.ts`
| Line | Issue | Fix |
|---|---|---|
| 106, 115, 134, 143 | `createdAt` filter + bucket | `purchaseDate` (anomaly detection on wrong date series produces fake anomalies — backfill on today looks like a 2000% spike) |
| 135-138 | `Number(o.totalPrice)` mixed currency | Detect anomalies per-marketplace native to avoid currency-mix false alarms |

### 🔴 `insights-products.service.ts` (per-SKU performance)
| Line | Issue | Fix |
|---|---|---|
| 136, 156, 171, 199 | `createdAt` filter + bucket | `purchaseDate` |
| 222, 239, 246, 313 | Same | Same |
| Missing | Per-marketplace per-SKU velocity | Add (DailySalesAggregate has this already) |

### 🔴 `insights-top-skus.service.ts`
| Line | Issue | Fix |
|---|---|---|
| 61, 64, 73, 94 | `createdAt` filter + bucket | `purchaseDate` |
| Missing | No per-marketplace top-SKUs | Add filter + breakdown |

### 🟡 `insights-forecast.service.ts`
| Line | Issue | Fix |
|---|---|---|
| 244 | `createdAt` filter for 30d AOV lookback | `purchaseDate` |
| 291-292 | Falls back to `Product.basePrice` (current price) when no order data — this IS the only legitimate use of basePrice in insights, for forecast-revenue projections | OK, but document |

### 🟢 `insights-inventory.service.ts`
| Line | Issue | Notes |
|---|---|---|
| 201 | `inventoryValue = costPrice × stock.available` — uses cost, not retail | Correct (book value at cost) |
| 109, 125, 127, 169 | `createdAt` is on **StockMovement** here, not Order — and StockMovement.createdAt IS the event date | ✅ leave alone |
| Critical | costPrice is NULL on 268/268 products → inventoryValue always 0 | **Data gap, not code bug.** Operator needs to upload cost CSV. |

### 🟢 `insights-advertising.service.ts`
| Notes | |
|---|---|
| Sources from `AmazonAdsDailyPerformance.date` (real date) ✅ | |
| `byMarketplace` already returned ✅ | |
| `currencyCode` per row, surfaced in DTO ✅ | |
| Currently no real data (sandbox-only ads); harmless | |

### 🟢 `insights-brief.service.ts` / `insights-what-changed.service.ts`
Read from `breakdown` (insights-breakdown) — inherits its issues. Fix breakdown, these get fixed.

---

## Cross-cutting concerns

### Currency / per-marketplace display rule (user-stated)

> "Sale must be the exact value and currency like on Amazon for each market."

This means:
- ✅ Order rows already store `totalPrice + currencyCode` per order (preserved on ingest)
- ✅ OrderItem.price is historical
- ❌ **Every aggregation that produces a "total" implicitly assumes a single currency** — when it's not, the number is meaningless
- ❌ Headline KPI cards show one revenue number — for a multi-market seller, this is misleading

**Required convention:** every revenue metric is reported **per marketplace in its native currency**. A "global total" either:
- Doesn't exist (most honest)
- Or is explicitly labeled "EUR-equivalent estimate" with a tooltip showing the per-marketplace native breakdown
- Or is the seller's PRIMARY marketplace (IT for Xavia) shown alone with a note "+ X other marketplaces"

### Date columns

10 of 11 insights services use `Order.createdAt`. Same systemic fix as the dashboard.routes.ts engagement. Universal `purchaseDate` replacement needed.

### Money precision

`Number(decimal)` casts in 12+ places. JS Number is 64-bit float; precision loss above ~15 decimal digits. For a seller doing €200k/quarter, individual sums are safe. But aggregation across many orders + multiple operations (revenue − fees − refunds × FX) can drift cents. Use cents-as-int or Decimal.js for the canonical path.

### TZ in filter ranges

Display TZ (`Europe/Rome`) is set in `dayKey()`. But filter `from/to` boundaries are UTC. Italian "May 1" should be Apr 30 22:00 UTC (CEST) or 23:00 UTC (CET) — never May 1 00:00 UTC. Range parser needs TZ awareness.

---

## Things still missing (deferred per `PROPOSAL.md` list)

| Item | Status |
|---|---|
| Cohort analysis (first-order month) | Blocked — empty Customer table |
| LTV / repeat purchase rate | Blocked — same |
| Out-of-stock revenue loss estimation | Not built; would use StockoutEvent × per-SKU velocity |
| Forecast accuracy dashboard | Table exists but empty |
| Returns rate per period trending | Easy add; not in current insights |
| AOV anomaly detection per channel | Easy add; current anomalies only on aggregate |
| Marketplace contribution waterfall (interactive) | UI work; service-side data exists in insights-breakdown |
| Discount/coupon decomposition | Not modeled |
| Per-marketplace tax-period VAT rollup | Code in insights-fiscal but not surfaced cleanly |
| Currency display formatting per locale | Not implemented (1.234,56 € European vs en-US) |

---

## Concrete fix list (counts)

| Service | createdAt → purchaseDate sites | Currency-mix sites | Marketplace breakdown to add |
|---|---|---|---|
| insights-summary | 2 | 1 (line 117) | byMarketplace + perMarketplaceCurrency |
| insights-sales | 5+ | 1 (verify per-marketplace render) | byMarketplace |
| insights-profit | 2 | 1 (line 179) | byMarketplace |
| insights-breakdown | 1 | 1 (line 108) | already has matrix, surface in UI |
| insights-customers | 6+ | 2 (162, 267) | already has `geo` |
| insights-fiscal | 2 | 1 (per-marketplace VAT) | critical: add per-marketplace fiscal rollup |
| insights-anomalies | 4 | 1 (line 135-138) | per-marketplace anomaly detection |
| insights-products | 6+ | — | byMarketplace per-SKU |
| insights-top-skus | 4 | — | byMarketplace |
| insights-forecast | 1 | — | OK (forecast is per-marketplace already via filter) |
| insights-inventory | 0 (uses StockMovement.createdAt = event date) | — | byMarketplace stock attribution (Pan-EU complication) |
| insights-advertising | 0 ✅ | already has currencyCode | already has byMarketplace ✅ |
| **TOTAL** | **~30 sites** | **~7 sites** | **9-10 surfaces** |

---

## Recommended next-phase order (refined from PROPOSAL.md)

1. **I1 — Date column hardening** (~1.5h) — universal `createdAt` → `purchaseDate` across insights services. Same pattern that worked for dashboard.
2. **I3 — Per-channel/per-marketplace breakdown** (~3h) — required for "exact value per market". Add `byMarketplace` to summary; expose Pan-EU fiscal totals correctly.
3. **I2 (revised) — Currency discipline** (~2h, smaller than original): NO implicit conversion. Each per-marketplace bucket stays in its native currency. UI surfaces "5 markets: IT €X, DE €Y, UK £Z, ..." instead of a misleading blended total. Add explicit "EUR-equivalent estimate" sidecar where operationally useful.
4. **I4 — Switch summary to DailySalesAggregate** (~2h) — perf + free per-channel/marketplace.
5. **I5 — Net revenue** (~2h) — subtract refunds + cancellations per period per marketplace.
6. **I6 — True profit** (~3h) — already mostly right in profit.service.ts; add per-marketplace.
7. **I7 — Precision discipline** (~3h) — cents-as-int or Decimal.js for the canonical money path.
8. **I8 — TZ hardening** (~2h) — range parser + display consistency.
9. **I9 — Per-page UI fixes** (~4-6h) — per-marketplace filter pills, per-marketplace charts.
10. **I11 — Verification** (~2h) — per-marketplace reconciliation against Amazon Seller Central.

Total core: ~25-28 hours.

## Recommendation

The single biggest UX impact is **I1 + I3 together**: fix the date bug AND surface per-marketplace breakdowns. After those land, the insights pages will visibly show "your IT business is €X, your DE business is €Y" instead of a stacked-on-today blended number that looks fake.

**Reply with:**
- "proceed I1 → I3 → I2" (the three high-impact + your direct ask)
- "do everything in order, full autonomy"
- "I1 only, gate before I3"
- different prioritization
