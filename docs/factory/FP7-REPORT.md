# FP7 — Materials: build report (gate 2, awaiting Owner click-through)

Shipped 2026-07-05 against the approved `FP7-SPEC.md`. Three build commits (FP7.1 four-column workspace + adjust → FP7.2 Purchase Orders + receive → FP7.3 "+ Buy" + reprice-ripple + where-used). **`/materials` is live — the append-only ledger the whole app writes to now has a face, and the shortage → purchase-order handoff FP6's red lights point at is real.** Built on Opus 4.8. **Migration-free** (Material / MaterialLot / MovementLedger / PurchaseOrder all shipped in F1); no new dependency; no new permission.

## Eng trans

Stock used to be an invisible number the floor reserved against. Now open **Materials** and every material shows its four columns — **In stock** (what's IN minus OUT), **Committed** (what live work orders reserved), **Expected** (what's on order), **Available** (free right now) — each a derived truth with a full movement paper trail behind it. Miscount? **Adjust** it with a reason and the ledger records who and why. Running short? The material glows red with a **"+ Buy"** button that turns it into a **purchase order pre-filled with the gap** — pick the supplier, send it, and when the hide arrives you **receive** it into a lot and stock jumps (and the floor's red light goes green). Change a supplier's cost and the app tells you **how many templates and open quotes reference it** so nothing drifts silently.

## What was verified (headless, isolated `:3199` prod build)

| Check | Result |
|---|---|
| **Four-column math** | hide: In stock 100 · Committed 30 (live reservation) · Expected +40 (open PO) · Available 70 ✓ |
| **Adjust** | −5 with a reason → In stock 95; missing reason → 400 ✓ |
| Detail | movements timeline (RESERVE / IN) + lots (on-hand per batch) ✓ |
| **PO lifecycle** | create PO-1 → send (Expected +40) → receive 25 (**PARTIAL**, stock 35) → receive 15 (**RECEIVED**, stock 50, lot created) ✓ |
| **"+ Buy"** | short material (Available −20) → one click → PO modal pre-filled with the material + gap qty (20) ✓ |
| **Reprice ripple** | cost change → "**1 template and 1 open quote** reference this" ✓ |
| Where used | the referencing template surfaced in the detail ✓ |
| **Worker cost-blind** | a WORKER keeps In stock / Committed / Expected / Available, loses `costCents` — pinned by test ✓ |

Battery: **162/162 unit tests · 98/98 routes RBAC-covered · no-touch clean · DS parity 97/97 · tsc + build green · zero page errors.** The list, detail drawer, PO detail, and "+ Buy" flow reviewed at native resolution — clean, full-width, on-token. Test data swept; the Owner's real data (Q-1 accepted, **ORD-1 now in production** — the golden flow the Owner just ran after the 500 fix) is untouched.

The risk lived in the pure math and is pinned: `materialStock` / `expectedForMaterial` / `poStateAfterReceive` (8 tests), `materials-strip` (2 — worker cost-blind).

## Deviations from spec (flagged)

1. **Opening-stock CSV import deferred** — writing opening balances as IN "opening balance" rows means modifying the shipped FP2 materials-import lib (parse + apply). **Adjust** (per material) and **receiving a PO** already set stock, so a bulk opening-balance import is a secondary convenience — flagged for a follow-up.
2. **Lot → work-order traceability is partial** — the ledger *records* lot + ref on every movement (the data for "which WOs consumed lot L-88" exists and shows in the movement trail), but a dedicated lot→WO lookup view is a follow-up.
3. **Reused FP2's catalog CRUD** — material name/unit/cost/reorder editing lives in both the /products Materials tab (FP2) and here; FP7 added the *ledger face* (stock, lots, POs, movements) on new `pages.materials` routes without touching FP2's `pages.products` catalog routes.

## What lives where

| Surface | Path |
|---|---|
| Pure math (tested) | `src/lib/materials/stock.ts` (materialStock / expectedForMaterial / poStateAfterReceive / isLow) |
| API | `src/app/api/materials/stock` (four-column list), `materials/[id]` (+GET detail, +ripple with quotes, +whereUsed), `materials/[id]/adjust`, `purchase-orders` (+`[id]`, +`[id]/receive`), `exports/ledger` |
| UI | `src/app/(app)/materials/_components/*` (MaterialsClient — four-column list + detail drawer + adjust + cost-edit + ripple + "+ Buy"; PurchaseOrders — list + detail + new-PO + receive) |

## Your click-through (the FP7 gate)

Open `/materials` → add a material (or see one a live WO has committed) → its four columns; **Adjust** it with a reason → the movement appears → if it's short, click **+ Buy** → a PO pre-filled with the gap → pick a supplier, **Create draft** → **Send** (Expected rises) → open it → **Receive** (into a lot) → In stock jumps, the PO goes Partial then Received → back on a material, raise its supplier **cost** and read the **reprice banner** → **Export ledger**. Switch to a Worker (`/materials` as WORKER) and confirm stock counts show but costs don't.

## Rollback

`git revert` the three FP7 build commits (factory-scoped). No migration, no dependency.

## Deferred (PLAYBOOK backlog)

Opening-stock CSV import; dedicated lot → WO traceability view; landed cost / GL (FP9); MRP auto-reorder; multi-warehouse / bins; receiving scanners.

**Next on approval: FP8 — Shipping (`/shipping`): the last leg — pack a Ready order, buy a Sendcloud label, drop the tracking into the thread, and flip the order Shipped → Delivered (the →SHIPPED stopgap from FP4 becomes real).**
