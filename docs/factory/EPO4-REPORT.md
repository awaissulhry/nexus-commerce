# EPO4 — Promise integrity + the Needs-attention cockpit (gate report)

> Shipped 2026-07-17 against `EPO-PROPOSAL.md` §5 EPO.4, scoped per cross-review **M2** (fulfillment/promise exceptions only — billing/AR exceptions are EPF.5's). Kills **E3 E4**. Includes EPF's **D-9 field request** (clientRef / urgent / remakeOf) in the same additive migration. Verification green: 493 tests (54 files, incl. the new promise-fold suite), rbac 137 routes, no-touch, ds-parity, query-bounds 139 files, isolated build, :3199 probes.

## Plain English

The board now opens on **"Needs attention"** — only the orders that actually need you, each labeled with why: **late** (promise passed), **at risk** (the remaining production stages need more days than are left, at your factory's real historical pace — flagged *before* it's late), **deposit blocking** (work can't start until money lands), or **stalled** (in production but nothing has moved in a week). Everything healthy stays out of the way; the empty state says so positively.

Promises now have memory. The **first promise is recorded forever** — change the date and the original stays visible ("Originally 12/07"); every change that pushed the date later counts as a slip, and the order wears a **"slipped ×2"** badge on the board and the detail (the differentiator none of the researched vendors ship). And per Financials' request, orders now carry a **customer reference**, an **urgent** flag (visible on the grid, kanban cards, and the detail header), and a remake-of link (field only — EPO.5's returns flow wires it).

## What shipped

| Item | Detail |
|---|---|
| **Migration `epo4_promise_integrity`** | Additive: `originalPromiseDateAt` (backfilled from current promises — 1 order live), `clientRef`, `urgent`, `remakeOfId`; applied via the busy-timeout DDL dance (live-server lock), recorded with checksum, client regenerated |
| **Immutable original** | First promise set seeds `originalPromiseDateAt` server-side; promise audits now carry the before-value; slips derived from the trail by `countSlips()` (later-than-previous = slip; clears don't count) |
| **At-risk fold** | `promiseRisk()` — remaining unfinished stages × global historical per-stage pace (one scalar SQL aggregate over finished stages) vs days left; only CONFIRMED/IN_PRODUCTION; no history ⇒ honest silence; late is its own state, never double-flagged |
| **Needs-attention cockpit** | `?attention=1` list mode scanning active states; reasons per row (`late / at-risk / deposit-blocked / stalled`, `STALLED_AFTER_MS` = 7 days of stage silence on IN_PRODUCTION); page-bounded aggregates (per-page stage progress + last activity, page-ids audit fetch); default tab, "Why" chip column, positive empty state |
| **Promise cell** | Slip badge + at-risk chip on the grid; detail Dates card shows Originally-row (when different), risk chips, and the honest arithmetic ("Remaining stages need ~4d at recent pace; 2d left") |
| **D-9 fields** | clientRef autosave input + urgent toggle (audited `field-edited`, live via `order.updated`); urgent pill on grid rows, kanban cards, detail header |
| **Date filter** | Created-from/to range on the grid (server-side where-range) |

## Files

`prisma/schema.prisma` + `migrations/20260717180000_epo4_promise_integrity/` · `lib/orders/promise.ts` (new pure module) · `lib/orders/transitions.ts` (+`field-edited` via) · `api/orders/route.ts` (attention mode, range filter, per-row promise data) · `api/orders/[id]/route.ts` (promise block, original seeding, D-9 PATCH) · orders `OrdersClient/OrderDetail/KanbanBoard/types` · `__tests__/epo4-promise.test.ts` (new)

## Click-through (Owner)

1. **⚠ Restart `npm run dev -w @nexus/factory` if you haven't since EPO.1** — this phase adds columns too (trap 6b; the :3100 client must reload).
2. /orders now opens on Needs attention. Your live order (deposit-gated) should sit there with its reason chip; the All tab is one click away.
3. Change a promise date to later → the "slipped ×1" badge appears and "Originally …" shows in the Dates card. Change it earlier → no new slip.
4. Details card: type their PO into Customer reference (saves on blur), hit "mark urgent" → the red pill follows the order to the board and kanban.
5. The date range boxes next to search narrow the grid by creation date.

## Findings / deviations

1. **Pace is global, not per-stage-type** — one average across all finished stages. Honest v1 (MRPeasy-style simplification per the proposal); per-stage medians are a one-query upgrade once more stage history exists.
2. **`remakeOfId` is a bare column** (no FK, no UI) — EPO.5's returns/remake flow formalizes it; recorded so nobody wires it ad-hoc.
3. **Aggregates for Analytics** — the folds (`countSlips`, `promiseRisk`) are exported pure; EPA consumes them for on-time-vs-original stats when it claims (per the EPQ anti-duplication pattern; nothing built on /analytics here).
4. The cockpit reads fulfillment-side only per M2 — margin-floor/unbilled/AR exceptions intentionally absent (EPF.5's queue).

## Rollback

Revert the commit; migration is additive (nullable/defaulted columns) — safe to leave.
