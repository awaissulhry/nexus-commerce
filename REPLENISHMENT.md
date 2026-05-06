# Replenishment system architecture

The `/fulfillment/replenishment` page and its supporting engine, crons, services, and audit tables. Last full sweep: **R.7–R.20 (R.7–R.20 plus the deferred R.8/R.9/R.10)** completed 2026-05-06.

## Why this exists

Xavia operates ~3,200 SKUs primarily on Amazon IT, with auxiliary FBM/FBA exposure across DE/FR/ES/NL plus eBay and a Shopify storefront. A single missed restock blows €1k+ in lost margin per CRITICAL SKU per week; a wrong-priced PO compounds across containers. The replenishment workspace is the operator's single decision surface for "what should I order, from whom, and when, in what currency, paid when, fitting which container."

## Page structure (top to bottom)

| Section | Source | Notes |
|---|---|---|
| Counts pills + filter bar | `/api/fulfillment/replenishment` | URL-state-aware (R.5) |
| `UpcomingEventsBanner` | `/api/fulfillment/replenishment/upcoming-events` | R.13 — saldi / Black Friday prep |
| `ForecastHealthCard` | `/api/fulfillment/replenishment/forecast-health` | R.1 — MAPE buckets |
| `StockoutImpactCard` | `/api/fulfillment/replenishment/stockouts/summary` | R.12 — lost-margin ledger |
| `ForecastModelsCard` | `/api/fulfillment/replenishment/forecast-models/active` | R.16 — model A/B status |
| `ContainerFillCard` | embedded in main list response | R.19 — per-supplier fill % + top-up |
| `CashFlowCard` | `/api/fulfillment/replenishment/cash-flow/projection` | R.20 — 13-week outflow vs inflow |
| `FbaRestockHealthCard` | `/api/fulfillment/replenishment/fba-restock/status` | R.8 — Amazon Restock ingestion |
| Suggestion grid + drawer | main list response | every drawer panel below |

### Drawer panels

- **Channel cover** (R.2) — per-channel days-of-cover when split by FBA/FBM/marketplace.
- **Reorder math** (R.4) — EOQ, safety stock, reorder point, MOQ/case-pack constraints, σ_LT (R.11), landed cost (R.19).
- **Substitution-aware demand** (R.17) — raw vs adjusted velocity + substitution links, inline edit/add/delete.
- **Amazon Restock signal** (R.8) — three-column ours-vs-Amazon diff with classification.
- **Supplier alternatives** (R.9) — ranked candidate suppliers + one-click switch.
- **Recommendation history** (R.3) — ACTIVE / SUPERSEDED / ACTED audit trail.
- **Forecast accuracy** (R.1) — per-SKU MAPE chart.

## Engine flow (`GET /api/fulfillment/replenishment`)

```
0. Load products + ATP + open inbound + reservations         (R.2 / R.18)
1. Aggregate sales (trailing N days) + daily series          (R.1 / R.4)
2. Resolve forecast rows                                      (F.4 / R.16 model routing)
3. Substitution-adjust the daily series                       (R.17)
4. Compute σ_d from adjusted series                           (R.4)
5. Resolve preferred supplier + currency + FX                 (R.4 / R.15)
6. Compute landed-cost path (unit + freight per supplier)     (R.19)
7. computeRecommendation: SS + EOQ + MOQ + case-pack          (R.4 / R.11)
8. Resolve channel-aware urgency                              (R.14)
9. Apply event-prep promotion                                 (R.13)
10. Cross-check FBA Restock signal                            (R.8)
11. Container-fill optimization (per supplier rollup)         (R.19)
12. Diff-aware persist to ReplenishmentRecommendation         (R.3)
13. Auto-PO sweep (cron-only path)                            (R.6)
```

Every step writes audit columns; no state is computed in the UI.

## Audit columns on `ReplenishmentRecommendation`

| Column | Source | Purpose |
|---|---|---|
| `velocity, velocitySource` | R.3 | trailing/forecast switch |
| `urgency, urgencySource, worstChannelKey, worstChannelDaysOfCover` | R.14 | channel-aware urgency |
| `safetyStockUnits, eoqUnits, constraintsApplied, unitCostCents` | R.4 | reorder math |
| `leadTimeStdDevDays` | R.11 | σ_LT used in SS formula |
| `prepEventId, prepExtraUnits` | R.13 | event-driven uplift |
| `unitCostCurrency, fxRateUsed` | R.15 | FX path |
| `rawVelocity, substitutionAdjustedDelta` | R.17 | substitution audit |
| `freightCostPerUnitCents, landedCostPerUnitCents` | R.19 | landed cost |
| `amazonRecommendedQty, amazonDeltaPct, amazonReportAsOf` | R.8 | Amazon cross-check |

## Schemas added by this rebuild

- **R.6**: `AutoPoRunLog` — forensic trail for the auto-PO cron
- **R.7**: `PurchaseOrderStatus` enum extensions (REVIEW/APPROVED/ACKNOWLEDGED) + audit columns
- **R.11**: `Supplier.leadTimeStdDevDays`, `leadTimeSampleCount`, `leadTimeStatsUpdatedAt`
- **R.12**: `StockoutEvent`
- **R.13**: `RetailEvent` integration, `Product.productType`
- **R.16**: `ForecastModelAssignment`, `ReplenishmentForecast.model` unique-key extension
- **R.17**: `ProductSubstitution`
- **R.19**: `SupplierShippingProfile`
- **R.20**: `BrandSettings.cashOnHandCents`
- **R.8**: `FbaRestockReport`, `FbaRestockRow`

## Cron jobs

| Job | Schedule | Service | Purpose |
|---|---|---|---|
| `forecast.job` | 03:30 UTC | F.4 | Holt-Winters per series |
| `forecast-accuracy.job` | 04:00 UTC | R.1 | MAPE bucket recompute |
| `fba-restock-ingestion.job` | 04:00 UTC | R.8 | SP-API Restock report ingest (5 marketplaces) |
| `auto-po-replenishment.job` | 05:00 UTC | R.6 | opt-in auto-PO sweep |
| `lead-time-stats.job` | 06:00 UTC | R.11 | per-supplier σ_LT recompute |
| `stockout-detector.job` | 06:30 UTC | R.12 | StockoutEvent transitions + loss totals |

All crons are default-on with `NEXUS_ENABLE_*_CRON=0` opt-out env vars.

## Routes (replenishment-specific)

```
GET    /api/fulfillment/replenishment                                  list with all audit data
GET    /api/fulfillment/replenishment/:id/forecast-detail              drawer drill-down
POST   /api/fulfillment/replenishment/refresh-aggregates               manual sales-aggregate refresh
POST   /api/fulfillment/replenishment/bulk-draft-po                    multi-select PO creation
POST   /api/fulfillment/replenishment/:id/draft-po                     single-item PO

# R.6
GET    /api/fulfillment/replenishment/auto-po/status                   cron status + last run
GET    /api/fulfillment/replenishment/auto-po/runs                     ledger
POST   /api/fulfillment/replenishment/auto-po/run                      manual sweep with dryRun

# R.7
POST   /api/fulfillment/purchase-orders/:id/transition                 state machine
GET    /api/fulfillment/purchase-orders/:id/audit                      transition history

# R.11
POST   /api/fulfillment/replenishment/lead-time-stats/recompute        manual σ_LT recompute
GET    /api/fulfillment/replenishment/lead-time-stats/status

# R.12
GET    /api/fulfillment/replenishment/stockouts/summary
GET    /api/fulfillment/replenishment/stockouts/events
POST   /api/fulfillment/replenishment/stockouts/sweep
GET    /api/fulfillment/replenishment/stockouts/status

# R.16
GET    /api/fulfillment/replenishment/forecast-models/active
POST   /api/fulfillment/replenishment/forecast-models/rollout
POST   /api/fulfillment/replenishment/forecast-models/pin
POST   /api/fulfillment/replenishment/forecast-models/promote
POST   /api/fulfillment/replenishment/forecast-models/seed-champions

# R.17
GET    /api/fulfillment/replenishment/substitutions/:productId
POST   /api/fulfillment/replenishment/substitutions
PATCH  /api/fulfillment/replenishment/substitutions/:id
DELETE /api/fulfillment/replenishment/substitutions/:id

# R.19
GET    /api/fulfillment/supplier-shipping-profiles/:supplierId
PUT    /api/fulfillment/supplier-shipping-profiles/:supplierId
POST   /api/fulfillment/replenishment/container-fill                   ad-hoc snapshot

# R.20
GET    /api/fulfillment/replenishment/cash-flow/projection
PUT    /api/fulfillment/replenishment/cash-flow/cash-on-hand

# R.8
POST   /api/fulfillment/replenishment/fba-restock/refresh
GET    /api/fulfillment/replenishment/fba-restock/status
GET    /api/fulfillment/replenishment/fba-restock/by-sku/:sku

# R.9
GET    /api/fulfillment/replenishment/products/:id/supplier-comparison
POST   /api/fulfillment/replenishment/products/:id/preferred-supplier
```

## Verify scripts

Each commit ships a verify script that hits the live API. Run individually or in aggregate:

```bash
# Single
API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app \
  node scripts/verify-replenishment-r17.mjs

# Full sweep (R.10)
API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app \
  node scripts/verify-replenishment-all.mjs
```

Pure-function tests (no DB / no API) live alongside their services as `*.service.test.ts`. Run with:

```bash
cd apps/api && npx tsx src/services/<name>.service.test.ts
```

| Service | Tests |
|---|---|
| `replenishment-math.service.test.ts` | EOQ, MOQ, case-pack, safety-stock with σ_LT |
| `forecast-routing.service.test.ts` | hash distribution, cohort assignment |
| `substitution.service.test.ts` | demand crediting, multi-primary sums, clamping |
| `container-pack.service.test.ts` | volumetric weight, FCL allocation, top-up gating |
| `cash-flow.service.test.ts` | term parsing, week math, FX-normalized buckets |
| `fba-restock.service.test.ts` | TSV parsing, cross-check classification |
| `supplier-comparison.service.test.ts` | weighted scoring, urgency-adaptive weights |

## Known gaps (NOT shipped in this sweep)

- **TECH_DEBT #50** — FBA inbound v0 still uses deprecated `putTransportDetails`; v2024-03-20 rewrite pending.
- **TECH_DEBT #51** — no transactional email infra; auto-PO + approval workflow notifications are stubbed.
- **R.16 cohort persistence** — challenger assignments live in `ForecastModelAssignment` but the forecast worker still hardcodes `HOLT_WINTERS_V1`; alternate-model registration is the next step before A/B is meaningful.
- **R.20 inflow proxy** — uses trailing-30d revenue × 7. Future: tie to per-marketplace forecasts so cash-flow and forecast share the same demand model.
- **R.8 SP-API end-to-end** — service is wired but ingestion against live Amazon needs the AMAZON_LWA_* env vars in production. Without them the cron logs FATAL and the page card shows "stale" tiles per marketplace.
