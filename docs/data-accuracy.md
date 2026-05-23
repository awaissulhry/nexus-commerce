# Data Accuracy Reference (DA-RT series)

Operator reference for the systemic data-accuracy guarantees the
`/insights`, `/dashboard`, `/orders`, and `/analytics` surfaces depend
on. Written 2026-05-23 after the DA-RT.1–DA-RT.12 engagement.

If a number on any surface looks wrong, this doc tells you:
1. Which of the three sales-storage layers the surface reads from.
2. Why the three may legitimately disagree (and which is "ground truth").
3. Which cron / push / fallback should have caught the drift.
4. Where to look in code + how to force a reconciliation.

## 1. The 3-store reconciliation model

Every Amazon sale flows through three stores. All three should agree
within tolerance for any (day, marketplace) window after T+7.

| # | Store                                                        | Source                           | Settles |
|---|--------------------------------------------------------------|----------------------------------|---------|
| A | `Order.totalPrice`                                           | Live operator DB                 | T+0     |
| B | `DailySalesAggregate.grossRevenue`                           | Cron-materialised denorm of A    | T+0 + 1 cron tick |
| C | `FinancialTransaction.grossRevenue` (`transactionType='Order'`) | Amazon SP-API ListFinancialEvents | T+1 to T+7 |

Store C is the ground truth once it has settled — it's what Amazon
will pay out on. Store A is what we *think* we sold. Store B is what
the dashboard tiles + insights pages query (denormalised for speed).

### Reconciliation cron

`apps/api/src/jobs/sales-drift-detector.job.ts` runs nightly at 03:30
UTC (after the T+1 report ingest + sales-aggregate refresh). For each
(day, marketplace) window in the lookback (default 7 days) it checks
all 3 pairs and emits `sales.drift.detected` events for any pair whose
absolute delta exceeds `max(€1, 0.5%)`.

Recent windows where Store C hasn't settled yet keep `financialCents=null`
and skip the financial-side pairs — you'll only see order↔aggregate
drift until Amazon's settlement lands.

Gated behind `NEXUS_ENABLE_SALES_DRIFT_DETECTOR=1`. Disable temporarily
with `NEXUS_SALES_DRIFT_LOOKBACK_DAYS=0`.

## 2. Order-status semantic policy

Canonical decision matrix (header comment in
`apps/api/src/services/insights/index.ts`):

| Status      | Counted in sales? | Counted in fiscal? | Counted in profit? | Reasoning |
|-------------|-------------------|--------------------|--------------------|-----------|
| `PENDING`   | Yes (MS.6)        | No                 | No                 | Amazon "Sales" tile semantics include PENDING; fiscal reports don't until invoiced |
| `SHIPPED`   | Yes               | Yes                | Yes                | The default success path |
| `DELIVERED` | Yes               | Yes                | Yes                | Post-shipment state |
| `CANCELLED` | **No**            | **No**             | **No**             | Italian VAT compliance — cancelled = never sold (DA-RT.7) |
| `RETURNED`  | Yes (gross)       | Yes (gross + offsetting credit note) | Net | Returns net out via credit notes, not silent exclusion |

`CANCELLED` exclusion was lost during the DA-RT.3 rescue scramble and
re-added in DA-RT.7. Anything querying `Order` for revenue MUST apply
`status: { notIn: ['CANCELLED'] }`.

## 3. Timezone bucketing

All "per-day" rollups bucket on **Europe/Rome local calendar**, not
UTC. The operator's day starts at 00:00 Rome (CEST = UTC+2, CET = UTC+1).

### SQL

```sql
date_trunc('day', "purchaseDate" AT TIME ZONE 'Europe/Rome')::date AS day
```

### TypeScript

```ts
new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome',
  year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d)
```

`startOfRomeDay()` helper in `sales-aggregate.service.ts` covers the
inverse direction.

GA-RT.1 was a real production bug: sparkline used `d.toISOString().slice(0,10)`
(UTC) while the data rows used `date_trunc(... 'Europe/Rome')` — under CEST
the sparkline shifted by 1 day. Don't mix the two formats.

## 4. The 3-tier revenue waterfall

Implemented in `apps/api/src/services/revenue/compute.ts`. Every callsite
that needs to know "what is this order worth?" uses this helper.

| Tier | Source                                  | Trigger condition                          | Annotation |
|------|-----------------------------------------|--------------------------------------------|------------|
| 1    | `Order.totalPrice`                      | > 0                                        | Confirmed  |
| 2    | `SUM(OrderItem.price × quantity)`       | Tier 1 is 0/null AND all items have price>0 | Confirmed  |
| 3    | `ChannelListing.price × quantity`       | Tier 1+2 fail, listing exists for productId | `*` estimate |
| 3b   | `Product.basePrice × quantity`          | Tier 3 listing missing                     | `*` weak estimate |
| 4    | `0` + `awaitingPrice: true`             | No path produced a positive amount         | "awaiting price" badge |

Tier 4 happens when Amazon withholds `OrderTotal` for a PENDING order
AND `getOrderItems` hasn't returned prices yet. The `amazon-order-items-retry`
cron (DA-RT.9, every 2h) re-fetches `getOrderItems` to push those rows
into Tier 2. The `backfillZeroTotals` push (GS-RT.2/4/5) then promotes
to Tier 1 when Amazon eventually releases the total.

Per memory `project_data_wipe_2026_05_20`: PRESERVE ChannelListing +
Marketplace + ChannelConnection tables in any wipe — Tier 3 falls apart
without them.

## 5. FX folding (multi-currency)

European Amazon markets quote in EUR, but Italian operator can have
orders in GBP (UK), SEK (SE), PLN (PL), etc. The snapshot tile +
insights pages have a currency toggle:

- `?baseCurrency=EUR` — show only EUR orders. Non-EUR are excluded
  from the headline.
- `?baseCurrency=EUR_EQUIV` (default) — fold non-EUR into EUR using
  `FxRate` table (refreshed daily by `pricing-fx-refresh` cron via
  `getFxRate()` in `fx-rate.service.ts`).

`fxMissing` orders (currency present but no FX rate cached) are
**excluded from the rollup** + counted separately. UI surfaces them
as a chip ("+ N orders awaiting FX"). Don't fold them silently — that
masks ingest gaps.

## 6. Cron + env gates

Critical accuracy crons (all OFF by default; enable via Railway env):

| Cron                         | Schedule       | Env gate                                | Purpose |
|------------------------------|----------------|------------------------------------------|---------|
| `sales-aggregate-refresh`    | Hourly         | always on                                | Materialises Store B from Store A |
| `sales-drift-detector`       | 03:30 UTC daily| `NEXUS_ENABLE_SALES_DRIFT_DETECTOR=1`    | 3-way reconciliation (DA-RT.5/10) |
| `amazon-order-items-retry`   | Every 2h       | `NEXUS_ENABLE_AMAZON_ORDER_ITEMS_RETRY=1`| Push Tier 4 → Tier 2 via getOrderItems |
| `amazon-orders-backfill`     | Every 6h       | `NEXUS_ENABLE_AMAZON_BACKFILL=1`         | Push Tier 2 → Tier 1 via getOrder |
| `pricing-fx-refresh`         | Daily          | always on                                | Refresh FxRate cache |
| `amazon-financial-events`    | Daily          | `NEXUS_ENABLE_AMAZON_FINANCIAL_EVENTS=1` | Hydrate Store C |

Per memory `reference_neon_migrations` + `reference_railway_deploy_debug` —
crons read from Railway env, not local `.env`. Verify gate is set after
each deploy: `railway variables list | grep NEXUS_ENABLE`.

## 7. Push-side instrumentation

Beyond crons, the live path:

- SP-API SQS `ORDER_CHANGE` → `apps/api/src/routes/sp-api-notifications.routes.ts`
  → push-side `backfillZeroTotals(orderId)` → SSE `order.changed` event
  (LS-series, 2026-05-21).
- `salesReport.refreshed` event auto-reloads insights portfolio at
  ~03:00 UTC (AL-series).
- `sales.drift.detected` event → operator alert banner (RT.16/17).

Push health surfaced via `PushHealthChip` on `/dashboard` — green =
notifications processed in last 5min; amber = stale; red = nothing
received in 30min.

## 8. Troubleshooting common drifts

### Snapshot tile shows €0 for a market with known sales

1. Check the market is enabled (DB-backed toggle, MS-series).
2. Check `MarketIngestHealth` widget on `/insights` for that market.
3. If healthy but €0, suspect Tier 4 backlog: query
   `SELECT COUNT(*) FROM "OrderItem" WHERE price = 0 AND "createdAt" > now() - interval '7 days'`.
4. Force the retry cron: `POST /api/admin/crons/amazon-order-items-retry/run`.

### Headline disagrees with table-sum on Global Snapshot

Caused by regional fold-vs-raw mismatch. Snapshot tiles convert to
EUR-equiv; per-market rows show native currency. Switch toggle to `EUR`
(strict, exclude non-EUR) to compare apples-to-apples.

### "Partial reconciliation — awaiting prices on N orders"

Amazon withheld OrderTotal on N PENDING orders. The
`amazon-order-items-retry` cron will fix once Amazon returns ItemPrice
in `getOrderItems` (typical 24-48h post-purchase). 13 stuck orders as
of 2026-05-22 are tracked in `OrderItem WHERE price=0` — see PV-RT.4
deferred work for a manual override endpoint.

### `sales.drift.detected` event in operator alerts

Read the `driftPairs[]` payload — it names which pair(s) disagree:
- `order↔aggregate` → aggregate refresh cron is behind; run it manually.
- `order↔financial` → ingest gap, an Order row's totalPrice doesn't
  match what Amazon settled. Investigate the specific orderId.
- `aggregate↔financial` → likely a cascade of the previous two; check
  order pair first.

## 9. Test coverage

- `compute.test.ts` (29 cases) — central revenue helper + shape contracts
- `sales-drift-compare.test.ts` (15 cases) — pair comparison + tolerance + 3-way builder

Total 44 regression tests guard the surfaces. If you change any of the
storage layers, sources, or status semantics in this doc, update those
tests in the same commit.

## 10. Where to look in code

| Concern                  | File                                                          |
|--------------------------|---------------------------------------------------------------|
| Central revenue helper   | `apps/api/src/services/revenue/compute.ts`                    |
| Daily aggregate          | `apps/api/src/services/sales-aggregate.service.ts`            |
| Fiscal report            | `apps/api/src/services/insights/insights-fiscal.service.ts`   |
| Profit report            | `apps/api/src/services/insights/insights-profit.service.ts`   |
| Dashboard tile + FX fold | `apps/api/src/routes/dashboard.routes.ts`                     |
| 3-way drift detector     | `apps/api/src/jobs/sales-drift-detector.job.ts`               |
| Drift pair helpers       | `apps/api/src/jobs/_helpers/sales-drift-compare.ts`           |
| Tier 4 → Tier 2 retry    | `apps/api/src/jobs/amazon-order-items-retry.job.ts`           |
| Tier 2 → Tier 1 backfill | `apps/api/src/services/amazon-orders.service.ts`              |
| FX rate cache            | `apps/api/src/services/fx-rate.service.ts`                    |
| Financial events ingest  | `apps/api/src/services/amazon-financial-events.service.ts`    |
| Order-event SSE bus      | `apps/api/src/services/order-events.service.ts`               |
