# Inventory & Fulfillment

→ [[00 - Nexus Commerce MOC]] | [[10 - Pages & Routes]]

## Overview

Inventory tracks stock from supplier purchase orders through warehouse bins, into FBA/FBM fulfillment, and back via returns. Supports lot tracking for EU GPSR compliance (motorcycle helmet recalls).

---

## Fulfillment Methods

| Method | Code | Description |
|--------|------|-------------|
| FBA | `FulfillmentMethod.FBA` | Amazon fulfills from their warehouse |
| FBM | `FulfillmentMethod.FBM` | Seller fulfills from own warehouse |

Per `ChannelListing.fulfillmentMethod` — can differ per channel/marketplace.

**FBA → FBM Flip Guard (Incident 2026-06-18):**
- Fail-closed guard prevents accidental flips
- `fba-flip-guard.job.ts` monitors changes
- Incident: 64 listings flipped to FBM; restored via `/admin/amazon/restore-fba`
- Gate is **ON** by default

---

## Stock Architecture

```
Supplier → PurchaseOrder → InboundShipment → Warehouse
                                                  │
                              ┌───────────────────┤
                              │                   │
                           StockBin           StockLevel
                        (physical location)   (total qty)
                              │                   │
                          StockBinQuantity    StockMovement
                         (qty per bin)        (audit trail)
                              │
                         StockReservation
                         (soft/hard reserve)
                              │
                         StockCostLayer
                         (FIFO cost layers)
```

---

## Stock Models

| Model | Purpose |
|-------|---------|
| `StockLevel` | Current quantity per variation per warehouse |
| `StockMovement` | Audit trail of every stock change |
| `StockBin` | Physical bin location in warehouse |
| `StockBinQuantity` | Quantity per bin per variation |
| `StockReservation` | Soft/hard stock holds for orders |
| `StockCostLayer` | FIFO cost layers for inventory valuation |
| `StockLog` | System stock log entries |

---

## ATP (Available to Promise)

```
ATP = StockLevel.qty
    - StockReservation.qty (hard reservations)
    - StockReservation.qty (soft reservations, within window)
    + InboundShipment.qty (expected arrivals)
```

Calculated in `inventory/` service layer.

---

## Lot Tracking (L-series, EU GPSR)

5 commits 2026-05-09:
- Schema + service + API + recall workflow + UI
- **Purpose:** EU GPSR compliance for motorcycle helmet recalls
- `Lot` model: lotNumber, expiryDate, variationId
- `lot-expiry-alerts.job.ts` — alert before expiry
- `/fulfillment/stock` — lot management UI

---

## Serial Number Tracking

`SerialNumber` model: serial number per product variation  
Used for high-value items requiring serialisation.

---

## Bin Management

- `StockBin` — physical locations in warehouse (codes like A1-01)
- `StockBinQuantity` — quantity per bin
- Bin put-away workflow in `/fulfillment/inbound`

---

## FBA Inventory

| Model | Purpose |
|-------|---------|
| `FBAShipment` | FBA inbound shipment tracking |
| `FbaInventoryDetail` | FBA inventory snapshot per SKU |
| `FbaInventoryAdjustment` | Adjustments from Amazon |
| `FbaReimbursement` | Reimbursements for lost/damaged inventory |

**FBA Inbound V2 API** (`amazon-fba-inbound-v2.client.ts`):
- Inbound shipment planning
- Box contents submission
- Shipment status polling

---

## Replenishment

`/fulfillment/replenishment`:
- `ReplenishmentForecast` — demand forecast per SKU
- `ForecastModelAssignment` — which model for each SKU
- `ForecastAccuracy` — model accuracy tracking
- Auto-PO creation when stock drops below reorder point
- Lead-time tracking per supplier

### Replenishment Wave 9 (W9-series)

`ReplenishmentWorkspace.tsx` down from ~4,760 lines to 1,455 lines:
- File split into 25+ `_shared/` modules
- Shipped 2026-05-10

---

## Returns

`/fulfillment/returns` (`returns.routes.ts` — 105 KB):
- Return workflow: created → received → inspected → restocked/disposed
- `Return` → `ReturnItem` → `Refund`
- Integration with Amazon/eBay returns APIs
- Italian fiscal credit note (`CreditNote`) generation

---

## Channel Stock Events (CS-series)

Closed TECH_DEBT #43 (2026-05-09):
- `ChannelStockEvent` — records stock changes from channel webhooks
- Shopify + eBay webhook ingesters
- `/fulfillment/stock/channel-drift` — triage UI
- Prevents silent overselling on eBay and Shopify

---

## FNSKU Labels (FN-series, 10 phases)

All phases shipped 2026-05-23:

| Phase | Feature |
|-------|---------|
| FN.1 | Correctness |
| FN.2 | FBA compliance |
| FN.3 | Inbound handoff |
| FN.4 | Capacity / safety / streaming |
| FN.5 | Scan + keyboard + multi-select + drag |
| FN.6 | Template polish |
| FN.7 | SVG + ZPL + crop marks |
| FN.8 | Parity audit + operator docs |
| FN.9 | Extras + topbar polish |

Output formats: ZPL (thermal printer), SVG, PDF with crop marks.

---

## Inbound Shipments

- FBA inbound: `FBAShipment` model + FBA Inbound V2 API
- Internal inbound: `InboundShipment` model
- Bin put-away after receiving
- `/fulfillment/inbound` route

---

## Fulfillment Per Channel (FCF-series)

`ChannelListing.fulfillmentMethod` — per channel × marketplace:
- FCF.1 ✅: FBA on Amazon, FBM on eBay via split-inventory
- Prevents duplicate listing creation

---

## Italian Fiscal Compliance

- `FiscalInvoice` — Italian VAT invoice per order
- `CreditNote` — for returns/refunds
- Dual-VAT support: regular + reverse-charge
- Multi-currency + VAT in stock analytics
- `/orders/invoices` — invoice list and download

---

## Work Orders

`WorkOrder` model:
- Type: PICK, PACK, RECEIVE, COUNT, TRANSFER
- Assigned to warehouse operator
- Status: OPEN, IN_PROGRESS, COMPLETED

---

## Real-time Fulfillment Events (F-RT series)

4 phases shipped 2026-05-22:
- **F-RT.1:** `useInboundEvents` hook + mounted on stock/replen/returns/POs
- **F-RT.3:** Overview full reactivity
- **F-RT.4:** RoutingLog tail-f
- **F-RT.5:** RepricingDecisions tail-f

---

## Related Notes

- [[05 - Database Schema]] — all inventory/fulfillment models
- [[18 - Orders & Sales]] — order triggers stock reservations
- [[11 - Amazon SP-API Integration]] — FBA Inbound V2 API
- [[06 - Background Jobs & Workers]] — stock cron jobs
