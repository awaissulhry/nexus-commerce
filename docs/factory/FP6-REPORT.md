# FP6 — Production: build report (gate 2, awaiting Owner click-through)

Shipped 2026-07-05 against the approved `FP6-SPEC.md`. Five commits (FP6.1 stage engine → FP6.2 board + drawer → FP6.3 reservations + coverage + consume → FP6.4 QC + cert gate + scrap + cost → FP6.5 Worker kiosk + order-READY). **`/production` is live — the work orders FP4 created now get *run*, the material ledger the deposit gate has been waiting for is live, the EN 17092 gate is enforced, and the Workers have their own cost-blind kiosk.** Built on Opus 4.8. One additive migration (`WorkOrder.orderLineId` + `WorkOrderStage.pausedAt`); no new dependency; no new permission.

## Eng trans

A confirmed order's work orders used to just sit there. Now open **Production** and they're on a five-stage board — Cutting → Stitching → Assembly → QC → Packing → Done — each work order sitting in its current stage with a **live timer** and **Start / Pause / Finish**. When a job starts, its hide is **reserved against the ledger**; the card shows a **traffic light** — green if the material's there, red if it's short — and **dragging a rush job up the priority** takes the scarce hide first, flipping a lower job to red. Finish Cutting and it asks the **real quantity used** — the ledger records it and shows the diff vs the estimate.

At **QC** you tick a checklist, and the system **won't let you finish into Packing** if the garment's **EN 17092 certificate is missing or expired** (FD14) — the hard compliance gate. When the last stage of the last work order finishes, the **order flips to Ready** on its own.

And your **Workers get their own screen**: a phone-friendly "your next task is the top card" queue with big buttons, the same traffic lights, and **no prices anywhere** — their whole nav is just Production and Materials.

## What was verified (headless, isolated `:3199` prod build)

| Check | Result |
|---|---|
| Full stage flow | WO born Cutting/READY → Start → IN_PROGRESS (timer ticks) → finish all 5 → WO **DONE** ✓ |
| **Reservations** | Start production writes RESERVE (2× 5 SQM) against the ledger ✓ |
| **Coverage under scarcity** | stock 7, two need 5: higher-priority **OK**, lower **SHORT** ✓ |
| **Priority reallocation** | raise the short WO → coverage **flips** (it now gets the hide) ✓ |
| **Consume at Cutting** | actual 4.5 vs est 5 → **OUT 4.5 + RELEASE**, diff recorded ✓ |
| **Cert gate (FD14)** | QC finish: no cert **422**, expired **422**, valid **200 → packs** ✓ |
| QC checklist + scrap | items stamped + persisted; scrap reason recorded ✓ |
| **Est-vs-actual** | est €290 vs actual material €200 (5 SQM × €40), grain-gated ✓ |
| **Worker kiosk** | real WORKER session → `worker=true`, **no `*Cents` anywhere** in the payload ✓ |
| **Order-READY on done** | all WOs finished → order flips IN_PRODUCTION → **READY** ✓ |

Battery: **152/152 unit tests · 92/92 routes RBAC-covered · no-touch clean · DS parity 97/97 · tsc + build green · zero page errors.** Board, drawer, coverage dots, QC cert banner, and the Worker kiosk reviewed at native resolution — clean and on-token. All test data swept; the Owner's real data untouched.

The **risk lived in the pure modules** and is pinned by tests: `stage-timer` (12 — pause-aware elapsed, transitions, forward-only floor), `reserve/allocateByPriority` (7 — priority allocation, reordering flips coverage), `cert-gate` (5 — missing/expired/valid/mixed), `production-strip` (2 — worker cost-blind).

## Deviations from spec (flagged)

1. **One additive migration** (`WorkOrder.orderLineId` + `WorkOrderStage.pausedAt`) — I'd said FP6 was migration-free; correct per-WO reservations genuinely need the WO→line link, and clean pause/resume needs a pause marker, neither of which the F1 schema had. Both columns are additive.
2. **Reservation demand is per-garment, not qty-scaled** — a work order reserves one garment's BOM (via the FP2 engine); scaling by a multi-garment WO's count is a refinement (most custom WOs are one garment). A line with **no selections** can't resolve its template, so it reserves nothing (flagged).
3. **Labor cost from timers deferred** — timers record time; turning minutes into cost via a labor-rate setting is a follow-up (per the spec).
4. **QC photo upload + comment composer deferred** — the checklist, cert gate, and scrap are in; photo attach and the kiosk comment box are follow-ups.
5. **Priority is ▲▼ buttons, not free drag** — raising/lowering priority (which recomputes coverage) is the point and works; a full drag-sort is a refinement.

## What lives where

| Surface | Path |
|---|---|
| Pure engines (tested) | `src/lib/production/` — `stage-timer.ts`, `reserve.ts` (allocateByPriority), `cert-gate.ts` (certStatus), `demand.ts` + `reserve-service.ts` |
| API (8 routes) | `src/app/api/production/*` — board, `wo/[id]`, `stages/[sid]` (start/pause/resume/finish + assign, cert-gated), `.../materials`, `.../qc`, `.../scrap`, `wo/[id]/priority` |
| UI | `src/app/(app)/production/_components/*` — ProductionClient (board + Worker kiosk), StageTimer, QCChecklist |

## Your click-through (the FP6 gate)

Start production on a confirmed order → open **Production**: its WO is in **Cutting** with a coverage dot → **Start** (timer runs) → **Finish** Cutting → enter the real hide used → the est-vs-actual diff appears → advance Stitching → Assembly → **QC**: tick the checklist; if the template's cert is missing/expired, **Finish is blocked** (add a cert in Products to clear it) → Finish → **Packing** → Finish → the WO is **Done** and the order flips **Ready**. Add a second WO and drag its priority up to watch a scarce-material light flip. Then open **Production as a Worker** (append `?worker=1`) and confirm the my-queue + big buttons + **no prices**.

## Rollback

`git revert` the five FP6 commits (factory-scoped). The migration is additive (the two columns remain harmless). No commerce surface involved.

## Deferred (PLAYBOOK backlog)

Labor cost from timers; QC photo upload; kiosk comment composer; per-WO qty-scaled reservations; free-drag priority; capacity/scheduling ("latest safe start" only).

**Next on approval: FP7 — Materials (`/materials`): the ledger's face — the material registry, lots + receiving, opening-stock import, the six-state parts grammar, and the shortage → purchase-order handoff the coverage traffic-lights point at.**
