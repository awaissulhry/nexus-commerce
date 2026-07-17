# EPO3 — The connected order (gate report)

> Shipped 2026-07-17 against `EPO-PROPOSAL.md` §5 EPO.3 (build order .1→.3→…). Kills **C5 E2 E11**. Verification green: 367 tests (44 files, incl. the new timeline suite), `check:rbac` 135 routes, `check:no-touch`, `check:ds-parity` 97/97, `check:query-bounds` 137 files, isolated `.next-verify` build, :3199 probes (login 200 · /orders 200 · `/production?wo=` shell 200).

## Plain English

Everything an order touches is now one click away, in both directions. The order detail grew a chain of chips — Quote · Work orders (n) · Shipments (n) · Invoices (n) · Payments (n) — the "where is everything" answer at a glance. The timeline now links every row to its source (work orders open the production drawer, payments and invoices hop to Financials, reviews to the customer), names WHO drove each move ("→ Delivered · carrier tracking"), finally shows the cancellation reason, and gained three new event types: invoices (issued + paid), promise-date changes, and stage completions. Customer names everywhere on the board are now links to the contact. ⌘K search results actually open the record you clicked (they used to land on the page and forget why). The bell now tells you when an order is ready to ship, when the deposit lands, and when a parcel is delivered. And the board is live — a change made anywhere (another tab, the production floor, the carrier) appears without refreshing.

## What shipped, by defect

| Defect | Fix |
|---|---|
| **C5** search deep-links broken | `api/search` now emits the params pages actually read: `?c=` contacts · `?q=` quotes · `?o=` orders; materials/products/worker-production fall back to honest page-level hrefs (their entity readers belong to EPM/EPD/EPP) |
| **E2** dead-end navigation | Chain-chip row on the detail (Odoo smart-buttons × ERPNext Connections, zero-count chips stay visible but muted); timeline hrefs for workorder→`/production?wo=`, payment/invoice→`/financials`, shipment→`/shipping`, review→`/contacts?c=`, quote-accepted→quote; party names link to contacts from the grid, kanban cards (drag-safe), and the detail sub-line; WO rail rows link to the production drawer; **new `/production?wo=` reader** (D-1, EPP unclaimed — Suspense shell + mount-only param read, stale ids degrade to the plain board); timeline depth: invoices issued/paid, promise changes (fixed-locale date), cancel reason, driver labels via EPO.1's `via`, reopens now visible, stage completions (per-stage rows ≤5 WOs, per-WO roll-ups for size-runs); bell emitters for order moments (ready-to-ship · deposit-met · delivered), all `/orders?o=` |
| **E11** no live board | `useFactoryEvents(["order.updated","workorder.created","workorder.updated","shipment.updated","payment.recorded"])` on both the board and the open detail (FS2 durable bus, 2s debounce, silent degrade) — mirrors the production/analytics wiring |

## Files

`lib/orders/timeline.ts` (rewrite) · `lib/orders/transition-service.ts` (outcome carries `number`) · `lib/quotes/notify-owners.ts` (+`entityType` param, default "quote" — 2-line backward-compatible touch on EPQ's helper, flagged) · `lib/shipping/poll-tracking.ts` · `api/orders/[id]` (+invoices include) · `api/orders/[id]/payments` · `api/production/stages/[sid]` · `api/search` · production `ProductionClient` (+`?wo=` reader) · orders `OrderDetail/OrdersClient/KanbanBoard/Timeline/types` · `__tests__/epo3-timeline.test.ts` (new)

## Click-through (Owner)

1. Open any order → the chip row under the header: click Work orders → the production drawer opens on that WO. Click the party name → their contact page.
2. In the timeline: a work-order row hops to the floor; a payment row to Financials; the cancel entry (on any cancelled order) now shows the reason you typed.
3. ⌘K → type an order number → Enter: the order OPENS (same for quotes and contacts).
4. Two windows: move an order on the board in one — watch the other update within ~2s, no refresh.
5. Finish the last stage of a WO on the floor → your bell rings "ORD-n is ready to ship" and clicking it opens the order.

## Findings / deviations

1. **Page-level hops for payments/invoices/shipments** — Financials' per-order drawer and Shipping's shipment drawer have no URL readers yet; those readers are EPF's (in flight, per D-1) and EPS's (unclaimed). The hrefs upgrade to entity-level the moment those land — one string each in `timeline.ts`.
2. **`notify-owners.ts` touch** — 2 lines on an EPQ-owned helper (optional `entityType`, default preserves quote behavior) instead of duplicating the owner-broadcast query; per the cross-review's anti-duplication rows. EPQ session: no action needed.
3. **Stage-completion volume rule** — per-stage timeline rows only for orders with ≤5 WOs; bigger size-runs get one "Work order completed" row each (a 38-WO run would otherwise add ~190 rows). Constant `STAGE_DETAIL_MAX_WOS` in `timeline.ts`, unit-tested.
4. Search hits for materials/products/worker-view orders are page-level until those pages grow entity readers — honest links, no dead params.

## Rollback

Revert the commit — no migration, no data shape change; the `?wo=` reader and search hrefs degrade gracefully either way.
