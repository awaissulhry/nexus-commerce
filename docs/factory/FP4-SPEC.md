# FP4 — Orders: page-cycle spec (awaiting Owner approval)

Written 2026-07-05 on FP3's approval. Gate 1 of the FP4 double gate — nothing below is built until the Owner approves. Seeds: `F0-IA.md` §2, PLAYBOOK §11-FP4, and the Katana / NetSuite / ERPNext / MRPeasy / monday verdicts in `F0-TEARDOWN.md`. **This is where the `ORD-1` the FP3 cycle created gets its home.** FP3 closed the golden flow's first half (email → priced quote → accepted → a bare Order record). FP4 makes that Order the operational truth: a board you run, a lifecycle you drive, one timeline that tells the whole story from the email forward, one-click **Start production** that spawns the Work Order, and the deposit gate (FD13) that holds cutting until the money lands.

## Purpose (one sentence)

Give every confirmed job a single operational home — a status board + kanban with monday-grade interactions, a one-screen timeline that stitches email → quote version → confirmation → payments → work-order stages → shipment → review from the linked records, one-click Start-production that explodes the Work Order from the Settings pipeline, and deposit-gated production (FD13) — without touching the production floor itself (that's FP6) or shipping labels (FP8).

## Scope

**IN (FP4):**
- **The `/orders` operational board** — a DataGrid by state (Confirmed · In production · Ready · Shipped · Delivered · Closed · Cancelled · All) with per-state counts, party filter, promise-date sort, number/party search, three live counters (**In production · Awaiting deposit · Overdue**), money columns grain-gated. monday-grade row interactions: click the state pill → an inline transition menu (only legal edges, guarded); hover-reveal quick actions; a sticky batch bar on multi-select; an **undo toast** after a batch status change that applies the *reverse* transition (append-only history — undo is a compensating edge, never a mutation).
- **Kanban by state** — lanes for the live states (Confirmed → In production → Ready → Shipped → Delivered); drag = a **validated command**, not a field write: the server accepts the transition only if legal (e.g. cannot enter SHIPPED without a shipment — FP8), else the card snaps back with the reason in a toast. Cancelled/Closed are filters, not lanes.
- **Order lifecycle state machine** — CONFIRMED → IN_PRODUCTION → READY → SHIPPED → DELIVERED → CLOSED, plus CANCELLED (reason required) with a named **reopen** backward edge; every transition audited + event-published. Forward-only with named backward edges (the platform rule). The transition table is enforced server-side (§Interactions), not in the client.
- **The ONE-TIMELINE** (the signature view) — on the order detail, a single chronological thread assembled from the linked records + AuditLog: the originating **email** (conversation), each **quote version** (QuoteVersion snapshots, with a link to the frozen PDF), **confirmation**, **payments**, **work-order stage** rows (read-only in FP4 — created here, run in FP6), **shipment** (when FP8 adds it), **review** (when present). Pure read/merge; no new writes.
- **Start production** — one click on a CONFIRMED order → create Work Order(s) `ORD-n/k` with **stage rows from the AppSetting `production.stages` pipeline** (default CUTTING → STITCHING → ASSEMBLY → QC → PACKING); the order advances to IN_PRODUCTION. **Deposit gate (FD13):** if the order carries a deposit requirement (from the born-from quote's `depositPct`) and the recorded deposit is short, the Work Order is created **BLOCKED** with `blockedReason = "awaiting deposit"` and the block is visible on the board; otherwise READY. One WO per order line; a line carrying a **size-run** explodes into one WO per size (labelled).
- **Payments / deposit recording** — record a `Payment` (DEPOSIT / BALANCE / OTHER; amount, method, note) against the order; when the cumulative deposit meets the requirement, the BLOCKED Work Order **unblocks** (BLOCKED → READY) with an audited event. No payments *integration* — recording is a manual act (FD13); this is not accounting (FP9).
- **Size-run entry for B2B lines** — a matrix editor (`sizeRun` Json: {size: qty}) on an order line while the order is pre-production; totals roll into the line qty; drives the per-size WO explosion at Start production.
- **Promise-date edit** — inline, audited.
- **Order-history CSV import** (dry-run, for migrating old records) + orders CSV **export**.

**OUT (named, so the boundary is explicit):**
- **The production floor itself** — stage Start/Pause/Finish timers, QC checklists, photo capture, scrap capture, the CUTTING actual-material prompt, **material reservation/consumption ledger writes**, the EN 17092 **cert gate at QC** (FD14), est-vs-actual **labor** cost. All FP6/FP7. **FP4 creates the Work Order + its stage rows and shows them read-only in the timeline; it does not run them.** (`workorders.advance/assign` stay unused until FP6.)
- **Shipments & labels** (FP8). The board's →SHIPPED transition is guarded on a shipment that does not exist yet; v1 offers a clearly-labelled **manual "Mark shipped/delivered"** stopgap (audited, optional tracking note) so the board is usable end-to-end today — exactly the pattern FP3 used for manual accept. Removed the moment FP8 lands real shipments.
- **Real invoicing / accounting** (FP9). Payments are manual `Payment` rows; no `Invoice`, no VAT, no ledger export here.
- **IN_PRODUCTION → READY auto-advance** (when all WOs DONE) belongs to FP6 (which runs the WOs). FP4 allows a **manual** READY transition (audited), flagged as the honest stopgap until the floor drives it.
- **Bulk assign** — deferred to FP6: assignment lives on `WorkOrderStage.assigneeId`; Orders have no assignee field and adding one now would be speculative. FP4 bulk = status + export.
- Reviews pipeline (own cycle); the timeline merely *shows* a `Review` if one exists.

## Layout

**`/orders`** — board (grid ⇄ kanban toggle); clicking an order opens the full-screen **OrderDetail** with the one-timeline.

```text
BOARD:   counters row (In production · Awaiting deposit · Overdue) · [Grid | Kanban] toggle · state tabs · party filter · search
  GRID:  number · party · state pill(click→transition menu) · net* · margin*(pill) · deposit chip (due/paid) · promise-date(overdue red) · WOs · updated
  KANBAN: lanes Confirmed → In production → Ready → Shipped → Delivered ; card = number · party · net* · deposit chip · promise ; drag = validated command

ORDER DETAIL (ORD-214):
┌ header: ORD-214 · party · state pill · [Start production] [Record payment] [⋯ cancel/reopen]  ·  born-from Q-214 ↗
├──────────── ONE-TIMELINE (left, flex) ───────────────┬──────── ORDER RAIL (360px) ────────┐
│  ● email received — "AWA ORDER 652…"        ↗ thread │  Party card (contact, terms*)      │
│  ● quote Q-214 v1 sent               ↗ frozen PDF    │  ── money ──                       │
│  ● quote accepted (customer link)                    │  Net* · Cost* · Margin*  (grain)   │
│  ● order confirmed (ORD-214)                         │  ── deposit (FD13) ──              │
│  ● deposit recorded  €X (30%)                        │  required €X · paid €Y · [Record]  │
│  ● production started → WO ORD-214/1 (BLOCKED→READY) │  ── dates ──                       │
│  ○ CUTTING · STITCHING · ASSEMBLY · QC · PACKING     │  promise (edit) · confirmed · upd. │
│      (stage rows, read-only — run in FP6)            │  ── work orders ──                 │
│  ○ shipment (FP8)  ·  ○ review                       │  ORD-214/1 · state · stages n/5    │
└───────────────────────────────────────────────────────┴────────────────────────────────────┘
```
`*` = grain-gated (server-stripped via `jsonStripped`; a caller without `financials.*` never receives cost/margin/deposit money).

## Component reuse

| Region | Components |
|---|---|
| Board grid | `DataGrid`, `Pill`, the three counters (FP3 `Counter`), `Input` search, tab row (FP3 pattern) |
| Kanban | DS `Card` + `Pill` lanes; drag via `@dnd-kit/core` (monorepo dep; **new to apps/factory** — flagged like `pdfkit` was) — optimistic move with rollback-on-reject |
| Order detail | `PageHeader`/back pattern (FP3 editor), `Card`, `Pill`, `DateField` (promise edit) |
| Timeline | a small `TimelineItem` presentational component (typed icon + label + time + link) — new, DS-tokened; no new primitive |
| Start production / cancel / payment | DS `Modal` confirm-with-consequences (deposit summary, WO preview, cancel reason) + `useToast` |
| Size-run | a `SizeRunMatrix` editor (Input grid) — new, small |
| States | `Skeleton`, `EmptyState`, undo `useToast` |

## Data & API

**Migration `fp4_orders`** (nearly migration-free — all Order/OrderLine/WorkOrder/WorkOrderStage/Payment entities shipped in F1): a single additive column **`WorkOrder.label String?`** — a human tag for per-size / per-line work orders ("Size 50 · ×3"). Applied via the patient better-sqlite3 recipe from FP3 (stop the dev server briefly or `busy_timeout`). Nothing else changes.

**Routes** (all `guarded()` + coverage-checked; money via `jsonStripped`):

| Route | Methods | Permission |
|---|---|---|
| `/api/orders` | GET (list + counters) | `pages.orders` |
| `/api/orders/[id]` | GET (detail incl. assembled timeline), PATCH (promise-date, state transition, cancel reason) | `pages.orders` / `orders.edit` / `orders.cancel` |
| `/api/orders/[id]/start-production` | POST (create WO(s)+stages from pipeline; deposit gate; → IN_PRODUCTION) | `orders.edit` |
| `/api/orders/[id]/lines/[lid]` | PATCH (size-run matrix; qty — **CONFIRMED/pre-production only**) | `orders.edit` |
| `/api/orders/[id]/payments` | POST (record Payment; unblock WO if deposit met) | `payments.record` |
| `/api/orders/bulk` | POST (status transition on a selection; undo = reverse edge) | `orders.edit` |
| `/api/imports/orders` | POST (dry-run CSV of historical orders) | `imports.run` |
| `/api/exports/orders` | GET (CSV) | `exports.run` |

**No new permissions** — `pages.orders`, `orders.edit`, `orders.cancel`, `payments.record` were all seeded in F1 (WORKER lacks them; nav hides Orders for WORKER). `workorders.advance/assign` remain reserved for FP6.

**Transition contract** — a single server-side `canTransition(from, to, order)` (pure, exhaustively tested) is the only authority; the client renders menus/lanes from it but never decides legality:

| From → To | Guard |
|---|---|
| CONFIRMED → IN_PRODUCTION | via Start production (creates WO[s]); deposit short ⇒ WO BLOCKED, order still advances |
| CONFIRMED / IN_PRODUCTION → CANCELLED | reason required; compensating events; WOs → CANCELLED |
| IN_PRODUCTION → READY | manual in FP4 (auto-when-all-WOs-DONE is FP6) — audited stopgap |
| READY → SHIPPED | requires a shipment (FP8); v1 manual "Mark shipped" stopgap w/ optional tracking note |
| SHIPPED → DELIVERED → CLOSED | forward; DELIVERED manual until FP8 tracking |
| CANCELLED → CONFIRMED | named **reopen** edge, audited |

**Start-production contract** — read `AppSetting production.stages` (fallback CUTTING/STITCHING/ASSEMBLY/QC/PACKING); for each order line create a `WorkOrder` `ORD-n/k` (a line with a `sizeRun` → one WO per size, `label` = size) with a `WorkOrderStage` row per pipeline stage (`sort` ordered); compute `depositRequiredCents = round(quote.depositPct% × order net total)`; if recorded deposits < required ⇒ WO `state=BLOCKED, blockedReason="awaiting deposit"`, else READY; `estCostCents` = line cost roll-up. All in one transaction; audited; `order.updated` + `workorder.created` events. Idempotent: refuses if WOs already exist (409).

**Timeline contract** — GET `/api/orders/[id]` includes `timeline[]`: merge (a) conversation + its OUTBOUND/INBOUND messages, (b) `bornFromQuote` + its `QuoteVersion`s (+ frozen PDF ref), (c) order create/confirm, (d) `Payment`s, (e) `WorkOrder`s + `WorkOrderStage`s, (f) `Shipment`s, (g) `Review`s, (h) relevant `AuditLog` rows (entityType ∈ {order,quote,workorder,payment,shipment}, entityId ∈ the set) — each mapped to `{ kind, at, label, href?, money?* }`, sorted ascending, money grain-gated. Pure read.

## Interactions

- **Land on `/orders`:** the just-converted `ORD-1` sits in **Confirmed**, deposit chip **"due"**, the **Awaiting deposit** counter lit. Grid ⇄ kanban toggle persists (localStorage).
- **Record deposit:** rail **Record payment** → Modal (kind DEPOSIT, amount prefilled to the requirement, method, note) → save → deposit chip flips **paid**; if a WO was BLOCKED it unblocks with a toast "WO ORD-1/1 unblocked".
- **Start production:** header **Start production** → Modal previews the WO(s) and stages and states the deposit posture (a red "Deposit not yet recorded — the Work Order will be blocked from cutting" if short) → confirm → order → IN_PRODUCTION, WO(s) appear in the rail + timeline; toast "Production started — the floor board is FP6."
- **Drive the board:** click a state pill (grid) or drag a card (kanban) → only legal edges offered; illegal drop snaps back with the reason. Cancel → Modal (reason) → CANCELLED + compensating events. Batch-select → sticky bar → transition all → **undo** toast reverses it.
- **Size-run:** on a CONFIRMED B2B line, open the matrix, enter size→qty; the line qty and totals update; at Start production it explodes to per-size WOs.
- **Timeline:** every row deep-links (email → the thread, quote → the frozen PDF, WO → the rail); it reads top-to-bottom as the job's whole life.
- **Amendment discipline (ERPNext docstatus):** once production starts, lines lock; further changes are audited revisions, never silent edits.

## States

Skeletons on board + detail; EmptyState ("No orders yet — they arrive when you convert an accepted quote"); the deposit-blocked WO shows an amber "awaiting deposit" chip everywhere it appears; illegal-transition toasts carry the reason; the →SHIPPED and manual-READY stopgaps are labelled as such (honesty about the FP6/FP8 boundary).

## RBAC

`pages.orders` to view; `orders.edit` (transitions, start-production, promise, size-run), `orders.cancel` (cancel/reopen), `payments.record` (deposit/balance) to act; every money field (`net/cost/margin/deposit`) behind `financials.*` grains via `jsonStripped` — the board, the rail, the timeline, and the CSV all compose through it, so a no-grains caller structurally never sees cost/margin/deposit money. A dedicated test asserts an order payload for a no-grains caller carries no `*Cents`/margin keys. WORKER has none of these (Orders hidden in nav).

## Bulk / import-export

Bulk **status transition** on a grid selection (with undo via the reverse edge) + orders CSV **export** (number, party, state, net*, margin*, deposit*, promise, dates — money grain-gated). **Order-history CSV import** (dry-run first, like FP1 parties / FP2 materials): map number/party/state/net/promise to seed migrated historical orders as CONFIRMED/CLOSED without production. Bulk **assign** deferred to FP6.

## Teardown verdicts applied (traceability)

| Verdict (F0-TEARDOWN) | Where it lands |
|---|---|
| One-click SO → MO — ADOPT (Katana) | **Start production** → Work Order from the pipeline |
| Quotes/orders never pre-reserve stock — ADAPT (Katana) | Start production creates WO + stages but writes **no** material reservations (FP6/FP7 own the ledger) |
| Created-from chain (drill quote↔order↔WO↔shipment) — ADAPT (NetSuite) | The one-timeline, assembled from linked records + AuditLog |
| docstatus: confirmed docs immutable, amend = revision — ADOPT (ERPNext) | Lines lock at production start; changes are audited revisions |
| Status-words-as-UI, click explains — ADAPT (Katana / MRPeasy) | State pill → transition menu; deposit/WO chips explain on click |
| Board with real row interactions + undo — ADAPT (monday) | Inline transition, hover actions, batch bar, compensating-event undo |
| Kanban drag = validated command not a field write — ADAPT (monday/Katana) | `canTransition` server authority; illegal drop snaps back |
| Deposit-gated made-to-measure — F0 finding (FD13) | WO BLOCKED "awaiting deposit" until a Payment meets the requirement |
| Customer-facing content in Italian — user policy | N/A here — Orders is an internal operator surface (English, per policy) |

## Acceptance targets (gate-2 click-through)

Open `/orders` → the converted **ORD-1** sits in Confirmed with a **deposit-due** chip and the **Awaiting deposit** counter lit → open it: the **one-timeline** shows email → Q-1 v1 sent (link to the frozen PDF) → accepted → confirmed, and the rail shows required-vs-paid deposit → **Start production** with the deposit unpaid → confirm → the order goes **In production** and a Work Order appears **BLOCKED "awaiting deposit"** in the rail + timeline → **Record payment** (deposit) → the WO **unblocks** to READY (toast) and the timeline gains the payment + unblock rows → drag/transition through Ready → try to drop into **Shipped** and see it either use the labelled manual stopgap or refuse (no shipment yet, FP8) → edit the promise date (audited) → batch-select on the grid, change status, hit **undo**, watch it reverse → export the orders CSV → dry-run import a small historical-orders CSV. Plus: `canTransition` unit-tested across every legal/illegal edge; a no-grains order payload proves no cost/margin/deposit money; Start-production is idempotent (second call 409); 96+ existing tests stay green; rbac / no-touch / parity / build green.

## Build plan (no time estimates)

FP4.1 migration (`WorkOrder.label`) + `@dnd-kit/core` dep + `/api/orders` list/detail (with assembled timeline) + `canTransition` pure module + PATCH transitions/promise/cancel + tests → FP4.2 `/orders` board (grid, counters, tabs, party filter, inline transition menu, batch bar + undo) + OrderDetail shell + the one-timeline render → FP4.3 Start-production (WO+stages from pipeline, deposit gate, size-run explosion) + payments recording + WO-unblock + rail → FP4.4 kanban (dnd validated-command) + size-run matrix editor + orders CSV export + dry-run history import + mark-shipped/ready stopgaps → FP4.5 headless verify on isolated :3199 (NO live sends) + `FP4-REPORT.md`. Each sub-phase a scoped commit; push at cycle end; STOP for gate 2.
