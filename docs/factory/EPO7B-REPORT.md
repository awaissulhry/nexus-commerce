# EPO7b — Workbench completion: saved views · history import · design-law sweep (gate report)

> Shipped 2026-07-17, closing the three items EPO.7 deferred with flags. With this, **every EPO scope item that can be built inside the Orders page's own boundary is done** — the only remainders are cross-boundary by rule (EPO.6 awaits EPI.4's template store; partial shipments await EPS). Verification green: 621 tests (66 files, incl. the import-parse suite), rbac 147 routes, no-touch, ds-parity 97/97, query-bounds 149, isolated build, :3199 probes (saved-views 401 / import 403 unauthenticated).

## Plain English

**Saved views** — set up any combination of tab, search, brand, date range and layout, hit "+ Save view", name it ("Aireon in production"), and it becomes a one-click chip above the grid. Personal, deletable, instant.

**Order history import** — "Import history" takes a pasted CSV of your pre-platform orders (one row = one past order), shows a dry-run of exactly what would happen — every error named per row, nothing written — then applies only the rows that passed. Imported orders keep their real dates so the financial and analytics periods stay truthful, and since they have no originating quote, each one plainly shows "no deposit terms" rather than pretending.

**Design-law sweep** — the last hand-rolled controls on the board became design-system components: the Grid/Kanban toggle (now keyboard-navigable with proper roles), the counter tiles, the search and date fields (proper hover/focus states), the cancelled-order banner. And every date on the page — grid, kanban, detail, timeline — now renders in one fixed format ("22 Jun 2026") instead of three browser-dependent ones.

## What shipped

| Item | Detail |
|---|---|
| **Saved views** | New page-owned route `/api/orders/saved-views` (GET/POST/DELETE, `pages.orders`, per-user) consuming the SHARED SavedView model — FP10's analytics route untouched (registry rule 3: model is substrate, API surface belongs to the page). UI: pinned chips + save modal; config = tab/search/brand(+label)/range/layout |
| **History import** | `lib/imports/orders.ts` on the house parse→diff→apply dry-run idiom (parties import is the reference): pure parse (comma decimals, defaults, per-row errors — unit-tested), diff checks party-exists-by-name + number free/unique, apply mints `ORD-n` when blank, sets true `createdAt`/promise (= original promise), per-order audit rows. Route `/api/imports/orders` (`imports.run`) publishes ONE `import.finished` (M6) — the live board refreshes once; the M6 subscription joined the board's SSE list |
| **DS sweep** | `SegmentedControl` (view toggle — roles + arrow keys), `MetricStrip` (counters), `Input` (search + date range — owned focus/hover), `Banner` (cancelled wash); ALL dates via DS `formatDate` (en-GB, SSR-safe) incl. the Timeline meta (date + fixed-locale time) — was three formats across one feature |

## Click-through (Owner)

1. /orders → filter to a brand + In production → "+ Save view" → name it → the chip applies it from anywhere; × deletes it.
2. Import history → paste the template row (in the modal), Dry run → read the diff → Apply → the order appears with its historical date; its detail says "no deposit terms — no originating quote".
3. Tab to the Grid/Kanban toggle → arrow keys switch it. Every date on the page reads like "22 Jun 2026".

## Findings / deviations

1. **Import v1 is one-row-one-order with a single line** — the honest shape for history books; multi-line historical orders can be entered as separate lines post-import via Amend, or the importer grows a `number`-grouping later. Stated in the modal.
2. **Imported orders skip the state machine deliberately** — they're born at their historical state with an `imported` audit row (no synthetic transition chain); the timeline shows confirmation + audit truth, not a fabricated history.
3. Remaining hand-rolled bits are inside modals/timeline internals (wash notes in the start-production modal, timeline spine styling) — page-level surfaces are now DS-clean; the modal interiors are body copy, not controls.
4. Tabs stay pill-buttons rather than DS `Tabs` — the underline Tabs component drops the count badges the cockpit needs; recorded as a conscious keep, not an oversight.

## Rollback

Revert the commit — no migration; two new routes + one lib + UI.
