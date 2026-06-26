# Amazon SP-API Integration

→ [[00 - Nexus Commerce MOC]] | [[14 - External Services]]

## Overview

Amazon Selling Partner API (SP-API) is the primary marketplace integration. Nexus operates on **11 EU Amazon markets** from a single seller account.

---

## Authentication

| Method | Details |
|--------|---------|
| **LWA (Login with Amazon)** | OAuth2 client credentials for SP-API token exchange |
| **IAM Role Assumption** | AWS IAM role (`AWS_ROLE_ARN`) for STS temporary credentials |
| **Request Signing** | AWS Signature Version 4 (handled in client) |

### Required Environment Variables

```bash
AMAZON_LWA_CLIENT_ID=       # SP-API app client ID
AMAZON_LWA_CLIENT_SECRET=   # SP-API app client secret
AMAZON_REFRESH_TOKEN=       # Seller LWA refresh token
AMAZON_SELLER_ID=           # Seller Central merchant ID
AWS_ACCESS_KEY_ID=          # IAM user key
AWS_SECRET_ACCESS_KEY=      # IAM user secret
AWS_ROLE_ARN=               # IAM role for SP-API
```

---

## SDK Client

| File | Size | Description |
|------|------|-------------|
| `apps/api/src/clients/amazon-sp-api.client.ts` | 49 KB | SP-API wrapper + request signing |
| `apps/api/src/clients/amazon-fba-inbound-v2.client.ts` | 12.5 KB | FBA Inbound Shipment V2 API |

npm package: `amazon-sp-api` v1.2.1

---

## APIs Used

| SP-API Section | Used For |
|----------------|---------|
| **Catalog Items** | Product catalog, ASIN lookup, category browse |
| **Listings Items** | Create/update listings, putListingsItem |
| **Product Types** | Category schema, required attributes |
| **Orders** | Pull orders (ListOrders, getOrder), order items |
| **Feeds** | Flat-file feed submissions, feed status |
| **FBA Inbound V2** | Inbound shipment planning, box contents |
| **Inventory** | FBA inventory levels, AFN quantities |
| **Financial Events** | Settlement reports, transaction events |
| **Returns** | Seller Fulfilled returns |
| **A+ Content** | A+ Content publish + status |
| **Notifications (SQS)** | ORDER_CHANGE push notifications |
| **Amazon Ads** | Sponsored Products/Brands/Display campaigns |

---

## Amazon Markets (11 EU)

| Marketplace ID | Country | Currency |
|----------------|---------|----------|
| A1PA7PVL8GQL4T | 🇩🇪 DE | EUR |
| A1RKKUPIHCS9HS | 🇪🇸 ES | EUR |
| A13V1IB3VIYZZH | 🇫🇷 FR | EUR |
| APJ6JRA9NG5V4 | 🇮🇹 IT | EUR |
| A1F83G8C2ARO7P | 🇬🇧 UK | GBP |
| A21TJRUUN4KGV | 🇮🇳 IN | INR |
| ATVPDKIKX0DER | 🇺🇸 US | USD |
| A2EUQ1WTGCTBG2 | 🇨🇦 CA | CAD |
| A39IBJ37TRP1C6 | 🇦🇺 AU | AUD |
| A2Q3Y263D00KWC | 🇧🇷 BR | BRL |
| A1VC38T7YXB528 | 🇯🇵 JP | JPY |

> Primary market: **Amazon IT** (Italian motorcycle gear brand Xavia). Pan-EU shared ASIN: ONE image set across all markets — per-market main images are impossible.

---

## SQS Real-time Orders

```
Amazon Notifications → SQS Queue
    │
    ▼
amazon-sqs-poll.job.ts
(polls SQS every few seconds)
    │
    ▼
ORDER_CHANGE payload parsed
    │
    ▼
getOrder() called for full order details
(ListOrders withholds OrderTotal — eager getOrder is the fix)
    │
    ▼
Order + OrderItem upserted in Postgres
    │
    ▼
SSE broadcast
```

**Key fix:** `ListOrders` withholds `OrderTotal` — always call `getOrder()` eagerly on ORDER_CHANGE to get real prices. This closed the €105/€651.99 split-brain accuracy issue (GS-RT series).

---

## Flat-File Feeds

Route: `apps/api/src/routes/amazon-flat-file.routes.ts` (**UNTOUCHABLE**)

| Feed Type | Purpose |
|-----------|---------|
| Inventory | Bulk inventory updates |
| Pricing | Bulk price updates |
| Product | New product creation |
| Images | Image assignment (JSON_LISTINGS_FEED) |
| Relationships | Variation parent-child |

Feed status polling: `amazon-flat-file-feed-poll.job.ts`
DB model: `AmazonFlatFileFeedJob`

---

## Image Publishing

- **Amazon images are global per ASIN** (Pan-EU shared ASIN = ONE image set)
- Push path: `JSON_LISTINGS_FEED` (not Trading API)
- Reconcile cron: heals `DONE`-but-`DRAFT` state
- `AmazonImageFeedJob` tracks feed submission status

See [[21 - Marketing & Content]] for image DAM details.

---

## FBA → FBM Flip Guard

A **fail-closed guard** prevents accidental FBA→FBM flips:
- `fba-flip-guard.job.ts` — monitors `FulfillmentMethod` changes
- Gate is ON by default
- Incident resolved 2026-06-18: 64 listings restored via `/admin/amazon/restore-fba`

---

## Listing Accuracy (ALA-series)

7 Amazon listing-accuracy gaps identified and being closed:
- P0: Byte-length enforcement on listing attributes (shipped 2026-06-23)
- Flat-file product creation for NEW products (FFC series, shipped 2026-06-23)

---

## Campaign Deduplication

- Campaigns resolved by `externalCampaignId` ALONE (not name)
- Dedup merged 338 → 169 duplicate campaigns (marketplace short-code vs Amazon ID split — AF.1d)

---

## B2B Pricing (Blocked)

Amazon Business B2B pricing via SP-API is **BLOCKED**:
- SP-API schema not exposing `audience=B2B`
- Requires verifying B2B pricing is enabled in Seller Central

---

## Related Notes

- [[04 - API Layer (Fastify)]] — `amazon.routes.ts` details
- [[06 - Background Jobs & Workers]] — Amazon cron jobs
- [[07 - Real-time Architecture]] — SQS → SSE order flow
- [[16 - Listing Management]] — listing publish via SP-API
- [[18 - Orders & Sales]] — order ingestion detail
- [[20 - Advertising]] — Amazon Ads via SP-API
