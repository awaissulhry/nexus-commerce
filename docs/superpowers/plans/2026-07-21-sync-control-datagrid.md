# Sync Control × DataGrid — SCG series (owner-requested rebuild)

**Trigger (owner, 2026-07-21):** the Sync Control table is hard to read; rebuild it on the shared component from `/products/next`; dropdowns must follow the design system; long cards must not load everything at once; bulk changes should work like the products grid.

**Shipped immediately (b1b910d8c):** DS stylesheets imported (dropdowns were rendering unstyled — the page had the Listbox component without `tokens.css`/`components.css`), History + upload-vs-pool cards capped at 5 rows with Show-all toggle, search debounced 250ms.

## What /products/next is made of (research)

| Piece | Source | Role |
|---|---|---|
| `DataGrid<T>` | `design-system/components/DataGrid.tsx` | universal grid: column model (render/sort/sticky/width), selection Set + select-all, totals, maxHeight, empty state |
| `GridToolbar` | `design-system/patterns` | one card with the grid; left slot swaps search ⇄ bulk actions when selection > 0; right slot density/customise/export |
| `FilterBar` | `design-system/patterns` | declarative dimensions (select/multiselect/range/toggle), collapsible panel, Clear |
| `PreferencesModal` | `design-system/patterns` | column show/hide + sort prefs |
| `Pagination` | `design-system/components` | pager |
| primitives | `Button, Input, Pill, SegmentedControl, Tooltip` | controls |
| styles | `tokens.css + components.css + patterns.css` imported by the page | all `.h10-ds-*` classes; `.dark` block = dark-mode aware |
| pattern | `h10-ds-gridcard` wrapper; `ToastProvider` boundary for DS toasts | |

## SCG.1 — the grid swap (the core)

Rebuild the listings table as `DataGrid<Row>` inside `h10-ds-gridcard`:

- **Columns:** SKU (sticky left, mono, 220px, sortable) · Channel · Market · Lane (Listing/Shared + itemId chip) · Mode (DS `Pill`, tone per mode: Follow=green, Pinned=blue, Paused=amber, FBA=neutral "Amazon-managed", Uncounted=slate, Excluded=rose) · Intended (right, sortable) · Live (right) · Buffer (right) · Routed from. Totals row off (quantities across modes don't sum meaningfully).
- **Selection & bulk:** DataGrid `selected` Set + `GridToolbar` slot-swap. Selection bar buttons: Set Follow · Pin · Pause · Resume · Zero-pin · Exclude · Include · Buffer `[n]` Apply · Clear — same `runAction` + `useConfirm` flow as today (server guards unchanged).
- **FBA safety in the shared component:** add optional `rowSelectable?: (row: T) => boolean` to `DataGrid` (additive; absent = today's behavior, `/products/next` untouched). FBA rows render a disabled checkbox with tooltip "Amazon-managed — excluded from actions" and are excluded from select-all. This makes the untouchable rule visible at the grid, not just at action time.
- **FilterBar dimensions:** Channel (select) · Market (select) · Mode (select) · Lane (select) — with active-count + Clear. Search stays in the toolbar left slot (products-next parity), debounced.
- **Pagination:** DS `Pagination` under the grid; server-side paging stays (1,760 rows must not load at once); page size picker 50/100/200.
- **Density:** `SegmentedControl` (Compact/Cozy/Spacious) with the same css-module padding approach.
- **Theme:** fulfillment chrome is dark-capable; tokens.css `.dark` block covers it — verify both themes by screenshot.

## SCG.2 — full-history + card polish

- History card "Show all" currently expands inline over the last 20 — add **`/fulfillment/stock/sync-control/history`** sub-page (opens in new tab from the card) rendering the full `SyncControlAudit` on the same DataGrid, server-paginated (`GET …/audit?page=`). Same for upload-vs-pool if it outgrows its card.
- Policies/locations cards restyled with DS Card classes for visual consistency (structure unchanged — they're small).

## SCG.3 — verification gate (before "done")

1. `tsc` web + api, full battery.
2. Local preview `next dev :3000` against prod API — screenshot self-verify: light + dark, all 3 densities, selection bar, every mode chip, FBA disabled checkbox, filters, pagination.
3. Deploy (Vercel), then the same walkthrough on prod including one net-zero bulk action (Pin→Follow on one row) proving the wiring end-to-end.
4. Memory + this doc updated.

**Not in scope:** any behavior/endpoint change to actions, policies, routing, or derivation — this is presentation only. Flat-file pages untouched.
