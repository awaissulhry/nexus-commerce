# EPO7 — The workbench: scale, brand-view, bulk, navigation (gate report)

> Shipped 2026-07-17 against `EPO-PROPOSAL.md` §5 EPO.7 (core). Kills **C6** and most of **E9 / E12 / E14**; the D-5 **`?party=` brand-view contract** is now live and registered program-wide. **Deferred to a named follow-up (EPO.7b), flagged below:** personal saved views, historical-order CSV import, the remaining DS/hex sweep. Verification green: 532 tests, rbac 137, no-touch, ds-parity, query-bounds 139, isolated build, :3199 probes (page 200, `?party=` 200, filtered-export guards 401).

## Plain English

The orders grid no longer stops at 200 — it windows its rows (only what's on screen is in the DOM) and a "Load more orders" button pages through the rest, so the board stays fast at any order count. The party filter became a **brand view**: pick a brand (or arrive from a link on their contact/financials page) and the whole board scopes to them, shown as a dismissible "{Brand} ×" chip; the scope lives in the URL (`/orders?party=…`), so it's linkable, bookmarkable, and the browser Back button works. You can now **select orders and act on the batch** — cancel many with one reason, or export just the filtered set. The CSV export honors whatever filters are active. And the browser **Back button finally closes an open order** instead of skipping past it, with a proper loading skeleton replacing the old blank flash.

## What shipped

| Item | Detail |
|---|---|
| **VirtualDataGrid (C6)** | Replaced the DS `DataGrid` with the FS3 windowed grid (assigned adoption); the API cursor is now consumed — "Load more orders" appends pages into `gridExtra`, DOM stays bounded. The 200-row silent cliff is gone |
| **AsyncCombobox party filter (FS3)** | Whole-list `Listbox` → paged type-to-find over `/api/parties-lite?q=`; no whole-list prefetch |
| **`?party=` brand-view (D-5, E14)** | Party filter is URL state; `/orders?party=<id>` is the standing deep-link contract other pages link to (registered in the program invariants). Dismissible brand chip; label resolved for bare inbound links |
| **Bulk actions (E9)** | Checkbox select column + `BulkActionBar`: bulk cancel (one reason, each order still validated + audited server-side — no guard-bypassing bulk endpoint; non-cancellable selections skipped with a count) + export-filtered |
| **Export honors filters (E9)** | `/api/exports/orders` takes the same where-grammar as the list (state/party/q/date-range); bare request still exports all |
| **Back closes detail (E12)** | `openDetail`/`closeDetail`/`setPartyFilter` use `pushState` (was `replaceState`); a popstate listener reloads the list on return. Party scope preserved across open/close |
| **Skeleton (E12)** | First-load skeleton rows replace the empty-state flash / zero-pop |

## Files

`api/exports/orders/route.ts` (filter-aware) · orders `OrdersClient.tsx` (the workbench) · (consumes existing `VirtualDataGrid`, `AsyncCombobox`, `BulkActionBar`, `Skeleton` — no new components)

## Click-through (Owner)

1. /orders → the grid scrolls windowed; with >200 orders, "Load more orders" pages through (dev DB has 1, so the button is dormant — exercised on the FS0 harness).
2. Pick a brand in the party box → the board scopes, a "{Brand} ×" chip appears, the URL shows `?party=…`; press browser Back → filter clears. From a contact page, a future "orders" link lands here pre-scoped.
3. Tick a few orders → the bulk bar rises → Cancel selected (one reason) or Export filtered CSV.
4. Open an order → press browser Back → it closes to the list (previously Back skipped the board).

## Findings / deviations — the deferred EPO.7b

Deferred consciously to keep this commit cohesive and reviewable; each is real remaining EPO.7 scope, not dropped:

1. **Personal saved views (pinned tabs)** — the `SavedView` model + `/api/saved-views` route exist but the route is gated `pages.analytics` (FP10-owned). Reusing it for orders needs that permission broadened — a shared-substrate touch to coordinate, not an EPO reach-in. Flagged for a saved-views substrate owner / the next EPO.7b.
2. **Historical-order CSV import (dry-run)** — a full parse→diff→apply pipeline (the Settings import is the reference shape); its own sub-phase. Deferred.
3. **Remaining DS/hex sweep** — the hand-rolled Grid|Kanban toggle (→ SegmentedControl), tab buttons (→ Tabs), counters (→ MetricStrip), raw inputs (→ Input), and inline hex still stand. The proposal's "zero raw hex on the page" bar is a dedicated cosmetic sweep; EPO.7b.
4. **Client column sort intentionally omitted** — with cursor pagination it would reorder only loaded rows (a footgun); the server's promise-asc sort stays the single truth. Sorting the full set is a server-sort-param upgrade if wanted.
5. **Bulk cancel loops the per-order endpoint** — correct (each validated/audited) but sequential; fine at factory scale (dozens). A true bulk endpoint would need the same per-order guard, so no shortcut taken.

## Rollback

Revert the commit — no schema/migration change; all additive UI + one filter-aware export route.
