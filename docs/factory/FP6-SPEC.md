# FP6 — Production: page-cycle spec (awaiting Owner approval)

Written 2026-07-05 on FP5's approval. Gate 1 of the FP6 double gate — nothing below is built until the Owner approves. Seeds: `F0-IA.md` §2, PLAYBOOK §11-FP6, and the Odoo shop-floor / MRPeasy kiosk / Katana cost-blind-operators verdicts in `F0-TEARDOWN.md`. **This is where the work actually happens.** FP4 created the Work Orders and their stage rows; FP6 *runs* them — Start/Pause/Finish on the floor, the material reservations the deposit gate has been deferring, the QC + EN 17092 cert gate, and a **zero-training shop-floor view for the Workers** with no money anywhere.

## Purpose (one sentence)

Give the Owner a five-stage Work-Order board (Cutting → Stitching → Assembly → QC → Packing) with stage timers, priority ordering, and live material coverage — and give the Workers their own cost-blind kiosk ("your next task is the top line") — so a job moves across the floor with reservations honoured, materials consumed against the ledger, and the cert gate enforced before anything is packed.

## Scope

**IN (FP6):**
- **The stage board (Owner)** — columns are the Settings pipeline stages (`production.stages`) + Done; each in-production Work Order sits in its **current stage** (the first unfinished one). Cards show the WO number, order/party, priority, promise pressure, and **ingredient traffic lights**. Drag to **reorder priority** (which reshuffles material coverage — see reservations).
- **Stage execution** — per stage: **Start / Pause / Finish** (`startedAt`, accumulated `pausedMs`, `finishedAt`); a pure timer computes active elapsed time. Finishing a stage advances the WO to the next; finishing the last completes the WO (and, once all a WO's are Done, the order can go READY — the FP4 stopgap becomes real). Per-stage **assign** to a user.
- **Material reservations + the ledger** — when a WO becomes READY, its BOM demand (template `BomLine`s + per-option draws for the selected options) is **RESERVED** (`MovementLedger` RESERVE, refType WorkOrder). `foldMovements` gives `inStock / committed / available` per material; a **pure priority-allocation** function turns available stock + priority-ordered demand into per-WO **coverage traffic lights** (green covered / amber partial / red short — which material). Reordering priority recomputes coverage. (Reservation is at production start — the Katana verdict — never at quote.)
- **CUTTING finish → actual material use** — finishing Cutting prompts the real quantities used (`actualMaterialUse` Json) → writes **OUT + RELEASE** (consume the reserved material), and surfaces the **diff vs the BOM estimate**.
- **QC + the cert gate (FD14)** — the QC stage carries a **checklist** (items ticked with user + timestamp), optional photos, and `certCheckPassed`; **finishing QC into Packing is BLOCKED if the order's template has no covering `Certificate` or it is expired** — with the reason shown. Scrap + reason at any stage (an ADJUST-style note + optional material OUT).
- **est-vs-actual cost panel (Owner-only)** — per WO: estimated cost (BOM + est) vs actual material consumed, grain-gated (`financials.costs.view`). Labor→cost from the timers is deferred (v1 records time only).
- **The shop-floor Worker view** — the Workers' page (auto by role, or `?worker=1`): a **my-queue** list sorted by priority ("your next task is the top line"), big **Start / Pause / Finish**, ingredient traffic lights, a comment composer — and **no money anywhere** (WORKER has no financial grains → server-stripped; a dedicated test asserts zero money in the worker payload).

**OUT (named, so the boundary is explicit):**
- **Capacity/scheduling math** (Gantt, finite capacity) — IGNORE verdict; the only scheduling cue is a "latest safe start" warning derived from the promise date.
- **Labor cost from timers** — timers record time in v1; turning minutes into `actualCostCents` via a labor-rate AppSetting is a follow-up.
- **The Materials registry, lots, receiving, POs** — that's **FP7 / Materials** (this cycle consumes against the ledger and reads stock, but managing materials/lots lives there).
- **QC photo upload** — the checklist + cert gate + scrap are in; photo attachment (local/Drive) is flagged for a follow-up (as with FP5 measurements).
- **Certificate management UI** (create/edit certificates) — FP2's cert registry owns that; FP6 only *reads* it for the gate.

## Layout

**`/production`** — Owner board by default; Worker view when the role is WORKER or `?worker=1`.

```text
OWNER BOARD:  stage columns (Cutting · Stitching · Assembly · QC · Packing · Done) from production.stages
  card:  WO ORD-214/1 · party · priority ⋮⋮ · promise chip · 🟢🟡🔴 ingredient lights · [Start|Pause|Finish] · assignee
  drag a card up/down its column-set = reorder priority ⇒ coverage recomputes
WO DETAIL (drawer):  stages (timer each) · materials (need vs available) · QC checklist · scrap · est-vs-actual* (Owner)
WORKER VIEW:  "My queue" (priority-sorted)         · big card: WO · garment · stage · 🟢🟡🔴 lights
  ▸ top line = your next task    [ ▶ Start ]  [ ⏸ Pause ]  [ ✓ Finish ]   · comment   · NO money
```
`*` = grain-gated (est-vs-actual behind `financials.costs.view`; the entire Worker payload composes with no grains).

## Component reuse

| Region | Components |
|---|---|
| Owner board | `@dnd-kit/core` (priority reorder — the FP4 kanban pattern), DS `Card` + `Pill` lanes, stage columns |
| Stage buttons / timers | DS `Button`, a small `StageTimer` (ticking elapsed), `Pill` for stage state |
| WO detail | DS `Drawer` (side panel), `Card`, checklist rows (`Checkbox`), `Modal` for actual-material-use + scrap |
| Traffic lights | a `CoverageDot` (🟢🟡🔴) driven by the fold + allocation |
| Worker view | large touch-friendly `Card`s (kiosk), big buttons; the comment composer reuses FP1's mention pipeline |
| States | `Skeleton`, `EmptyState` ("nothing in production — Start production on an order"), `useToast` |

## Data & API

**No migration** — `WorkOrder` / `WorkOrderStage` (startedAt, pausedMs, finishedAt, checklist, photos, scrapNotes, actualMaterialUse, certCheckPassed), `MovementLedger`, `BomLine`, `Certificate` all shipped in F1. **No new permissions** — `workorders.advance/assign`, `materials.consume`, `pages.production` seeded (WORKER already scoped to production + advance + consume).

**Pure modules (heavily tested — the risk lives here):**
- `src/lib/production/stage-timer.ts` — `elapsedMs(stage, now)` (active time = now − startedAt − pausedMs, pause-aware), `currentStage(stages)`, `advance(stages)`.
- `src/lib/production/reserve.ts` — `bomDemand(template, selections)` → per-material qty; `allocateByPriority(availableByMaterial, worksByPriority)` → per-WO coverage (OK / PARTIAL / SHORT + which material). Pure; the reallocation authority.

**Routes** (all `guarded()` + coverage-checked; money via `jsonStripped`):

| Route | Methods | Permission |
|---|---|---|
| `/api/production` | GET (board: WOs by stage + coverage; `?worker=1` → my-queue, no money) | `pages.production` |
| `/api/production/wo/[id]` | GET (WO detail: stages, materials, checklist, est-vs-actual*) | `pages.production` |
| `/api/production/stages/[sid]` | POST `start`/`pause`/`finish`, PATCH `assign` | `workorders.advance` / `workorders.assign` |
| `/api/production/wo/[id]/priority` | PATCH (reorder → recompute coverage) | `workorders.advance` |
| `/api/production/stages/[sid]/materials` | POST (CUTTING actual use → OUT+RELEASE) | `materials.consume` |
| `/api/production/stages/[sid]/qc` | POST (checklist tick + certCheckPassed; gate on finish) | `workorders.advance` |
| `/api/production/stages/[sid]/scrap` | POST (reason + optional material OUT) | `materials.consume` |
| `/api/production/reserve` | POST (reserve a READY WO's BOM demand — idempotent) | `workorders.advance` |

Reservation contract: reserving a WO writes RESERVE movements for its `bomDemand` (idempotent — skip if the WO already has RESERVE rows). Consumption (CUTTING finish) writes OUT + RELEASE per material actually used (the ledger's consumption pair). Cert gate: finishing QID→Packing calls `certGate(order)` — a covering non-expired `CertificateCoverage`→`Certificate` must exist for the template, else 422 with the reason. The Worker board GET composes with the caller's (empty) grains so money is structurally absent.

## Interactions

- **Owner board:** the WOs from Start-production sit in **Cutting**; each card shows 🟢/🔴 ingredient lights (from the fold). Start Cutting → timer ticks; Finish Cutting → a modal asks the real hide/material used → ledger OUT+RELEASE, the est-vs-actual diff appears. The card advances to Stitching. Drag a rush job up → coverage recomputes (it takes scarce hide first; a lower-priority WO may flip amber).
- **QC → Packing:** tick the checklist, mark cert-checked; if the garment's EN 17092 cert is missing/expired, **Finish is refused** with "cert missing/expired — can't pack" (FD14).
- **All WOs Done → order READY:** when a WO's last stage finishes and all the order's WOs are Done, the order advances to READY (the FP4 manual stopgap now happens for real).
- **Worker kiosk:** a Worker opens `/production` on a phone (LAN, `FACTORY_LAN=1`), sees **My queue** top-down, taps **Start** on the top line, taps **Finish** when done — big buttons, traffic lights, zero prices. Comments post to the WO.
- **Scrap:** any stage → scrap with a reason (+ optional material OUT); surfaced on the WO.

## States

Skeletons on board + drawer; EmptyState ("nothing in production yet — Start production on a confirmed order"); a red **cert-blocked** banner on a QC card that can't pack; amber/red coverage dots with a click-through explaining which material is short; the Worker view has its own big empty state ("no tasks — you're all caught up").

## RBAC

`pages.production` to view; `workorders.advance` (stage start/pause/finish, reserve, priority), `workorders.assign`, `materials.consume` (actual use, scrap) to act; **est-vs-actual behind `financials.costs.view`**. The **Worker payload is composed with no grains** so money is structurally impossible — a dedicated test asserts the `?worker=1` board and WO detail contain no `*Cents`/margin/cost keys. WORKER's nav already shows only Production + Materials (FD9). All permissions seeded in F1 — **no new permissions**.

## Bulk / import-export

Bulk assign a stage across selected WOs; no import (WOs are born from Start-production). A production/ledger slice export lands with FP7's Materials.

## Teardown verdicts applied (traceability)

| Verdict (F0-TEARDOWN) | Where it lands |
|---|---|
| Shop-floor cards, free (not Enterprise-paid) — ADOPT (Odoo) | The Worker kiosk view |
| Kiosk trio (Start/Pause/Finish) + my-plan — ADOPT (MRPeasy) | Stage buttons + priority-sorted my-queue |
| Cost-blind operators — ADOPT (Katana) | Worker payload composed with no grains (tested) |
| Reserve at production start, never at quote — ADAPT (Katana) | RESERVE on WO-ready; consumption OUT+RELEASE at Cutting finish |
| Capacity math — IGNORE | Only a "latest safe start" promise-date warning |
| EN 17092 QC gate before shipment — F0 finding (FD14) | Cert gate blocks QC→Packing |
| Append-only movement ledger — structural | RESERVE/RELEASE/OUT via `foldMovements`; corrections are compensating |

## Acceptance targets (gate-2 click-through)

Start production on a confirmed order → its WO sits in **Cutting** with ingredient lights → **Start** Cutting (timer runs) → **Finish** Cutting → enter the real hide used → the ledger shows OUT+RELEASE and the est-vs-actual diff → advance Stitching → Assembly → **QC**: tick the checklist; with the template's cert **expired**, **Finish is blocked** ("cert missing/expired"); add/refresh the cert → Finish → **Packing** → Finish → the WO is **Done** and the order flips **READY** → drag a second WO's priority up and watch a scarce-material light flip → open the **Worker view** (`?worker=1`) and confirm the my-queue + big buttons + **no money anywhere**. Plus: `stage-timer` + `reserve/allocateByPriority` unit-tested exhaustively; a test proves the Worker payload carries no cost/margin; the cert gate is unit-tested (missing / expired / valid); 126+ existing tests stay green; rbac / no-touch / parity / build green.

## Build plan (no time estimates)

FP6.1 pure `stage-timer` + `reserve` modules (+ heavy tests) + stage Start/Pause/Finish + assign API → FP6.2 Owner stage board (columns, cards, timers, priority drag) + WO detail drawer → FP6.3 reservations (RESERVE on ready, coverage traffic lights, priority reallocation) + CUTTING actual-use (OUT+RELEASE + diff) → FP6.4 QC checklist + cert gate (FD14) + scrap + est-vs-actual panel → FP6.5 the Worker kiosk view (my-queue, big buttons, no-money) + order-READY-on-all-Done + headless verify on isolated :3199 + `FP6-REPORT.md`. Each sub-phase a scoped commit; push at cycle end; STOP for gate 2.
