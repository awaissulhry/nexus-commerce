# Pricing & Repricing

→ [[00 - Nexus Commerce MOC]] | [[10 - Pages & Routes]]

## Overview

Master price setting, per-channel overrides, automated repricing engine, Buy Box tracking, and price change event history.

---

## Price Hierarchy

```
Master Price (Product level)
    │
    ├─► Channel Override (ChannelListingOverride)
    │       (fixed, match-Amazon, percent-of-master)
    │
    ├─► Repricing Rule (automated)
    │       (cron-driven, inventory-elasticity)
    │
    └─► Live Price (ChannelListing.price)
```

---

## Data Models

| Model | Purpose |
|-------|---------|
| `PricingRule` | Master pricing rules (type, conditions, value) |
| `PricingRuleProduct` | Rule → product mapping |
| `RepricingRule` | Automated repricing logic (conditions + actions) |
| `RepricingDecision` | Audit of every repricing decision |
| `PriceChangeEvent` | Unified price history (all sources) |
| `BuyBoxHistory` | Buy Box price tracking per ASIN per marketplace |
| `FxRate` | Daily currency exchange rates |
| `PricingSnapshot` | Point-in-time price snapshot |

---

## Repricing Engine

Cron-driven automated repricing:

| Cron Job | Schedule | Purpose |
|----------|----------|---------|
| `pricing-hourly-refresh.job.ts` | Hourly | Refresh competitive prices |
| `repricing-evaluation.job.ts` | Frequent | Run repricing rule conditions |
| `pricing-watchdog.job.ts` | Continuous | Alert on price anomalies |
| `buy-box-tracking.job.ts` | Frequent | Poll Buy Box ownership |

---

## Repricing Rule Conditions

Rules evaluate:
- Current Buy Box price
- Competitor prices
- Current stock level
- Target ACOS from advertising
- Min/max price bounds
- Marketplace-specific rules

Actions:
- Set fixed price
- Match Buy Box ± offset
- Set as % of master price
- Adjust based on inventory elasticity (bidding engine)

---

## Price History (PH-series)

4 phases shipped 2026-05-30:

| Feature | Detail |
|---------|--------|
| `PriceChangeEvent` timeline | Unified history from all sources |
| Drawer sparkline | Mini chart in product drawer |
| Per-rule observability | Which rule drove each change |
| `/fulfillment/repricing` | Repricing decisions audit view |

---

## Buy Box Tracking

- `BuyBoxHistory` — per ASIN per marketplace
- `buy-box-tracking.job.ts` — polls Buy Box ownership
- Buy Box chip on Amazon Listing Cockpit (AC.9)
- Alert when Buy Box is lost

---

## Bidding Engine Integration

The bidding engine microservice (see [[27 - Bidding Engine Microservice]]) provides:
- **Inventory-elasticity formula** — adjusts price based on stock levels
- Higher stock → more aggressive pricing
- Lower stock → protect margin
- Token-bucket 429 throttling for SP-API price update rate limits

---

## B2B Pricing (BLOCKED)

Amazon Business B2B pricing via SP-API:
- Phase 0 **BLOCKED** — SP-API schema not exposing `audience=B2B`
- Resolution: verify B2B pricing enabled in Seller Central
- Plan: reuse dormant `CustomerGroup` / `ProductTierPrice` rails (from database schema)

---

## Currency Handling

- Primary: EUR (Amazon IT, DE, FR, ES)
- Secondary: GBP (UK), USD (US), etc.
- `FxRate` model — daily rates cached
- Non-EUR orders surface native currency chips in Global Snapshot
- Italian fiscal invoices in EUR

---

## Competitor Price Tracking

Pricing rules reference:
- Amazon Buy Box price (SP-API)
- Repricing decisions reference competitor price at decision time
- `PricingSnapshot` for point-in-time historical view

---

## API Routes (`pricing.routes.ts` — 67.4 KB)

| Route | Purpose |
|-------|---------|
| `GET /api/pricing/rules` | List pricing rules |
| `POST /api/pricing/rules` | Create rule |
| `PATCH /api/pricing/rules/:id` | Update rule |
| `GET /api/pricing/history/:productId` | Price change history |
| `GET /api/pricing/buy-box/:asin` | Buy Box history |
| `GET /api/pricing/repricing/decisions` | Repricing decision log |
| `POST /api/pricing/evaluate` | Manual rule evaluation |

---

## Live Repricing (CE-series)

CE.3 (Commerce Solutions Engine) shipped 2026-05-16:
- Live repricing engine
- Scored routing
- `/fulfillment/repricing` decisions view

---

## Related Notes

- [[27 - Bidding Engine Microservice]] — inventory-elasticity bid formula
- [[05 - Database Schema]] — pricing models detail
- [[11 - Amazon SP-API Integration]] — SP-API price updates
- [[23 - Analytics & Insights]] — profit analytics with pricing data
