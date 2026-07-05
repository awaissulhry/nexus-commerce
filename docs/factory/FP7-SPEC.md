# FP7 — Materials: page-cycle spec (awaiting Owner approval)

Written 2026-07-05 on FP6's approval. Gate 1 of the FP7 double gate — nothing below is built until the Owner approves. Seeds: `F0-IA.md` §2, PLAYBOOK §11-FP7, and the Katana 4-column / MRPeasy parts-grammar / append-only-ledger verdicts in `F0-TEARDOWN.md`. **This is the ledger's face.** FP6 reserves and consumes material and shows red traffic-lights when stock is short; FP7 gives those numbers a home — the four-column stock math, lots and receiving, and the **shortage → purchase-order handoff** the red lights point at.

## Purpose (one sentence)

Turn the append-only movement ledger into a materials workspace — every material's **In stock / Committed / Expected / Available** with a full movement paper trail, lots and receiving, reorder alerts, and a one-click **"+ Buy"** that turns a shortage into a pre-filled purchase order — so stock is always a derived, explainable number, never a typed-in guess.

## Scope

**IN (FP7):**
- **The `/materials` workspace** — every material with the **four-column math**: **In stock** (Σ IN − OUT ± ADJUST), **Committed** (Σ RESERVE − RELEASE — from FP6's reservations), **Expected** (Σ open PO qty not yet received), **Available** (In stock − Committed). Reorder-level chips (below → amber), unit, supplier cost (grain-gated). Catalog CRUD stays reusable here (the FP2 `materials.manage` registry — name/unit/cost/reorder).
- **Material detail** — the **movements timeline** (append-only, filterable by type IN/OUT/ADJUST/RESERVE/RELEASE, with ref + reason + actor), the material's **lots** (hide/dye batches — lotCode, supplier, received date, on-hand per lot), the four-column summary, and a **manual adjust** (ADJUST movement, signed, reason REQUIRED — the platform rule).
- **Purchase Orders** — PO CRUD (supplier, lines `[{materialId, qty, unit, unitCostCents}]`, expected date) with the state machine DRAFT → SENT → PARTIAL → RECEIVED / CANCELLED; **receive** a PO (per line, into a lot) writes **IN movements** and advances the PO (PARTIAL until every line is fully in, then RECEIVED). Expected column = ordered − received across open POs.
- **"+ Buy" from a shortage** — on a material below reorder or short on the floor, one click opens a **pre-filled PO** (that material, suggested qty = the gap, its supplier + last cost) — the handoff FP6's red lights point at.
- **Reprice ripple flag** — editing a material's supplier `costCents` surfaces **"N templates, M open quotes reference this — review"** (query BomLines + open quotes), so a cost change never silently drifts live pricing.
- **Lot lookup / traceability** — "which work orders consumed lot L-88" (a `MovementLedger` refType/refId query) — the GPSR/recall thread.
- **Opening-stock import** (opening balance = IN movements, reason "opening balance") + **ledger-slice export**.

**OUT (named, so the boundary is explicit):**
- **Landed cost / accounting** — a PO records `unitCostCents`; allocating freight/duty into material cost and any GL posting is FP9.
- **Supplier management** — supplier *parties* live in Contacts (FP5); FP7 references them and shows their POs.
- **MRP / auto-reordering** — "+ Buy" is one-click but manual; automatic reorder generation is not this cycle (reorder chips flag; the human buys).
- **Multi-warehouse / bin locations** — single implied location; bins are a later concern.
- **Barcode/receiving scanners** — manual receive in v1.

## Layout

```text
/materials:  list — name · unit · In stock · Committed · Expected · Available · reorder chip · cost*
  toolbar: search · [low stock] filter · [+ New PO] [+ Material] · Export ledger
MATERIAL DETAIL (drawer/page):  four-column header · [Adjust] [+ Buy]
  tabs: Movements (append-only, type filter) · Lots (on-hand per batch) · Where used (templates/quotes) + reprice flag
PURCHASE ORDERS (/materials?tab=po or a section):  DataGrid — number · supplier · state · lines · expected · total*
  PO detail: lines · [Send] · [Receive] (per line → lot → IN) · state chips
"+ BUY" modal:  material · qty (gap prefilled) · supplier · unit cost* → creates a DRAFT PO
```
`*` = grain-gated (supplier cost / PO totals behind `financials.suppliers.view`; stock counts are not financial).

## Component reuse

| Region | Components |
|---|---|
| List + PO grid | `DataGrid`, `Pill` (reorder/state chips), `Input` search, the FP4 tab pattern |
| Detail | `Drawer`, `Card`, movement rows (the FP4 timeline-item look), `Modal` (adjust / buy / receive) |
| Four-column math (pure) | `src/lib/materials/stock.ts` — `materialStock(movements, openPoLines)` → `{inStock, committed, expected, available}` |
| Reprice ripple | a query helper + `Banner` |
| States | `Skeleton`, `EmptyState`, `useToast`; freshness where relevant |

## Data & API

**No migration** — `Material` / `MaterialLot` / `MovementLedger` / `PurchaseOrder` / `BomLine` all shipped in F1. **No new permissions** — `materials.adjust` (adjust), `materials.receive` (PO receive), `materials.manage` (catalog CRUD), `pages.materials` all seeded; supplier cost behind `financials.suppliers.view`.

**Pure module (tested):** `materialStock(movements: {type,qty}[], openPo: {qty,received}[])` → four-column summary; `expectedFromPOs(pos)`; `poReceiveState(lines, receipts)` → DRAFT|SENT|PARTIAL|RECEIVED. Numbers are Float; the ledger fold (`foldMovements`) is reused for In stock + Committed.

**Routes** (all `guarded()` + coverage-checked; money via `jsonStripped`):

| Route | Methods | Permission |
|---|---|---|
| `/api/materials` | GET (list + four-column math) | `pages.materials` |
| `/api/materials/[id]` | GET (detail: movements + lots + where-used), PATCH (cost → ripple flag), DELETE (archive) | `pages.materials` / `materials.manage` |
| `/api/materials/[id]/adjust` | POST (ADJUST movement, reason required) | `materials.adjust` |
| `/api/materials/[id]/where-used` | GET (templates + open quotes referencing it) | `pages.materials` |
| `/api/purchase-orders` | GET (list), POST (create / "+ Buy" prefill) | `pages.materials` / `materials.manage` |
| `/api/purchase-orders/[id]` | GET, PATCH (state: send/cancel) | `materials.manage` |
| `/api/purchase-orders/[id]/receive` | POST (per-line → lot → IN movements; advance state) | `materials.receive` |
| `/api/imports/materials` | (extend) opening-stock rows → IN "opening balance" | `imports.run` |
| `/api/exports/ledger` | GET (movement slice CSV) | `exports.run` |

Receive contract: `receive` takes `{lines: [{materialId, qty, lotCode?}]}`; for each it upserts a `MaterialLot` and appends an **IN** movement (refType PO, refId poId, lotId); the PO becomes PARTIAL until ordered = received on every line, then RECEIVED. Expected per material = Σ over SENT/PARTIAL POs of `(ordered − received)`. "+ Buy": POST with `?from=shortage&materialId=` returns a DRAFT PO seeded with the gap qty + the material's supplier/cost. Every adjust/receive is a ledger append + audit; corrections are compensating movements (never edits).

## Interactions

- **Land on `/materials`:** each row shows the four columns; a material below reorder is amber, a floor-short material (Committed > In stock) is red with **"+ Buy"** inline.
- **Adjust:** count says 12, ledger says 14 → **Adjust** with a reason → a signed ADJUST movement; the fold updates; the paper trail shows who/why.
- **+ Buy:** click on a short material → a DRAFT PO pre-filled (material, gap qty, supplier, last cost) → **Send** → the material's **Expected** rises → **Receive** (into a lot) → IN movements land → In stock rises, the FP6 red light on the floor goes green.
- **Reprice ripple:** raise a hide's cost → banner "3 templates, 7 open quotes reference this — review" (links out); no silent drift.
- **Trace:** open a lot → the WOs that consumed it (recall thread).

## States

Skeletons on list + detail; EmptyState ("no materials yet — add one or import opening stock"); reorder/short chips; PO state chips; a reprice-ripple banner; movement timeline empty state; export streams a CSV.

## RBAC

`pages.materials` to view; `materials.adjust` (adjust), `materials.receive` (PO receive), `materials.manage` (catalog + PO CRUD); **supplier cost / PO money behind `financials.suppliers.view`** via `jsonStripped` — a WORKER sees stock counts (they need them on the floor) but no costs. Stock quantities are NOT financial (workers must see them). All permissions seeded in F1 — **no new permissions**.

## Bulk / import-export

Opening-stock CSV import (dry-run, IN "opening balance"); ledger-slice CSV export (grain-gated cost column); bulk PO send. No bulk stock edit (each adjust is audited individually).

## Teardown verdicts applied (traceability)

| Verdict (F0-TEARDOWN) | Where it lands |
|---|---|
| Four-column stock (In stock/Committed/Expected/Available) — ADOPT (Katana) | The list + detail math (`materialStock`) |
| Append-only movement ledger — BEAT (already structural) | Every adjust/receive/consume is a movement; corrections compensate |
| Six-state parts grammar rides WO cards — ADAPT (MRPeasy) | FP6's traffic-lights are powered by this fold; FP7 adds Expected + the buy |
| Shortage → pre-filled PO — ADAPT (Katana/MRPeasy) | "+ Buy" from a short material |
| Lot traceability for recall — F0 finding (GPSR) | Lot → consuming WOs query |
| Cost change must surface downstream — ADAPT | The reprice ripple flag |

## Acceptance targets (gate-2 click-through)

Open `/materials` → a hide shows In stock / Committed (from a live WO reservation) / Expected / Available → **Adjust** it up with a reason (the movement appears) → on a short material click **+ Buy** → a DRAFT PO pre-filled → **Send** (Expected rises) → **Receive** into a lot (IN movements; In stock rises; the material's floor light goes green) → raise the material's cost and see the **reprice-ripple banner** → open a lot and see which WOs consumed it → import an opening-stock CSV → export a ledger slice. Plus: `materialStock` + `poReceiveState` unit-tested (partial/full receive, expected math); a test proves a WORKER sees stock but no cost; 152+ existing tests stay green; rbac / no-touch / parity / build green.

## Build plan (no time estimates)

FP7.1 `materialStock` pure module (+ tests) + `/materials` list (four-column) + material detail (movements + lots) + manual adjust → FP7.2 Purchase Orders (CRUD + state machine + receive → lot → IN) + Expected wiring → FP7.3 "+ Buy" from shortage + reprice-ripple flag + where-used + lot lookup → FP7.4 opening-stock import + ledger export + headless verify on isolated :3199 + `FP7-REPORT.md`. Each sub-phase a scoped commit; push at cycle end; STOP for gate 2.
