# FP8 — Shipping: page-cycle spec (awaiting Owner approval)

Written 2026-07-05 on FP7's approval. Gate 1 of the FP8 double gate — nothing below is built until the Owner approves. Seeds: `F0-IA.md` §2, PLAYBOOK §11-FP8, `FD6` (Sendcloud confirmed, tracking-poll boundary empirical), and the Sendcloud-2-3-clicks / ShipStation-Create+Print verdicts in `F0-TEARDOWN.md`. **This is the last leg of the golden flow.** FP6 packs a garment and flips the order **READY**; FP4 left `READY→SHIPPED→DELIVERED` as manual stopgaps. FP8 makes them real: a label bought in two clicks, its cost and tracking captured, the tracking shared back into the same Gmail thread, and the order driven **SHIPPED → DELIVERED** by real carrier events. The `CarrierAdapter` scaffolding from F1 comes alive.

## Purpose (one sentence)

Turn a **Ready** order into a shipped parcel — pick a parcel preset, see live rates (cheapest pre-selected), **buy-and-print** a label in two clicks, share the tracking into the customer's Gmail thread with one click, and let the worker's tracking poll drive the order **SHIPPED → DELIVERED** — so the moment an order leaves the building is owned end-to-end, at $0 infrastructure.

## The Sendcloud reality (the one caveat this cycle turns on)

The Owner **has not connected Sendcloud yet** (deferred since F1; FD6 confirms the account exists at Xavia and the free *Unstamped-letter* method tests the whole flow at €0). Two consequences, both designed for:

1. **We build behind the adapter, verify with a fake.** FP8 ships a `FakeCarrierAdapter` (deterministic, zero-network) that the resolver selects whenever **no `CarrierAccount` is connected** (and always on the `:3199` verify build). It returns canned rates, a fake tracking number, a real one-page PDF, and a scriptable tracking progression — so the **entire** flow (rates → buy → label → timeline → order flips → delivered) is provable headless without a live account or a cent spent. The real `SendcloudAdapter` runs the instant the Owner connects.
2. **The live label is the Owner's gate step** (exactly like the live email send in FP1/FP3). At gate-2 the Owner connects Sendcloud in Settings › Integrations (the F1 wizard + probe already exist), then buys **one real €0 unstamped-letter label** to confirm the live path. **Re-run the capability probe at build start** — if the plan gates tracking polls (Growth boundary, per FD6), labels still work and tracking degrades to manual with a flagged Finding; nothing blocks.

**Automated tests never buy a real label or send a real email** (platform rule, PLAYBOOK §10) — the fake adapter and Owner-initiated sends honour that.

## Scope

**IN (FP8):**
- **The `/shipping` workspace** — a **Ready-to-ship queue** (orders in state READY with no open shipment) and an **In-flight** list (shipments LABEL_PURCHASED/IN_TRANSIT with live tracking status). Toolbar: search, carrier-account status chip, **Day-sheet** (today's parcels manifest), Export.
- **Two-click buy-and-print** on an order (rail panel, reachable from `/shipping` and the FP4 order detail): **parcel preset** (S/M/L from `shipping.parcelPresets` AppSetting, weight+dims; editable) → **rates** (adapter `getRates`, cheapest pre-selected, cost grain-gated) → **Confirm & print** → creates a `Shipment` (LABEL_PURCHASED), stores the label PDF **locally** ($0 infra) behind a guarded stream route, captures trackingNumber/URL/costCents, and **flips the order READY → SHIPPED** (the FP4 stopgap made real) + writes a timeline event.
- **Ship-to capture** — Party has no stored address today; the buy panel captures the destination (name, street, city, postal, country, phone), **prefilled** from the party's canonical address (`Party.addressJson`) or their most recent shipment, **saved back** to the party on purchase, and **snapshotted** onto the shipment (`Shipment.shipToJson`) so a later address edit never rewrites a bought label.
- **Tracking timeline + order drive** — a shipment's `TrackingEvent`s render on the order's ONE-TIMELINE; the **worker polls** in-flight shipments (15–30 min, in-flight only, via `pollTracking`), appends events, updates `Shipment.state`, emits outbox/SSE, and **flips the order SHIPPED → DELIVERED** on a delivered event. (Poll is read-only — safe to automate; the fake adapter drives a scripted progression for verify.)
- **Share tracking in the thread** — one-click **"Share tracking"** composes a bilingual, cost-free reply (tracking #, link, carrier) and sends it into the order's `conversationId` Gmail thread via the FP1 reply pipeline (MIME In-Reply-To/References). **Owner-initiated, never silent** (the send-guard); if the order has no linked thread, the panel says so and offers copy-to-clipboard.
- **Void a label** — `labels.void` cancels a shipment before dispatch (adapter `cancelShipment`), returns the order to READY, records a compensating timeline event.
- **Day-sheet manifest** — a PDF of today's purchased parcels (for the driver/handover), and **pickup booking** as a **capability-gated** panel — book if the probe says the carrier supports it (BRT ≥5 parcels etc.), otherwise a "booked outside the system" checkbox that records intent without blocking (never gate the Owner on a carrier rule).

**OUT (named, so the boundary is explicit):**
- **Multi-carrier beyond Sendcloud** — MyDHL is the documented second adapter (FD6); FP8 implements Sendcloud + the fake. The interface is carrier-agnostic so a second adapter is additive later.
- **Returns / RMA** — return authorization + return labels are rework conversations from the thread (PLAYBOOK verdict); a minimal return-label reuse is a later cycle, not this one.
- **Full multicollo (multi-parcel per shipment)** — v1 is **one parcel per shipment**; a size-run that ships in N boxes buys N shipments (bulk-buy is in scope, true multicollo manifests are not).
- **Fully-automatic tracking email** — v1 shares tracking on the Owner's click; background auto-send on a poll event is deferred behind an explicit future opt-in setting (respects the send-guard).
- **Rate shopping across accounts / contract negotiation, customs (CN22/CN23) docs, insurance** — display service + cost only; customs paperwork and insured value are later concerns (EU-domestic-first).
- **A Contacts address editor UI** — FP8 *captures and persists* `Party.addressJson` at pack time so the next order prefills; a dedicated address field on the Contacts page is a later polish (flagged, not built here — no FP5 page changes).

## Layout

```text
/shipping:
  toolbar: search · carrier chip (Connected: Sendcloud ▸ / Not connected — Connect) · [Day-sheet] · Export
  READY TO SHIP (orders READY, no open shipment):  order · party · promised · [Buy label ▸]
  IN FLIGHT (shipments):  order · carrier/service · tracking# · status pill · cost* · [▸ detail]
BUY PANEL (rail on an order):  parcel preset [S|M|L|custom] · ship-to (prefilled, editable)
  → rates (cheapest ✓, cost*) → [Confirm & print]  → label PDF opens
SHIPMENT DETAIL (drawer):  tracking timeline · [Share tracking in thread] · [Download label] · [Void]  (before dispatch)
DAY-SHEET (modal/print):  today's parcels → manifest PDF · pickup panel (capability-gated)
```
`*` = grain-gated (shipment cost / rate money behind `financials` view; tracking status/number are not financial).

## Component reuse

| Region | Components |
|---|---|
| Queues | `DataGrid`, `Pill` (shipment-state chips), `Input` search, the FP4 tab pattern, `.factory-page` fill + `factory-grid-grow-N` |
| Buy panel / detail | `Drawer`, `Card`, `RadioCard` (parcel preset), `Modal`, `useToast`, freshness dot |
| Tracking on order | the FP4 ONE-TIMELINE (`src/lib/orders/timeline.ts`) — add shipment/tracking event kinds |
| Reply into thread | the FP1 pipeline (`src/lib/google/mime.ts` + the quotes/[id]/send shape) — cost-free body |
| Label PDF | `pdfkit` (already a dep from FP3) for the fake label + the day-sheet manifest; real label PDF comes from Sendcloud base64 |
| States | `Skeleton`, `EmptyState`, carrier-not-connected banner |

## Data & API

**Additive migration `fp8_shipping`** (honest — Shipment/Party lack address + parcel fields): `Shipment.shipToJson Json?`, `Shipment.parcelJson Json?`, `Shipment.labelFormat String?`; `Party.addressJson Json?` (remembered ship-to, prefill source). All existing shipping models (`Shipment`, `TrackingEvent`, `CarrierAccount`, `Pickup`, `ShipmentState`) ship as-is from F1. **No new permissions** — `pages.shipping`, `labels.purchase`, `labels.void` all seeded. (After migrate + generate, **restart `:3100`** — PLAYBOOK §13.6b.)

**Carrier adapter (`src/lib/carriers/`, factory-owned — extend, don't touch web/api):** extend `types.ts` with the operational contract and implement two adapters + a resolver.

```ts
interface CarrierAdapter {                       // sibling to the F1 CarrierConnector (connect/probe)
  getRates(input: ShipInput): Promise<Rate[]>;   // advisory; cheapest pre-selected
  createShipment(input: ShipInput, rate: Rate): Promise<LabelResult>; // → {trackingNumber, trackingUrl, labelPdfBase64, service, costCents}
  cancelShipment(ref: string): Promise<void>;    // void before dispatch
  pollTracking(numbers: string[]): Promise<TrackingUpdate[]>; // batched, read-only
}
resolveAdapter(): real SendcloudAdapter iff a connected CarrierAccount exists; else FakeCarrierAdapter (verify / no-account).
```

**Pure module (tested — the risk lives here):** `src/lib/shipping/`
- `shipment-state.ts` — `mapCarrierStatus(raw) → ShipmentState` (carrier status strings → CREATED/IN_TRANSIT/DELIVERED/EXCEPTION), `deriveShipmentState(events)`, `orderStateFromShipment(order, shipment) → OrderState|null` (LABEL_PURCHASED ⇒ SHIPPED; DELIVERED ⇒ DELIVERED; never backwards), `cheapestRate(rates)`.
- `parcel.ts` — `parcelFromPreset(key, presets)` → `{weightGrams, l, w, h}`; presets from AppSetting `shipping.parcelPresets`.
- `tracking-email.ts` — `trackingEmail(order, shipment, locale) → {subject, body}` (bilingual-ready EN/IT, **no cost/margin by construction** — reads tracking fields only).

**Routes** (all `guarded()` + coverage-checked; money via `jsonStripped`):

| Route | Methods | Permission |
|---|---|---|
| `/api/shipping` | GET (ready-to-ship queue + in-flight shipments) | `pages.shipping` |
| `/api/shipping/rates` | POST (parcel + ship-to → adapter `getRates`) | `labels.purchase` |
| `/api/shipping/buy` | POST (parcel + ship-to + rate → Shipment, label stored, order→SHIPPED, timeline) | `labels.purchase` |
| `/api/shipping/[id]` | GET (shipment detail + tracking events) | `pages.shipping` |
| `/api/shipping/[id]/label` | GET (stream the stored label PDF) | `pages.shipping` |
| `/api/shipping/[id]/share-tracking` | POST (compose + send the reply into the thread — Owner-initiated) | `labels.purchase` |
| `/api/shipping/[id]/void` | POST (cancelShipment; order→READY; compensating event) | `labels.void` |
| `/api/shipping/manifest` | GET (today's day-sheet PDF) | `pages.shipping` |
| `/api/shipping/pickup` | POST (book if supported, else record "outside system") | `labels.purchase` |
| `/api/exports/shipments` | GET (shipment slice CSV, cost grain-gated) | `exports.run` |

**Label storage ($0 infra):** the adapter returns the label as base64; `buy` writes it to a local file (`FACTORY_DATA_DIR/labels/<shipmentId>.pdf`, beside the SQLite DB) and stores the path in `Shipment.labelRef`; the `/label` route streams it (never a public URL). Worker poll: the sidecar selects in-flight shipments, calls `pollTracking` (batched), appends `TrackingEvent` rows, updates state, emits `FactoryEventOutbox` events, and flips the order on DELIVERED — all through `resolveAdapter()` (no-ops cleanly when the fake/no-account is active).

## Interactions

- **Land on `/shipping`:** Ready-to-ship orders on top (the ones FP6 flipped READY), in-flight shipments below with live status pills. A "Sendcloud not connected — Connect" banner if there's no account (links to Settings).
- **Buy a label:** open an order's **Buy label** → pick **M** (preset fills weight/dims) → ship-to is prefilled from the party → **rates** appear, cheapest ticked → **Confirm & print** → the label PDF opens, the order moves to **SHIPPED**, a timeline entry records carrier + tracking + cost.
- **Share tracking:** on the shipment, **Share tracking** → a composed reply (tracking link, carrier, no prices) → Owner sends → it lands in the same Gmail thread the order was born from.
- **Track to delivered:** the worker poll advances the status pill (Fake adapter scripts CREATED→IN_TRANSIT→DELIVERED for verify); on DELIVERED the order flips **DELIVERED** and the timeline shows the chain.
- **Void:** bought the wrong service → **Void** (before dispatch) → shipment CANCELLED, order back to READY, compensating event.
- **Day-sheet:** end of day → **Day-sheet** → a manifest PDF of today's parcels; if the carrier supports pickup and the threshold is met, **Book pickup**, else tick "booked outside system."

## States

Skeletons on both queues; EmptyState ("nothing ready to ship — orders land here when production finishes"); carrier-not-connected banner; shipment-state pills (CREATED/LABEL_PURCHASED/IN_TRANSIT/DELIVERED/EXCEPTION/CANCELLED); rate-loading + rate-empty ("no rates — check the address/parcel"); label-streaming; share-tracking success/failure toast; poll-freshness dot on in-flight rows.

## RBAC

`pages.shipping` to view (Owner surface — per FD9 the WORKER nav stays Production + Materials only, so shipping is absent from the worker kiosk); `labels.purchase` to buy/rate/share/pickup; `labels.void` to void. **Shipment cost / rate money behind the `financials` grain** via `jsonStripped` — tracking numbers, statuses and addresses are operational (not financial) and are never stripped. All permissions seeded in F1 — **no new permissions**.

## Bulk / import-export

**Bulk-buy** for a size-run order (one parcel/shipment per box, same preset) — N labels in one action, each its own Shipment + timeline event. Shipment-slice **CSV export** (grain-gated cost). Day-sheet manifest PDF. No bulk void (each void is audited individually).

## Teardown verdicts applied (traceability)

| Verdict (F0-TEARDOWN / FD) | Where it lands |
|---|---|
| Sendcloud rules → 2–3 clicks — ADOPT, beat it (ours: two) | Parcel preset → confirm-and-print |
| ShipStation Create+Print split — ADOPT | Buy writes the shipment *and* returns the printable label inline |
| Pollable tracking, no public webhook — DECISIVE (FD6, local-first) | Worker `pollTracking`; webhook path intentionally unused |
| Free Unstamped-letter tests at €0 — FD6 | The Owner's live gate step |
| Capability-probe, never block on carrier rules — F0 finding | Pickup panel is capability-gated with an "outside system" escape |
| Tracking auto-shared in the thread — the golden flow (§1) | Owner-initiated "Share tracking" reply into `conversationId` |
| Cost is the Owner's alone — FD9 | Shipment cost grain-gated end to end |

## Acceptance targets (gate-2 click-through)

**Headless (fake adapter, `:3199`, zero network/spend):** `/shipping` lists a READY order → **Buy label** → preset M fills the parcel → ship-to prefilled → rates show, cheapest selected → **Confirm & print** streams a PDF, the order flips **SHIPPED**, a timeline event carries carrier+tracking+cost → the scripted poll advances IN_TRANSIT → DELIVERED and the order flips **DELIVERED** → **Share tracking** composes a cost-free reply (send stubbed in verify) → **Void** on a fresh label returns the order to READY → **Day-sheet** renders a manifest PDF → shipment CSV exports. Plus: `mapCarrierStatus` / `orderStateFromShipment` / `cheapestRate` / `parcelFromPreset` unit-tested (status mapping, no-backwards flips, cheapest, preset math); a test proves the tracking email + shipment payload carry **no cost** to a non-financial caller; the `FakeCarrierAdapter` contract test; 162+ existing tests stay green; rbac / no-touch / parity / build green.

**Live (the Owner's step, real Sendcloud):** connect Sendcloud in Settings (F1 wizard + probe) → the probe re-confirms label + tracking caps at build time → buy **one real €0 unstamped-letter label** on a test order → confirm the real PDF, real tracking number, and (if the plan exposes it) a real tracking poll. If tracking is plan-gated, labels still work and a Finding records the manual-tracking degrade.

## Build plan (no time estimates)

FP8.1 — carrier adapter contract (extend `types.ts`) + `FakeCarrierAdapter` + `SendcloudAdapter` (getRates/createShipment/cancel/pollTracking against `/parcels` + `/tracking`) + `resolveAdapter` + the pure core (`shipment-state.ts`, `parcel.ts`, `tracking-email.ts`) with tests + migration `fp8_shipping` + local label storage. → FP8.2 — `/shipping` queues + two-click buy panel (preset → rates → confirm-and-print) + label stream + order READY→SHIPPED flip + timeline event kinds. → FP8.3 — worker tracking poll (in-flight, outbox/SSE) + tracking timeline on the order + SHIPPED→DELIVERED flip + **Share tracking** reply (Owner-initiated) + shipment detail + void. → FP8.4 — day-sheet manifest + capability-gated pickup + bulk-buy + shipment CSV export + headless verify on isolated `:3199` (fake adapter) + `FP8-REPORT.md`. Each sub-phase a scoped commit; push at cycle end; STOP for gate 2 (which includes the Owner's live Sendcloud label).
