# D0 — Date column audit

**Generated:** 2026-05-21
**Method:** grep for `createdAt` in date-filter / time-bucket contexts + cross-reference with which surfaces consume each route

## Severity legend
- 🔴 Wrong — uses `createdAt` (DB-insert time = today for backfill), should use event-date
- 🟡 Tolerable — uses `COALESCE(purchaseDate, createdAt)` (works for our data since `purchaseDate` is populated)
- 🟢 Correct — uses event-date column directly OR `createdAt` IS the event date (e.g., AuditLog, SyncLog, PurchaseOrder)

---

## Per-surface matrix

### 🔴 PRIMARY OFFENDER: `dashboard.routes.ts`

The home dashboard + cross-channel widgets. **15+ Order.createdAt time-bucket queries.**

| Line | What | Should be |
|---|---|---|
| 272, 285 | Order count "this period vs prev" | `purchaseDate` |
| 289, 293 | OrderItem aggregations joined on Order | `order.purchaseDate` |
| 409, 417, 426, 436 | Revenue period comparisons | `purchaseDate` |
| 486, 788, 821, 890, 903, 945 | Raw SQL window filters | `purchaseDate` |
| 879-883, 932-933 | `date_trunc('day', "createdAt")` for line charts | `date_trunc('day', "purchaseDate" AT TIME ZONE 'Europe/Rome')` |

**User-facing impact:** Home dashboard, cross-channel revenue chart, every "last 7 days / 30 days" widget on `/` and `/dashboard`. **This is the screen where you're seeing "all on one day"** — ~98% of widget queries route through here.

### 🟡 Tolerable but inconsistent

| File | Line | Pattern | Fix? |
|---|---|---|---|
| `listings-syndication.routes.ts` | 2032-2036 | `COALESCE(o."purchaseDate", o."createdAt")` | Keep — defensive fallback for legacy rows |
| `pan-eu-distribution.service.ts` | 196 | Same COALESCE pattern | Keep |
| `sales-aggregate.service.ts` | 96, 105-106, 138 | Same COALESCE | Keep |
| `returns.routes.ts` | 48-98 | `Return.createdAt` | ✅ Returns.createdAt IS the event date (Amazon report set it). Leave. |
| `orders-reviews.routes.ts` | 546 | `Order.createdAt` (filter on Review request window) | 🔴 Should be purchaseDate |

### 🟢 Verified correct

| File | Pattern |
|---|---|
| `insights.routes.ts` | Uses `DailySalesAggregate.day` (correctly populated from `purchaseDate`) |
| `orders.routes.ts` | Sub-relations use `transactionDate` for FinancialTransaction |
| `sales-aggregate.service.ts` | The aggregate itself groups by `DATE(COALESCE(o."purchaseDate", o."createdAt"))` — correct |
| `customers.routes.ts` | Uses `firstOrderAt`/`lastOrderAt` for sort/filter — but these are NULL today |
| `audit-log.routes.ts` | Uses `createdAt` — correct, AuditLog rows are immutable + truly created at insert time |
| `sync-logs.routes.ts` | Uses `createdAt` — correct, log entries |
| `fulfillment.routes.ts:8678-8687` | `PurchaseOrder.createdAt` — correct, PO created by operator action |
| `assets.routes.ts:422,457` | `DigitalAsset/ProductImage createdAt` — correct, asset upload time |
| `dashboard.routes.ts:545,550,1922,1925,1951` | SyncLog/CronRun filters — correct (true insert times) |

### 🚨 Data gaps (rows missing entirely, not just wrong column)

| Domain | State | Fix |
|---|---|---|
| `Customer` table | **0 rows** | Re-run O.20 derivation: one Customer per unique email, with firstOrderAt/lastOrderAt from Order.purchaseDate aggregation |
| `Customer.firstOrderAt` / `Customer.lastOrderAt` | NULL (table empty) | Comes free with Customer backfill |
| `APlusContent.submittedAt` / `publishedAt` | NULL (only set during create) | Pull Amazon metadata `updateTime` via second GET per doc |
| `FinancialTransaction` linkage | Only 99 rows for 180d window vs 2,407 orders for 24mo | Expected — Finance API caps at 180d; older orders have no fin-event rows |
| `OrderItem.createdAt = today` | Has no event-date column of its own | Join to Order.purchaseDate in queries (no schema change needed) |

### ⚠ Suspicious data

| Item | Note |
|---|---|
| `SettlementReport` future dates (e.g. `2026-12-05`) | Amazon's "open" settlement window can have endDate in the future. Verify parser doesn't mis-extract; spot-check 2 rawBody values. |
| `SettlementReport.startDate` distribution: `2026-09-03`, `2026-08-04`, `2026-07-03`... | These are settlement window dates (per-cycle), not deposit dates. Verify `depositDate` is what gets used in bank-recon UI. |

---

## Plus things missed in original proposal

| Item | Why |
|---|---|
| **Default `/orders` list sort** | Likely defaults to `createdAt desc` — 1,978 orders bunched today, 429 yesterday. Should default to `purchaseDate desc`. |
| **`/orders` URL filters** | `?since=YYYY-MM-DD` — what column does this filter? Verify. |
| **CSV / Excel exports** | Date columns shown to operator should be purchaseDate-based, not createdAt |
| **AuditLog noise** | 2,407 "Order create" + 2,476 "OrderItem create" entries on today's date. `/sync-logs/events` filtered by today will show ~10k synthetic events. Consider hiding rows where `metadata.source = 'backfill'` from operator-facing views. |
| **Webhook/notification triggers** | Did any "new order" / "first order from customer" / "milestone" notifications fire during backfill? Check NotificationQueue. |
| **OrderRiskScore.lastRiskComputedAt** | Risk scores not computed for backfilled orders. Need a re-run. |
| **Review request automation** | Some auto-mailer logic fires when "order delivered N days ago" — for backfilled orders, this would re-fire emails. Need to flag backfilled orders as "no auto-mailers". |
| **Repricing decisions** | RepricingDecision audit trail — confirm none triggered during backfill (would be spurious decisions on stale data) |

---

## Recommended Phase D1-D7 scope (refined from initial proposal)

### Phase D1 — Customer backfill (1 hour, data-only)
Re-derive Customer rows from Order data:
- One Customer per unique lower(email)
- `firstOrderAt = MIN(purchaseDate)`, `lastOrderAt = MAX(purchaseDate)`
- `totalOrders`, `totalSpentCents`, `channelOrderCounts` aggregates
- Idempotent script

### Phase D2 — APlusContent date enrichment (30 min)
For each of 72 docs: extra `GET /aplus/2020-11-01/contentDocuments/{key}` to extract Amazon's `updateTime` → populate `publishedAt`. Or accept submittedAt=createdAt=today for "imported via metadata pull".

### Phase D3 — Dashboard route fixes (2-3 hours)
- Fix all `dashboard.routes.ts` Order.createdAt → purchaseDate (15+ lines)
- Fix `orders-reviews.routes.ts:546`
- Add `(Europe/Rome)` time zone to day bucketing where it's an operator-facing chart
- Spot-check existing tests; add coverage if missing

### Phase D4 — `/orders` list page fixes (1 hour)
- Default sort by `purchaseDate desc` not `createdAt desc`
- `?since=` filter uses `purchaseDate`
- CSV/Excel exports use `purchaseDate` in date columns

### Phase D5 — Derived data rebuild (1 hour)
- Re-run `refreshSalesAggregates` (already correct — confirm DailySalesAggregate has rows for 2024-05-21 → 2025 distributed)
- Run `rfm-scoring.job` to populate Customer RFM
- Run `true-profit-rollup.job` for Campaign aggregates (likely no-op since ads is sandbox)
- Run `customer-cache.service.normalize` to set totalSpentCents in EUR

### Phase D6 — Cleanup / hide backfill noise (30 min)
- Mark AuditLog rows from backfill: filter `metadata.source = 'backfill'` out of operator views by default
- Suppress notification triggers for backfilled rows (probably already too late but check NotificationQueue)
- Verify no spurious review-request mailers were sent

### Phase D7 — Verification + spot-checks (30 min)
- Open `/` dashboard → "Revenue (30 days)" should show realistic ~€10K-15K (not €194K stacked on today)
- Open `/orders` → list shows orders bucketed by purchaseDate
- Open `/insights/sales` → monthly chart matches verify-backfill.mjs numbers (Oct 2024 = 173 / €12,961.64)
- Open `/customers` → list populated with firstOrderAt/lastOrderAt
- Open `/insights/profit` → uses transactionDate
- Open `/insights/fiscal` → year totals match

**Total estimate revised: 7-8 hours** (was 7-10).

---

## Recommendation for D3 execution order

**Do D5 first.** Re-run `refreshSalesAggregates` to confirm DailySalesAggregate is actually populated correctly per-day. If yes, the `/insights/sales` chart already works → that's a quick win and a known-good baseline. Then attack D3.

Then D1 (Customer backfill) — unlocks `/customers` page.

Then D3 (dashboard fixes) — the largest blob, fixes the home dashboard.

Then D2, D4, D6, D7 in any order.
