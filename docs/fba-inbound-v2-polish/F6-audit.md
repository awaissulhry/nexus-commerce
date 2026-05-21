# F.6.0 Audit — FBA Inbound v2024-03-20 Wizard Polish

**Date:** 2026-05-21
**Source files audited:**
- `apps/web/src/app/fulfillment/inbound/v2/FbaInboundV2Wizard.tsx` (349 lines)
- `apps/api/src/routes/fba-inbound-v2.routes.ts` (198 lines)
- `apps/api/src/services/fba-inbound-v2.service.ts` (347 lines)
- `apps/api/src/clients/amazon-fba-inbound-v2.client.ts`

**Production probe:**
- `GET /api/fba/inbound/v2` → `{ plans: [], count: 0 }`

---

## 1. Production state

**Zero v2 plans exist.** The operator has been routing transport bookings through Seller Central since the v0 deprecation banner went up (2026-05-06). F.5 v1 wizard works end-to-end but the prompt() friction + PLACEHOLDER body has kept it unused.

That's fine for the polish work — the SP-API client types are well-defined; we don't need real plans to design the UI. But it does mean **we can't visually validate the polished UI against real responses until we ship F.6.1 (real New Plan form) and the operator creates the first real plan.**

---

## 2. API surface (routes + service)

The backend is **complete and well-shaped**. Every step has a route + service method + persistent state:

| Step | Route | Service method | Persisted state |
|---|---|---|---|
| 1. CREATE | `POST /api/fba/inbound/v2` | `createPlan({ spApi, inboundShipmentId?, createdBy? })` | `planId`, `status='CREATING'→'ACTIVE'`, `currentStep`, `operationIds.CREATE` |
| 2. LIST_PACKING | `GET /:id/packing-options` | `listPlanPackingOptions(planRowId)` | `status='PACKING_OPTIONS_LISTED'`, `currentStep='CONFIRM_PACKING'` |
| 3. CONFIRM_PACKING | `POST /:id/packing-options/:optionId/confirm` | `confirmPlanPackingOption` | `selectedPackingOptionId`, `status='PACKING_CONFIRMED'` |
| 4. LIST_PLACEMENT | `GET /:id/placement-options` | `listPlanPlacementOptions` | `status='PLACEMENT_OPTIONS_LISTED'` |
| 5. CONFIRM_PLACEMENT | `POST /:id/placement-options/:optionId/confirm` | `confirmPlanPlacementOption` | `selectedPlacementOptionId`, `shipmentIds[]`, `status='PLACEMENT_CONFIRMED'` |
| 6. LIST_TRANSPORT | `GET /:id/shipments/:shipmentId/transport-options` | `listPlanTransportOptions` | `status='TRANSPORT_OPTIONS_LISTED'` |
| 7. CONFIRM_TRANSPORT | `POST /:id/transport-options/confirm` (body: `{ selections: [{ shipmentId, transportationOptionId, contactInformation? }] }`) | `confirmPlanTransportOptions` | `selectedTransportationOptions`, `status='TRANSPORT_CONFIRMED'` |
| 8. GET_LABELS | `GET /:id/labels` | `fetchPlanLabels` | `labels` (JSON keyed by shipmentId), `status='LABELS_READY'` |

State machine is solid. Polling logic is correct (`pollOperation` with exponential backoff; persists `operationId` before SP-API call so a restart mid-poll resumes). **No backend changes needed for F.6.1-F.6.4.**

---

## 3. Client type completeness

This is where there's a real gap:

### 3.1 PackingOption (client.ts:174) — minimal

```ts
export interface PackingOption {
  packingOptionId: string
  status: string
  expiration?: string
  /** Subset; the SP-API response also carries packingGroups + packingFeatures + fees. */
}
```

The comment is honest — `packingGroups`, `packingFeatures`, `fees` are **dropped**. The operator picking a packing option needs to see:
- Which packing groups (FBA fulfillment center groupings) are included
- Features like CASE_PACKED vs INDIVIDUAL_UNITS
- Fees per option (so they can compare cheapest)

🔴 **F.6.2 requires extending PackingOption + listPackingOptions to pass these through.** The route currently just returns the SP-API JSON, so this is a client.ts + maybe routes.ts surface update.

### 3.2 PlacementOption (client.ts:209) — adequate

```ts
export interface PlacementOption {
  placementOptionId: string
  status: string
  shipmentIds?: string[]
  fees?: Array<{ value?: { amount: number; currencyCode: string }; type?: string }>
}
```

🟢 Has fees + shipmentIds. F.6.3 can render this directly. Might want to add `expiration` for visibility.

### 3.3 TransportationOption (client.ts:244) — well-shaped

```ts
export interface TransportationOption {
  transportationOptionId: string
  carrier: { alphaCode?: string; name?: string }
  shippingMode?: 'SMALL_PARCEL' | 'LTL' | 'PARTNERED_LTL' | 'PARTNERED_SMALL_PARCEL'
  shippingSolution?: string
  preconditions?: string[]
  quote?: { cost: { amount: number; currencyCode: string }; expiration?: string }
}
```

🟢 Carrier + mode + cost + preconditions all there. F.6.4 can render this richly — the most important step (transport) already has the best type coverage.

### 3.4 ShipmentLabelsInput (client.ts:292) — operator preferences exposed

```ts
export interface ShipmentLabelsInput {
  pageType?: 'PackageLabel_Letter_2' | ... | 'PackageLabel_A4_4'
  pageSize?: 'Letter' | 'A4'
  format?: 'PDF' | 'PNG' | 'ZPL'
  labelType?: 'BARCODE_2D' | 'UNIQUE' | 'PALLET'
}
```

🟢 Italian operator → defaults should be `pageSize='A4'`, `format='PDF'`. F.6.5 can offer these as a form with sensible defaults.

---

## 4. UI gaps (the actual polish surface)

| # | Current state | Required | Polish phase |
|---|---|---|---|
| 1 | New Plan form: hardcoded `msku='PLACEHOLDER'`, single item with `quantity=1`, hardcoded source address `'Via Esempio 1'`, hardcoded destination `'A1F83G8C2ARO7P'` (UK) | Real form: SKU autocomplete from Product table, multi-row item list with quantity inputs, source address from a saved set (default to Xavia Riccione), destination marketplace dropdown (default IT since that's the active market) | **F.6.1** |
| 2 | Packing pick: `prompt('packingOptionId to confirm?')` | Card list showing each option: status badge, packing groups, features, fees with currency. Single-select with "Confirm" button. | **F.6.2** |
| 3 | Placement pick: `prompt('placementOptionId to confirm?')` | Card list: per-option fees broken down by type (FBA prep, etc.), expected shipmentIds preview ("This option splits into 3 shipments"). Operator picks the cheapest. | **F.6.3** |
| 4 | Transport pick: `prompt('transportationOptionId to confirm?')`. Only handles `shipmentIds[0]`. | Per-shipment card list: carrier name (e.g. "UPS"), shipping mode, quote.cost displayed prominently, preconditions chip list, contact info form (name/email/phone — operator's default). Loop over ALL `shipmentIds`, not just first. | **F.6.4** + **F.6.5** (multi-shipment) |
| 5 | Labels: `toast.success('Labels fetched for N shipment(s)')` then nothing | Per-shipment label download UI: page size + format selector (defaults A4/PDF), download button per shipment, "Print all" button | **F.6.5** |
| 6 | InboundWorkspace v0 transport form still present with "Try v0 booking (likely fails)" demoted button | Remove the form entirely; update banner; redirect any operator click to /fulfillment/inbound/v2 | **F.6.6** |

---

## 5. State machine + UX gaps not covered in original phasing

| # | Issue | Recommendation |
|---|---|---|
| 1 | **No "resume mid-flow" deep link** — selectedPlanId is local React state; refresh loses it | Add `?plan=<id>` URL param + read it on mount. Low effort, high recovery value. → Fold into **F.6.1** |
| 2 | **No way to delete/cancel a stale plan** — once created, lingers forever | Add `DELETE /api/fba/inbound/v2/:id` (soft-delete or hard) + cancel button in the plan list. Treat as P2 unless operator asks. → Defer |
| 3 | **No "retry from FAILED state"** — if Step N fails, currentStep stays at N; operator has to wait for the next state push to retry | Add a "Retry" button that re-runs the current step. Service is already idempotent (each step is an upsert + poll). → Fold into **F.6.4** |
| 4 | **planActions handleNext spans all 8 steps in one if-else chain** — hard to maintain | Refactor into per-step React components with focused props. Quality of life — not user-visible. → Optional during F.6.2-F.6.5 as each step gets its own component |
| 5 | **No InboundShipment ↔ FbaInboundPlanV2 cross-link in UI** — backend has `inboundShipmentId` field but the wizard doesn't surface or use it | Add an optional "Link to existing InboundShipment" dropdown in F.6.1's New Plan form | **F.6.1** |
| 6 | **F.5 wizard's STEPS constant doesn't include CREATE in the visible tracker** — operator can't see "Create" as done | Minor: include CREATE step or relabel. Cosmetic. | Fold into **F.6.1** |

---

## 6. Revised phase list

Original 7-phase plan stands, with refinements:

| Phase | Original scope | Revised |
|---|---|---|
| F.6.0 | Audit | ✅ done (this doc) |
| F.6.1 | Real New Plan form | + URL deep-link, + InboundShipment cross-link, + show CREATE in tracker |
| F.6.2 | Packing card UI | + **extend PackingOption type + listPackingOptions** to pass through packingGroups + features + fees (backend work) |
| F.6.3 | Placement card UI | + show expected shipmentIds preview per option |
| F.6.4 | Transport card UI | + per-shipment looping (handle ALL shipmentIds, not [0]) + Retry-on-FAIL button |
| F.6.5 | Multi-shipment + labels | rolled-up label download UI; per-shipment PDF download with operator-default A4/PDF |
| F.6.6 | Decommission v0 | unchanged |

Revised wall-clock estimate: **~7-9h** (added ~1h for F.6.2 backend extension + ~1h for retry button + URL state).

---

## 7. Risk + recommendations

- **F.6.2 is the only phase with backend work** — extending the PackingOption type passes through more SP-API fields. Additive; can't break existing callers.
- **F.6.4 is the most operationally important phase** — transport is the step that was broken under v0. Worth the most UX polish.
- **F.6.5 (label download) blocks shipping** — without labels, the operator can't physically ship to FBA. Until F.6.5 lands, they'll still have to use Seller Central for the last step. Worth bundling labels into F.6.4 if shipping time matters.
- **F.6.6 should ONLY land after F.6.4** — removing v0 transport before v2 is operator-tested would leave them stranded if anything's wrong.
- **No SP-API charges from this work** — every endpoint we call is either GET (free) or returns a quote (no commit). Real transport booking only happens at the operator's explicit click.

---

## Approval needed

Reply with:
- **"proceed F.6.1"** — single phase, gate after
- **"proceed F.6.1 → F.6.4"** — through the prompt() replacement work; gate before labels + v0 decommission
- **"proceed F.6.1 → F.6.6"** — full sequence
- **"different prioritization"**
