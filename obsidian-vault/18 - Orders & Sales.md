# Orders & Sales

→ [[00 - Nexus Commerce MOC]] | [[10 - Pages & Routes]]

## Overview

Multi-channel order ingestion (Amazon/eBay/Shopify), state machine, fiscal compliance, returns/refunds, and real-time order events.

---

## Order Ingestion Flow

```
Amazon SQS ORDER_CHANGE (real-time ~30s)
    ├─► getOrder() [eager — ListOrders withholds OrderTotal]
    │        │
    │        ▼
    │   Order + OrderItem upserted (real prices)
    │
Amazon cron (15-min backstop)
    │
eBay orders-sync cron
    │
Shopify webhook
    │
    ▼
Order table (Prisma)
    │
    ▼
SSE broadcast → /api/orders/events
    │
    ▼
Next.js OrdersList updates
```

---

## Order State Machine

```
PENDING
  │
  ▼
UNSHIPPED (payment confirmed)
  │
  ├─► PARTIALLY_SHIPPED
  │         │
  └─────────▼
         SHIPPED
            │
            ▼
         DELIVERED
            │
            ├─► RETURN_INITIATED
            │         │
            │         ▼
            │     RETURNED
            │
            └─► CANCELLED
```

State per `Order.status` — channel-specific values mapped to canonical states.

---

## Data Models

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `Order` | externalId, channel, status, total, currency | Master order record |
| `OrderItem` | orderId, variationId, qty, price | Line items |
| `OrderNote` | orderId, note | Internal notes |
| `OrderTag` | orderId, tag | For filtering/triage |
| `OrderRiskScore` | orderId, score, factors | Fraud risk |
| `Shipment` | orderId, carrier, trackingNumber | Shipment record |
| `TrackingEvent` | shipmentId, status, timestamp | Carrier updates |
| `Return` | orderId, status, reason | Return record |
| `Refund` | orderId, amount, reason | Refund record |

---

## Orders UI (`/orders`)

OX-series rebuild (16 phases, 19 commits, shipped 2026-05-21):

| Feature | Detail |
|---------|--------|
| FBM/FBA toggle | Switch fulfillment method view |
| Status tabs | Filter by order status |
| Date-range picker | Filter by date |
| Amazon-parity row layout | Matches Seller Central UI density |
| Bulk packing slips | Generate PDFs for multiple orders |
| Sticky action bar | Actions persist while scrolling |
| Dual-VAT contents | Italian regular + reverse-charge VAT |
| Per-package sections | Multi-package shipment breakdown |
| Buyer drawer | Customer details side panel |
| Italian fiscal block | VAT invoice details inline |
| JSON export | Raw order data export |
| `LiveSyncBadge` | SQS connection health indicator |

---

## Global Snapshot (GS-series)

Amazon-style Sales/Open Orders/Buyer Messages widget:
- Mounts at `/orders` top + `/dashboard/overview` top
- Click-to-expand panels with flagged per-marketplace tables
- Drill-through to filtered `/orders`
- Same-day-last-week delta arrow
- SSE auto-refresh
- 8 phases shipped 2026-05-21

---

## Sales Accuracy (SA-series)

5 phases shipped 2026-05-21. Closed €105 accuracy gap:

| Fix | Problem | Solution |
|-----|---------|---------|
| SA.1 | PENDING orders ingested at €0 | Eager `getOrder()` fetches real prices |
| SA.2 | "+N pending verification" annotation | Surface residual PENDING totals |
| SA.3 | Marketplace dropdown | Per-market breakdown |
| SA.4 | Click-to-drill in Global Snapshot | Drilldown to filtered orders |
| SA.5 | Reconciliation banner vs Amazon T+1 | Show gap vs official report |

---

## Data Accuracy (DA-RT series)

20 phases shipped 2026-05-23. Fixed 7 bugs (6 → 0 true drifts across 30-day audit):

| Bug | Fix |
|-----|-----|
| TZ direction | `.14` — `AT TZ 'UTC' AT TZ 'Rome'` (not single AT TZ) |
| Per-unit price | `.15` — use `OrderItem.price`, not aggregate |
| Aggregate tier | `.16` — prefer correct tier for multi-line items |
| ShipmentEventList | `.17` — use correct SP-API endpoint |
| CurrencyAmount | `.18` — `CurrencyAmount` vs `Amount` field names |
| Tax folding | `.19` — fold tax + promotions correctly |
| Settlement pending | `.20` — classify settlement-pending correctly |

5 admin endpoints + 21 unit tests added.

---

## Italian Fiscal Compliance

- `FiscalInvoice` per order — Italian VAT invoice
- `CreditNote` for returns
- Dual-VAT: regular (22% IT VAT) + reverse-charge (B2B EU)
- Per-currency support (EUR primary, GBP/USD/CAD etc. secondary)
- Invoice download: PDF via PdfKit

---

## Multi-Market (MS-series)

7 phases shipped 2026-05-22:
- Cron sweeps all 11 EU Amazon markets in one SP-API call
- DB-backed admin toggle for market enable/disable
- Snapshot uses Amazon "Sales" semantic (includes cancelled/refunded — matches Seller Central tile)
- Non-EUR currencies surface as native chips
- `MarketIngestHealth` widget on `/insights` bottom (collapsible)

---

## Live Sync (LS-series)

- SP-API ORDER_CHANGE via SQS enabled 2026-05-21
- 15-min cron kept as backstop
- `LiveSyncBadge` on `/orders`
- **LS.4–LS.9 deferred:** health tile, DLQ, MCF, ORDER_STATUS_CHANGE migration, eBay verify, observability

---

## Returns & Refunds

- `/fulfillment/returns` — full return workflow
- Return → ReturnItem → Refund chain
- Amazon + eBay returns API integration
- Refund retry cron (`refund-retry.job.ts`)
- Refund deadline tracking cron
- Italian credit note (`CreditNote`) generated on refund

---

## Reviews Integration

From orders, review requests are triggered:
- `ReviewRule` — trigger conditions (e.g. delivered + 7 days)
- `ReviewRequest` — sent per order
- See [[22 - Reviews & Customer Engagement]] for full detail

---

## Related Notes

- [[11 - Amazon SP-API Integration]] — SQS ORDER_CHANGE + getOrder
- [[17 - Inventory & Fulfillment]] — stock reserved by orders
- [[07 - Real-time Architecture]] — order SSE events
- [[23 - Analytics & Insights]] — sales analytics built on orders
- [[22 - Reviews & Customer Engagement]] — review pipeline post-order
