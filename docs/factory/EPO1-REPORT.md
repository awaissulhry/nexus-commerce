# EPO1 — State-machine truth & write integrity (gate report)

> Shipped 2026-07-16 against `EPO-PROPOSAL.md` §5 EPO.1 (approved "Proceed however you recommend"). Kills **C1 C2 C3 C4 C8 C9**. All verification green: 313 tests (41 files, incl. the new authority suite), `check:rbac` 126 routes, `check:no-touch`, `check:ds-parity` 97/97, `check:query-bounds` 128 files, isolated `next build` (.next-verify), a 10-check live-db smoke, and a :3199 boot probe (login 200 · unauth API 401 · /orders 200).

## Plain English

Before this phase, four different pieces of code could silently rewrite an order's status around the rulebook, the board still had a "mark shipped by hand" popup from before the Shipping page existed, clicking Record payment twice took the money twice, and two people editing the same order overwrote each other without warning. Now there is exactly **one door** every status change walks through — it checks legality, refuses stale writes, writes the audit row, and broadcasts the event, every time, no matter who's driving (you, the production floor, the label purchase, or the carrier's tracking). The hand-ship popup is gone: Shipped happens by buying a label. A double-clicked payment lands once. And if an order changed under you, you get "the order changed elsewhere — refresh" instead of silently clobbering it.

## What shipped, by defect

| Defect | Fix |
|---|---|
| **C1** stale manual mark-shipped | Modal + tracking-note path deleted from `OrdersClient`; grid menu / detail menu SHIPPED items now read "→ Shipped — buy label" and route to `/shipping?buy=`; kanban drop on SHIPPED routes there too; SHIPPED lane header says "via label" |
| **C2** drivers bypass the authority | New `src/lib/orders/transition-service.ts` — THE single writer of `Order.state` (`canTransitionVia` legality → guarded `updateMany` → companion writes in the same txn → one audit row + one durable `order.updated`, both carrying `via`). All four drivers rerouted: stage-done→READY, buy→SHIPPED (party address write rides the same txn), tracking→DELIVERED, void→READY. The void edge SHIPPED→READY is now IN the graph as a system-only edge (`label-voided`), still never offered in menus |
| **C3** silent mutations | Promise-date changes and line edits now publish durable `order.updated` events (`via: promise-changed / line-edited`); WO cascades write **per-WO** audit rows (created / unblocked / cancelled with `via`) alongside the order-level roll-up |
| **C4** payment double-submit | Additive migration `epo1_payment_idempotency` (`Payment.idempotencyKey` unique); the modal mints a UUID per open; the route replays duplicates (`{ok, duplicate:true}`) instead of recording twice — race-proof via the unique constraint (P2002 → duplicate) |
| **C8** silent deposit-gate off | Detail payload gains `money.depositTermsMissing`; the rail now says "No deposit terms — this order has no originating quote, so the deposit gate is off" instead of hiding the card |
| **C9** no concurrency guard | D-6 as approved: PATCH/cancel accept `expectedUpdatedAt`; the service's `updateMany` where-clause pins `state=from` (+ the stamp when supplied); mismatch → 409 "changed elsewhere — refresh and retry"; both clients send stamps and refresh on 409 (Undo intentionally skips the stamp — the state pin still protects it) |

## Files

`src/lib/orders/transitions.ts` (+`TransitionVia`, system edges, `canTransitionVia`) · `src/lib/orders/transition-service.ts` (new) · `src/lib/__tests__/epo1-transition-authority.test.ts` (new) · `api/orders/[id]` + `/cancel` + `/payments` + `/start-production` + `/lines/[lid]` · `api/production/stages/[sid]` · `api/shipping/buy` + `[id]/void` · `src/lib/shipping/poll-tracking.ts` · orders `_components/{OrdersClient,OrderDetail,KanbanBoard,types}` · `prisma/schema.prisma` + `prisma/migrations/20260716120000_epo1_payment_idempotency/`

## Click-through (Owner)

1. **⚠ FIRST: restart `npm run dev -w @nexus/factory`** — the running :3100 server caches the old Prisma client (playbook trap 6b); recording a payment there would 500 until the restart.
2. /orders → any READY order → state pill menu: "→ Shipped — buy label" lands you in the Shipping buy drawer (no more manual popup). Kanban: drag a READY card onto Shipped — same.
3. Open an order → Record payment → double-click Record fast: one payment, second click toasts "Already recorded".
4. Open the same order in two tabs → change the promise date in one → change state in the other: the second gets "changed elsewhere — refresh and retry" and reloads.
5. Cancel an order with open WOs → each WO now has its own audit row (the timeline still shows the roll-up; per-row trail is in AuditLog for EPO.3's timeline depth).

## Findings / deviations (flagged, not silently fixed)

1. **Audit/event atomicity** — they fire post-commit on the one code path (ordering-guaranteed), not inside the transaction, consistent with F1's never-throw audit philosophy. A crash in the ~ms between commit and audit could drop a row; accepted (same exposure as every FP cycle), noted for FS4's write-transaction substrate.
2. **Manual ship escape hatch** — removed from ALL UI; the server PATCH edge READY→SHIPPED (`via: manual`) stays legal and audited for emergencies (API-only). Flag if you want it fully closed.
3. **Migration under a live server** — the Owner's running dev server + FS2's 1s outbox poller hold the SQLite lock and `prisma migrate deploy` doesn't wait; applied the additive DDL via a busy-timeout connection and recorded it with the checksum Prisma expects. `prisma migrate status`: **"Database schema is up to date!"**. Future factory migrations should expect the same dance (or a brief server stop).
4. **Buy-labels race honesty** — if labels get bought but the order refuses to flip (state race), the route now returns the error WITH the bought labels listed instead of pretending success; previously it wrote SHIPPED unconditionally.
5. The duplicated Cancel modal (board + detail) and the rest of the element-level DS debt stay as catalogued — EPO.7's scope, not EPO.1's.

## Rollback

Revert the commit; the migration is additive (nullable column + unique index) and safe to leave in place.
