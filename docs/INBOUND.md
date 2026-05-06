# Inbound shipments — architecture + operations guide

This document describes the inbound surface as it stands after the H rebuild (2026-05-06). Audience: engineers maintaining the system + operators using `/fulfillment/inbound`.

## What is "inbound"

Anything that adds units to your warehouse stock. Four shipment types:

- **SUPPLIER** — physical goods from a vendor; usually tied to a PurchaseOrder.
- **MANUFACTURING** — output from a contract manufacturer; usually tied to a WorkOrder.
- **TRANSFER** — moving stock between your own warehouses.
- **FBA** — sending stock TO Amazon FBA (decrements `IT-MAIN`, eventually shows up at `AMAZON-EU-FBA` via the FBA inventory poll). Note: **FBA inbound is the only type where stock goes OUT of your warehouse**, but it lives in the same model because the lifecycle (plan → ship → in transit → received at FC) mirrors a real inbound from your POV.

## Data model

Three tables form the inbound surface:

```
InboundShipment ──< InboundShipmentItem ──< InboundReceipt (event log)
                              │
                              └─< InboundDiscrepancy
InboundShipment ──< InboundShipmentAttachment
InboundShipment ──< InboundDiscrepancy (ship-level)
```

- **InboundShipment.status** — state machine: DRAFT → SUBMITTED → IN_TRANSIT → ARRIVED → RECEIVING → PARTIALLY_RECEIVED → RECEIVED → RECONCILED → CLOSED, plus CANCELLED at any step. Auto-transitions on receive + discrepancy resolution.
- **InboundShipmentItem.quantityReceived** — cached `SUM(InboundReceipt.quantity)`. The receipts table is the source of truth — H.0b made this an event log so double-clicks can't double-stock. Always update via the receive endpoint with an `idempotencyKey`; never write `quantityReceived` directly.
- **InboundDiscrepancy** — captures shorts/overs/damages/late/cost-variance. Ship-level (no `inboundShipmentItemId`) for issues that span the whole delivery, line-level when tied to a specific item.

### H.16 compliance fields

- `Product.hsCode` (master data, indexed) — customs classification.
- `Product.countryOfOrigin` (master data) — ISO-2 country.
- `InboundShipmentItem.lotNumber` (per-line, indexed) — for safety-recall lookups via `GET /api/fulfillment/inbound/lots/:lotNumber`.
- `InboundShipmentItem.expiryDate` (per-line) — for products with shelf life.

## Key flows

### Receive

`POST /api/fulfillment/inbound/:id/receive`

- Body: `{ items: [{ itemId, quantityReceived, qcStatus?, idempotencyKey?, photoUrls? }] }`
- **Cumulative-target semantics**: `quantityReceived` is the new total, not a delta. This makes double-clicks safe — same value = no-op.
- **QC-aware stock application**: PASS or unset → applies stock movement; FAIL/HOLD → logs an `InboundReceipt` but no stock churn (units land in QC quarantine).
- **Auto-transition**: when `Σ quantityReceived == Σ quantityExpected`, status moves to RECEIVED. When less, PARTIALLY_RECEIVED.
- **Stock direction**: `+quantity` for SUPPLIER/MANUFACTURING/TRANSFER (stock comes IN); `-quantity` for FBA (stock goes OUT to Amazon).

### Bulk receive (H.10a)

`POST /api/fulfillment/inbound/receive-candidates?sku=<sku>`  
`POST /api/fulfillment/inbound/:id/receive` (existing)

The bulk receive modal is a scan-loop:
1. Operator scans/types a SKU.
2. Frontend hits `receive-candidates` to find every open `InboundShipmentItem` with that SKU.
3. If exactly one match, auto-applies `+1`; multiple matches show a picker; zero matches surfaces "no open shipment expects this SKU".
4. Input refocuses for the next scan.

Bluetooth scanners + keyboards both work. Session log shows the last 10 scans for live throughput visibility.

### FBA send-to-Amazon (H.8a–H.8d)

Wired against real SP-API v0:

- **createInboundShipmentPlan** ✓ (H.8a) — works.
- **getLabels** ✓ (H.8b) — works (FNSKU / carton / pallet labels via Amazon CDN URL).
- **putTransportDetails** ⚠ (H.8c) — **deprecated by Amazon**. Returns 400 with a v2024-03-20 migration note. See TECH_DEBT #50; transport booking must currently be completed in Seller Central.
- **getShipments** ✓ (H.8d) — works. 15-min cron polls and reconciles local FBAShipment.status from Amazon.

### Cost capture (H.11)

`PATCH /api/fulfillment/inbound/:id/costs`

- Per-line `unitCostCents` + ship-level shipping/customs/duties/insurance + exchangeRate.
- `GET /api/fulfillment/inbound/:id` returns a computed `landedCost` block: goodsCents (Σ unitCost × qty) + overhead.

### QC queue (H.12)

`GET /api/fulfillment/inbound/qc-queue`

Cross-shipment view of every line currently in FAIL/HOLD on a non-CLOSED shipment. KPI strip surfaces a count; clicking opens a modal where operators can release holds inline (which calls the existing `release-hold` endpoint).

### Discrepancy report PDF (H.17)

`GET /api/fulfillment/inbound/:id/discrepancies/report.pdf`

Generates a one-page A4 PDF summarizing every discrepancy on a shipment. Operator forwards to supplier via their own mail client — automated email is TECH_DEBT #51 (no email infra in Nexus yet).

## Real-time (H.14)

`GET /api/fulfillment/inbound/events`

SSE stream pushes lightweight `{ type, shipmentId, ts }` events on:

- `inbound.created`
- `inbound.updated` (status, costs)
- `inbound.received`
- `inbound.discrepancy`
- `inbound.cancelled`

Frontend subscribes once on mount and refreshes the list + KPIs (debounced 250ms) on any event. 30s polling timer is kept as a fallback for environments where SSE is buffered/blocked.

## Saved views (H.10b)

`GET /api/saved-views?surface=inbound` (existing endpoint, new surface).

Per-user named filter snapshots. Default view auto-applies on first load when URL is blank. Reuses the SavedView model (one default per user per surface, enforced at the API layer).

## Carrier registry (H.15)

`GET /api/fulfillment/carriers/inbound` — list of supported carriers with public tracking-URL templates. 12 carriers covered (BRT, POSTE, GLS, SDA, TNT, DHL, UPS, FEDEX, DSV, DPD, Chronopost, OTHER). No paid carrier API integrations — public deeplinks only.

`POST /api/fulfillment/carriers/inbound/validate-tracking` — informational format check (e.g. UPS = `1Z` + 16 alphanumeric). Permissive for unknown carriers.

## Supplier scorecard (H.13)

`GET /api/fulfillment/suppliers/:id/scorecard?windowDays=365`

Per-supplier rolling metrics:

- Lead time (avg/median/max observed vs. supplier's contractual `leadTimeDays`).
- On-time % (arrivedAt ≤ expectedAt).
- Defect rate ((FAIL + HOLD units) / total received).
- Open POs.
- Spend (Σ PurchaseOrder.totalCents in window).

Backend-only this rebuild — UI integration into the supplier detail page is deferred until there's enough PO history to make the numbers meaningful.

## Background jobs

- **Reservation sweep** — every 5 min, releases expired PENDING_ORDER reservations.
- **Late shipment auto-flag** (H.5) — every 6h, scans non-terminal inbounds past expectedAt + 2 days and creates a `LATE_ARRIVAL` discrepancy if one doesn't exist. Idempotent.
- **FBA status poll** (H.8d) — every 15 min, batches non-terminal FBAShipment IDs into SP-API getShipments and mirrors Amazon's authoritative status.
- **FBA inventory sync** — every 15 min (existing), calls SP-API getInventorySummaries and updates Product.totalStock.

All crons are default-on; opt out via `NEXUS_ENABLE_*_CRON=0` env vars.

## TECH_DEBT pointers

- **#50 🔴** — FBA Inbound v0 putTransportDetails deprecated. Migrate to v2024-03-20.
- **#51 🟡** — No transactional email infrastructure. Discrepancy report download-only until an email provider is wired.

## Verification

```bash
API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app \
  node scripts/verify-inbound-all.mjs
```

Runs 19 individual verify scripts in sequence (~2–3 min on a warm Railway instance). Each script is also runnable standalone — pattern is `scripts/verify-inbound-h<N>.mjs`. Three-branch validation pattern (503 / 200 / 500-with-domain-error) is used for SP-API endpoints; the rest follow shape + edge-case validation.

## Operating notes

- **Mobile receive flow** at `/fulfillment/inbound/:id/receive` is touch-friendly (12px+ targets, BT scanner-friendly inputs, native camera capture for proof photos via `<input capture=environment>`).
- **Drawer** at `?drawer=<id>` is the desktop receive surface — multi-section with QC release + photo upload + discrepancy composer + landed cost editor.
- **Camera barcode scan** via `BarcodeDetector` API on Chrome Android only; falls back to manual SKU entry elsewhere.
