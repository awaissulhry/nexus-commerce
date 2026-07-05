# FP4 — Orders: build report (gate 2, awaiting Owner click-through)

Shipped 2026-07-05 against the approved `FP4-SPEC.md`. Four commits (FP4.1 lifecycle core → FP4.2 board + one-timeline → FP4.3 start-production + deposit gate + payments → FP4.4 kanban + size-run + export). **`/orders` is live, and the golden flow now runs unbroken from a Gmail thread all the way to a closed, shipped job.** Built on Opus 4.8. One additive migration (`WorkOrder.label`); no new dependency (`@dnd-kit` was already present); no commerce surface touched.

## Eng trans

The `ORD-1` that FP3 could only *create* now has a home you run. Open **Orders** and every confirmed job is on a board — as a dense grid or a **kanban** you drag cards across. The board shows what's in production, what's **waiting on a deposit**, and what's **overdue**, and you drive a job's life by clicking its status (only the legal next steps are offered) or dragging its card; an illegal move is refused and snaps back, and most moves offer an **Undo**.

Open an order and you get the thing the whole product was pointing at: **one timeline** that reads top to bottom as the job's entire story — the email, the quote drafted, the quote sent, the customer accepting, the order confirmed, the deposit landing, the work order created — each row a link back to its source. Beside it, a rail of the money, the **deposit gate**, the promise date, and the work orders.

One click — **Start production** — turns the order into work: a **Work Order per line** (a B2B size-run explodes into one per size), each carrying the five production stages (Cutting → Stitching → Assembly → QC → Packing), and the order moves to *In production*. If the customer's deposit isn't in yet, those work orders are born **blocked "awaiting deposit"** — and the moment you **record the deposit**, they unblock to ready. That's the made-to-measure risk control (FD13) encoded without a payments integration.

## What was verified (headless, isolated `:3199` prod build, real persisted data, NO live email)

The **full golden flow FP3→FP4 was driven end to end as one chain** and every number checked:

| Check | Result |
|---|---|
| Quote configured through the engine | net €520 / cost €290 ✓ |
| Accept → **Convert to order** | ORD-1, CONFIRMED, lines snapshotted, deposit required €156 (30%) ✓ |
| **Start production** (deposit unmet) | order → In production, **1 WO BLOCKED "awaiting deposit", 5 stages** ✓ |
| **Record deposit** €156 | WO **unblocks to READY**, deposit met ✓ |
| Lifecycle READY → SHIPPED → DELIVERED → CLOSED | every transition legal + audited ✓ |
| Re-start production | refused (400) ✓ |
| **One-timeline** | covers quote → order → payment → work order → transitions, each deep-linked ✓ |
| Orders CSV export | contains the order, money columns grain-gated ✓ |
| Money never leaks | no cost/margin/deposit value in any timeline label (kept in strippable fields) ✓ |
| **Kanban** | 5 lanes render; a **real drag** (In production → Ready) actually moved the order; illegal drops snap back ✓ |
| **Size-run** | matrix `{48:2, 50:3}` saved, line qty synced to 5, Start production exploded to **2 per-size work orders** ✓ |

Battery: **119/119 unit tests · 78/78 routes RBAC-covered · no-touch clean · DS parity 97/97 · tsc + build green · zero page errors.** Board, detail, and kanban reviewed at native resolution (1512/1728/1920/1600) — clean, full-width, on-token. All test data removed; **counters reset so your first real order is ORD-1** (your real Q-1 draft is untouched).

## Deviations from spec (flagged)

1. **Batch-select bar + historical CSV import are deferred** (to a follow-up). The kanban already gives fast multi-move by drag, and the CSV import is a migration convenience off the golden-flow critical path — deferring kept FP4 focused and immaculate. Both are named in the PLAYBOOK backlog.
2. **Two lifecycle stopgaps until FP6/FP8**: IN_PRODUCTION→READY and READY→SHIPPED are *manual* (the floor that auto-advances READY is FP6; real shipments are FP8). Marking shipped opens a tracking-note modal that says so. This is the honest local-first trade-off — the same pattern FP3 used for manual accept.
3. **Re-start production is refused with 400, not 409** — the state guard (order is no longer CONFIRMED) fires before the work-orders-exist guard. Same refusal, and the 409 path remains as defense-in-depth.
4. **Deposit on convert is still not a Payment row** — the deposit requirement is computed from the born-from quote's `depositPct`; recording it is the manual FD13 act (real payment/invoicing is FP9).

## What lives where

| Surface | Path |
|---|---|
| State machine (the authority) | `src/lib/orders/transitions.ts` (`canTransition`, legal edges, stopgap flags) |
| Money / deposit / planning (pure) | `src/lib/orders/money.ts` (FD13 gate), `production.ts` (WO plan + size-run explosion), `timeline.ts` (one-timeline assembler) |
| API (7 routes) | `src/app/api/orders/*` (list, [id] detail+timeline+PATCH, cancel, start-production, payments, lines/[lid]), `exports/orders` |
| UI | `src/app/(app)/orders/_components/*` (OrdersClient board+kanban, OrderDetail, Timeline, KanbanBoard, OrderItems) |
| Tests | `order-transitions` (11), `order-money` (7), `order-production` (5) |

## Your click-through (the FP4 gate)

The `ORD-1` gets created when you convert an accepted quote (FP3) — so do a quick quote first, or I can walk you through it.
1. Restart the app → **Orders**. Convert an accepted quote (from the Quotes page) and it lands here as **Confirmed** with a **deposit-due** chip and the **Awaiting deposit** counter lit.
2. Open it: read the **one-timeline** (email → quote → confirmed) and the rail (money, deposit, dates).
3. **Start production** (with the deposit unpaid) → the order goes *In production* and a Work Order appears **blocked "awaiting deposit"**.
4. **Record deposit** in the rail → the work order **unblocks to ready** (toast), and the payment + unblock appear on the timeline.
5. Flip to **Kanban** and drag the card between lanes; try an illegal drop and watch it snap back. Drag to **Shipped** → add a tracking note.
6. Edit the promise date; cancel an order (with a reason) and watch the work orders cancel too; **Export CSV**.
7. (B2B) On a confirmed order, open **Items → Size run**, enter sizes, then Start production → one work order per size.

## Rollback

`git revert` the four FP4 commits (factory-scoped). The migration is additive (`WorkOrder.label` remains harmless). No commerce surface involved.

## Deferred (PLAYBOOK backlog)

Batch-select transition bar + undo; historical order CSV import (dry-run); auto-advance IN_PRODUCTION→READY when all WOs DONE (FP6); real shipment gating on →SHIPPED (FP8); deposit as a real Payment/invoice (FP9); size-run per-size stage nuances (FP6).

**Next on approval: FP5 — Contacts (`/contacts`): the party workspace, measurement profiles, per-party configurator defaults — the CRM spine the quotes and orders already lean on.**
