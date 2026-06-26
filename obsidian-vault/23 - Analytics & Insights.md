# Analytics & Insights

→ [[00 - Nexus Commerce MOC]] | [[10 - Pages & Routes]]

## Overview

Full analytics suite: sales, profit, ads performance, portfolio, customer RFM, inventory, anomaly detection, scenario modeling, AI brief, and real-time live analytics.

---

## Insights Hub (IH-series)

All 16 phases shipped 2026-05-20 (14 commits). Route: `/insights`

| Section | Route | Purpose |
|---------|-------|---------|
| Sales | `/insights/sales` | Revenue, units, daily aggregates |
| Profit | `/insights/profit` | COGS, fulfillment costs, ads spend, margin |
| Ads | `/insights/ads` | ACOS, ROAS, impressions, conversions |
| Products | `/insights/products` | SKU health, velocity, ABC rank |
| Customers | `/insights/customers` | RFM segmentation, churn prediction |
| Inventory | `/insights/inventory` | Stock levels, forecast accuracy |
| Fiscal | `/insights/fiscal` | Italian VAT analytics, settlement summary |
| Anomalies | `/insights/anomalies` | AI-detected sales spikes/dips |
| Scenarios | `/insights/scenarios` | What-if pricing + inventory changes |
| AI Brief | `/insights/ai-brief` | Automated daily business brief (Gemini) |
| Builder | `/insights/builder` | Custom dashboard builder |
| Exports | `/insights/exports` | Data export (CSV, Excel, PDF) |
| Live | `/insights/live` | Real-time dashboard (SSE) |
| Notebook | `/insights/notebook` | Ad-hoc analytics notebook |

---

## Global Snapshot Widget (GS-series)

Amazon-style Sales/Open Orders/Buyer Messages widget:
- Mounts at `/orders` top + `/dashboard/overview` top
- Per-marketplace table with flagged items
- Same-day-last-week delta arrow
- Click-to-expand panels
- Drill-through to filtered `/orders`
- SSE auto-refresh

### Accuracy fix (GS-RT series, 5 phases):

| Fix | Problem |
|-----|---------|
| GS-RT.5 | Backfill script for historical data |
| GS-RT.2 | Periodic cron for ongoing accuracy |
| GS-RT.4 | ORDER_CHANGE push-side eager `getOrder` |
| GS-RT.1 | Per-marketplace pending estimate in table |
| GS-RT.3 | Partial-reconciliation status |

---

## Analytics Live (AL-series)

4 phases shipped 2026-05-21 — SSE-reactive dashboards:

| Location | SSE Event | Update |
|----------|-----------|--------|
| `/insights` hub | `order.created` | Revenue counters |
| `/fulfillment/stock` | `stock.updated` | Stock levels |
| `/analytics/portfolio` | `order.created` | Portfolio metrics |

- 2-second debounce on SSE events before UI update
- Portfolio dual-source toggle: live preview vs Amazon T+1 official report
- `salesReport.refreshed` event auto-reloads portfolio at ~03:00 UTC

---

## Sales Report Accuracy

Amazon T+1 vs Nexus live discrepancy:
- Amazon reports are T+1 (previous day total)
- Nexus shows live running total (includes PENDING orders at their real prices)
- Reconciliation banner shows gap vs T+1 official report
- `sales-report-ingest.job.ts` downloads S3 report nightly

---

## Product Analytics (PA-series)

4 phases shipped 2026-05-16:

| Phase | Feature |
|-------|---------|
| PA.1 | Analytics API (`/api/analytics/*`) |
| PA.2 | Quality snapshots |
| PA.3 | SKU analytics tab on product editor |
| PA.4 | Portfolio view (`/insights/products`) |

---

## Profit Analytics

Components of profit calculation:

```
Revenue (from orders)
  − COGS (StockCostLayer FIFO cost)
  − Amazon fees (settlement reports)
  − FBA fulfillment fees
  − Advertising spend (AmazonAdsDailyPerformance)
  − Shipping costs (Shipment)
  = Gross Profit

  / Revenue
  = Gross Margin %
```

Model: `ProductProfitDaily` — daily profit per SKU.

---

## Forecasting

Models:
- `ReplenishmentForecast` — demand forecast per SKU
- `ForecastModelAssignment` — which model applies to each SKU
- `ForecastAccuracy` — historical accuracy tracking
- `DailySalesAggregate` — daily aggregates used as input

Cron: `forecast-accuracy.job.ts`, `abc-classification.job.ts`

### ABC Classification

- **A items:** Top 20% of SKUs driving 80% of revenue
- **B items:** Next 30%
- **C items:** Remaining 50%
- Updated by `abc-classification.job.ts`
- Used in replenishment priority ordering

---

## Anomaly Detection

`/insights/anomalies`:
- Sales spike detection: >2σ above rolling average
- Sales dip detection: >2σ below rolling average
- Stock-out risk: ATP < safety stock
- Price anomaly: >20% deviation from 30-day average
- Gemini AI generates natural-language explanations

---

## Scenario Modeling

`/insights/scenarios`:
- `Scenario` + `ScenarioRun` models
- What-if: change price → impact on revenue/profit/Buy Box
- What-if: increase ad spend → impact on ACOS/conversion
- What-if: reorder more stock → impact on stock-out risk

---

## Market Ingest Health

`MarketIngestHealth` widget on `/insights` bottom (collapsible):
- Per-marketplace ingestion status
- Last successful sync time
- Error rate
- Data freshness indicator

---

## Italian Fiscal Analytics

`/insights/fiscal`:
- VAT collected by period
- Settlement report reconciliation
- Italian invoice totals
- Revenue by marketplace currency + EUR equivalent

---

## Key Analytics Models

| Model | Purpose |
|-------|---------|
| `DailySalesAggregate` | Daily revenue/units rollup |
| `AmazonAdsHourlyPerformance` | Hourly ad metrics |
| `AmazonAdsDailyPerformance` | Daily ACOS/ROAS |
| `AmazonAdsSearchTerm` | Search term report |
| `ProductProfitDaily` | Per-SKU daily profit |
| `ReplenishmentForecast` | Demand forecast |
| `ForecastAccuracy` | Model accuracy |
| `Scenario` / `ScenarioRun` | What-if analysis |

---

## Related Notes

- [[18 - Orders & Sales]] — order data feeds analytics
- [[20 - Advertising]] — ad performance data
- [[17 - Inventory & Fulfillment]] — inventory data
- [[22 - Reviews & Customer Engagement]] — customer RFM data
- [[07 - Real-time Architecture]] — SSE for live analytics
- [[11 - Amazon SP-API Integration]] — settlement reports
