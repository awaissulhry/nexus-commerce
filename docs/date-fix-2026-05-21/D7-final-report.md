# D-series Final Report — Date column fixes

**Window:** 2026-05-21
**Trigger:** User reported "backfilled data shows all in a single day" on home dashboard
**Outcome:** ✅ Resolved — dashboards now show real time-distribution

---

## Root cause

Backfilled orders carry `createdAt = today` (DB-insert time) but `purchaseDate` spans the real 24-month history. Most dashboard queries filtered/bucketed by `createdAt`, so 2,407 historical orders piled onto today's column.

## Phases executed

### ✅ D0 — Read-only audit
Mapped every `createdAt` filter site → catalog at `docs/date-fix-2026-05-21/D0-audit.md`.

### ⏸️ D1 — Customer backfill — Not applicable
Amazon strips all customer PII (email = empty, name = "Amazon customer") without the Direct-to-Consumer Shipping role. Per-customer aggregation is structurally impossible for our data. Skipped honestly.

### ✅ D2 — APlusContent date enrichment
- `pullAPlusContentMetadata` captures Amazon's `updateTime` from the list response
- Populates `submittedAt` for SUBMITTED/APPROVED/PUBLISHED docs, `publishedAt` for PUBLISHED
- Result: 24 of 72 docs now have `submittedAt`

### ✅ D3 — Dashboard route fixes (10+ query sites)
Fixed `dashboard.routes.ts` to use `COALESCE(purchaseDate, createdAt)` for:
- Period totals (current vs previous window)
- OrderItem aggregations joined on Order
- Top-SKU revenue rollup
- Sparkline + per-channel revenue line charts
- Day-of-week × hour-of-day heatmap
- Latent-product detection (no orders in 90d)

Untouched (correctly use their own createdAt):
- SyncError / SyncLog, Return, Refund, PurchaseOrder

### ✅ D4 — /orders endpoint
- `/api/orders/stats` lastOrderAt now sorts by `purchaseDate` (was: random backfilled row)
- Main `/api/orders` already correct, verified

### ⏸️ D5 — Derived data rebuild
- `refreshSalesAggregates` verified correct: 1,938 rows × 566 days × €190,492.46
- `rfm-scoring` cron triggered — no-op (0 Customer rows)
- `true-profit-rollup` cron triggered — no-op (sandbox ads data)

### ⏸️ D6 — AuditLog noise cleanup — Not applicable
AuditLog has only 189 rows. Backfill didn't pollute it.

### ✅ D7 — Verification

**`/api/dashboard/overview?window=7d`:**
- 7 buckets: €999.83 / €464.99 / €299.94 / €869.93 / €420 / €735 / €641.96
- Order series: [7, 4, 4, 8, 6, 9, 9]
- 47 orders current vs 29 prior, +62%

**`/api/dashboard/overview?window=ytd`:**
- 141 day buckets, 98 non-zero
- 417 orders YTD vs 374 prior YTD (+11.5%)
- Realistic pattern: sparse early-year → 7-12 orders/day recent

**`/api/orders/stats`:**
- 2,407 total, 5 pending, 2,150 shipped, 251 cancelled
- `lastOrderAt: 2026-05-20T21:14:55Z` (real recent purchaseDate, not today's createdAt)

---

## Commits

```
20f42698  fix(aplus,orders): event-date enrichment — D2 + D4
2d8c5b78  fix(dashboard): bucket Order metrics by purchaseDate not createdAt — D3
```

## Things you should self-verify in the browser

- Open the home dashboard → KPI cards + sparkline show real spread, not stacked on today
- Open `/orders` → sort/filter behavior matches expectation
- Open A+ content listing → 24 docs show "Submitted on …" with real Amazon updateTime dates

## Operator action items still open

| Item | Resolution |
|---|---|
| Per-customer analytics on Amazon orders | Requires "Direct-to-Consumer Shipping" role from Amazon (separate from Finance role) |
| 5 orders still PENDING with €0.00 | `backfillZeroTotals` method exists; small impact (5 orders), deferred |
| Settlement reports beyond 60 days | Amazon hard-caps listReports at 90 days |
| eBay backfill | Route timeouts; eBay traffic near-zero anyway |
