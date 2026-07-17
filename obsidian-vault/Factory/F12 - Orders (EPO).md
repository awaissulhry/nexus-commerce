# F12 - Orders (EPO)

> **Route:** `/orders` · **EP code:** EPO · **Status:** 🔨 approved 2026-07-16 — **EPO.1 + .3 + .2 SHIPPED** (.1 transition-service single writer + payment idempotency · .3 connected order: chips, timeline hops+depth, ⌘K fix, `?wo=` reader, bell moments, live board · .2 money strip: quoted/invoiced/paid/balance, est→actual margin, invoices-on-order, payment badge, low-margin flag, credit banner); **EPO.4 (promise integrity + Needs-attention cockpit) next** (order .1→.3→.2→.4→.6→.7→.5).
> Canonical docs: `docs/factory/EPO-PROPOSAL.md` · `EPO-UI-INVENTORY.md` · reports `EPO1/EPO3/EPO2` · base: `FP4-SPEC.md`/`FP4-REPORT.md`

Part of [[F00 - Factory OS MOC]] · flow position: [[F01 - Mission & Golden Flow]] step 3 · program: [[F06 - Enterprise Program (EP)]]

## Purpose

The **operational board** — every confirmed job's single truth from "quote accepted" to "closed and reviewed." Three loyalties: (1) the state machine IS the truth (one authority, no path around it), (2) the order is the hub of the created-from chain (email → quote → order → WOs → shipment → invoice → payment → review, every hop a two-way link), (3) money and promises visible where the work is. FP4 built the board; it was never re-wired to the real FP6/FP8/FP9 lifecycle drivers — that drift is the audit's story.

## Headline bugs (C-register)

- **C1** stale FP8-era mark-shipped modal still live — bypasses real shipping; kanban SHIPPED lane is a legal drop target (violates F0-IA).
- **C2** FP6/FP8 drivers bypass `canTransition` (stage-done→READY, buy→SHIPPED, tracking→DELIVERED, void→READY all write `order.state` directly).
- **C4** payment double-submit records twice (no idempotency key — same route [[F18 - Financials (EPF)]]'s PaymentModal hits).
- **C3** silent mutations (promise-date/line edits publish no event; WO cascades unaudited per-row) · **C5** ⌘K `?focus=` honored only by inbox · **C6** grid silently caps at 200 · **C7** stripped money renders €0,00 not "—" · **C8** deposit gate silently OFF without `bornFromQuote` · **C9** no optimistic concurrency.

## Phases

| Phase | Delivers | Kills |
|---|---|---|
| EPO.1 | `transition-service` = sole writer of `order.state` (canTransition+audit+event+timeline in one txn); drivers rerouted; void edge; payment idempotency; 409 guard | C1-C4, C8, C9 |
| EPO.2 | Money on the order — strip consuming `orderFinancials` (never forked, parity-tested vs EPF's drawer), deposit tracker, invoices, balance badge | E1, C7 |
| EPO.3 | The connected order — chain chips w/ counts, every timeline row an href, search-route param fix, live board via FS2 | C5, E2, E11 |
| EPO.4 | Promise integrity + exception cockpit — immutable original promise + slip history ("slipped ×N" — a differentiator no vendor ships), **Needs attention** default tab | E3, E4 |
| EPO.5 | Amendments (`OrderRevision` + re-approval via EPQ gate) · per-size partial shipments (derived badge, no new state) · returns → rework WOs + credit to EPF | E5-E7 |
| EPO.6 | Zero communication gap — transition-triggered customer drafts into the order's Gmail thread; skip logged; dual composer; FC1 tab host | E8, E10 |
| EPO.7 | Workbench — FS3 VirtualDataGrid (kills 200-cap), saved views as pinned tabs, `?party=` brand chip, filtered export, keyboard core loop | C6, E9, E12-E14 |

Recommended order: .1 → .3 → .2 → .4 → .6 → .7 → .5.

## Decisions awaiting Owner (D-1…D-6)

**D-1 cross-page split** (the key one): search-route fix = EPO · `/production?wo=` reader = EPO (EPP unclaimed) · `/financials?o=` reader = **EPF** · ConvertBar backlink = **EPQ** · inbox order card = **EPI phase 6**. D-2 partial shipments = derived badge, no new state · D-3 customer notifications = pre-filled draft, send-on-confirm, skip logged · D-4 re-approval only on net-total change · D-5 `?party=` URL law program-wide; party-360 stays [[F16 - Contacts (EPC)]]; no global switcher · D-6 `updatedAt` precondition over version column.

## Owns / Consumes

**EPO owns:** the ONE-TIMELINE (10 event kinds) · `canTransition` + the coming `transition-service` single-write-path (pattern [[F13 - Production (EPP)]] and [[F17 - Shipping (EPS)]] will consume) · `POST /api/orders/[id]/payments` · the `?o=` deep-link contract + emerging `?party=` URL law · chain-chip component · notify-on-transition draft pattern.
**Consumes:** `orderFinancials` money node from [[F18 - Financials (EPF)]] (embeds payload, never forks) · FP1 reply pipeline ([[F10 - Inbox (EPI)]]) for all customer sends · EPQ approval-gate for re-approvals ([[F11 - Quotes (EPQ)]]) · FS2/FS3 ([[F22 - Substrate FS Series]]) · [[F21 - Chat & Order Spaces (FC)]] consumes EPO.6's tab host.
