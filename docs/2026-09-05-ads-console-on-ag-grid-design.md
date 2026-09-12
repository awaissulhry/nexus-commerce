# The ads console on AG Grid — every grid, same look, same features

**2026-09-06:** The local advertising migration is complete. See [completion and validation notes](2026-09-06-ads-ag-grid-completion.md) for the final scope, shared Nexus additions, browser checks, and unrelated repository guard failures. Nothing has been committed or pushed.

**Owner's instruction (2026-09-05 16:40):** *"We got AG Grid Enterprise on the advertising platform. Replace each and
everything, implement AG Grid, and replicate each and everything exactly as it is, except the headers. Keep each and
every feature, visually it should feel the same. No difference except that we're using AG Grid instead of our own. The
whole advertising platform. AAA quality, no imperfections or inconsistencies."* Then: *"Launch as many sub-agents as
possible, make sure everything's perfect and triple quality."*

Lane: **AGW** (this session, Fable). Ledger: `docs/pes-claims.md`. Nothing is committed — the Owner commits the
programme. Read [`2026-08-28-ag-grid-migration-ag.md`](2026-08-28-ag-grid-migration-ag.md) (the seam bet) and
[`2026-08-28-grid-design-system-gds.md`](2026-08-28-grid-design-system-gds.md) (the engine) first.

## 1. Perimeter — what "the advertising platform" is, measured

`apps/web/src/app/marketing/ads/**` — the Nexus Ads console (65 routes). Three grid kinds live there today:

| Kind | Sites | Today | Becomes |
|---|---|---|---|
| `AdsDataGrid` = DS `WorkspaceGrid` (`patterns/workspace-grid/WorkspaceGrid.tsx`, 1,074 L, hand-rolled `<table>`) | **56** files (52 render sites; `RulesGrid` wraps it for 7 rule tabs) | H10 Ad-Manager look, `.nds-wsgrid` | **`design-system/grid/workspace/WorkspaceGrid.tsx`** — AG Grid behind the IDENTICAL `WorkspaceGridProps` |
| DS `DataGrid` (`components/DataGrid.tsx`, 732 L, `<table>`) | **47** render sites in ads (71 app-wide) | DS `.nds-grid` look | **`design-system/grid/datagrid/DataGrid.tsx`** — AG Grid behind the IDENTICAL `DataGridProps` |
| `campaigns/CampaignsGrid.tsx` (2,190 L, its own `<table>` + pager + storage) | 1 | H10 Ad Manager | rebuilt ON the WorkspaceGrid contract (its filter panel, preset library, modals and cells stay its own) |

Out of scope, stated: the two legacy trees `/marketing/advertising` (41 pages) and `/marketing/ads-console` (11 pages,
17 grid-lens grids) — retirement candidates per `2026-08-03-legacy-ads-retirement-h1.md`, not the platform the Owner
named. The 24 non-ads `DataGrid` sites keep the legacy component; the AG one is a drop-in for them when their lanes
want it. Untouchable rules stand (flat-file editors, FBA quantity, existing import — none are in this tree).

## 2. Decisions

1. **The props contract is the seam.** Every call site keeps its props verbatim. `AdsDataGrid.tsx` (the shim) and
   `patterns/index.ts` re-export the AG-backed component; the 47 `DataGrid` sites in ads change ONE import path.
   Rollback = the shim's export.
2. **Only the table becomes AG Grid.** The chrome around it — filter panel + preset library (`AdsFilterBar`), toolbar
   (count · edit toggle · selection actions · 🔍 · slots · Customize · Export), pager (`.h10-am-pager`), "Latest Report"
   footer, the hover-edit popover (`.h10-editpop`), the DS `PreferencesModal` — keeps its legacy markup, classes and
   CSS byte-for-byte. That is how "no visual difference" is guaranteed for everything the Owner did not exempt.
3. **Headers are the engine's** (the Owner's exemption): AG's header with the DS theme's partitions, sort indicator,
   column menu ("Customise columns…" / "Reset columns" via `columnDialog`), drag-to-reorder and resize. Header height
   is the engine's Spacious tier (46). `tip` → AG `headerTooltip` drawn by a DS-styled tooltip component.
4. **Row geometry is the legacy's — CONTENT-DRIVEN (revised 2026-09-05 23:50 on the baseline's evidence).** The 16 measured pages show 44.5 · 45 · 46 · 47.5 · 50 · 51.3 · 53 · 57.5 · 62 · 82.3px rows and FOUR heights inside one library grid: no fixed number reproduces that, so every cell is AG `autoHeight` with the legacy 12px vertical padding restated on the cell (a row = 12 + content + 12 + the 1px rule, which is what AG measures), and `rowHeight` is the FIXED override for a consumer that asserts one (the Ad Manager's 50). The paragraph below is the original decision, kept for the record. Originally: **Row geometry is the legacy's, fixed per grid.** Measured on `/marketing/ads/campaigns` at 1728: data rows 50px on a
   page whose cells hold a Toggle, 45px where the tallest content is the 20px chip row (12 + 20 + 12 + 1). AG needs a
   number; the default is **45**, and a grid whose legacy rows are taller passes `rowHeight` (additive prop). The
   totals row is a data row's height (legacy), so the adapter passes its own `getRowHeight`. `domLayout="autoHeight"`,
   the page scrolls, the pager decides the height (GDS decision 4 — the same rule).
5. **One theme variant, in the engine.** `design-system/grid/workspace/theme.ts` = `workspaceGridTheme.withParams(…)`
   binding the ads grid's own tokens (the `--nds-wsgrid-*` set and the exact ramp values the legacy sheet used —
   ground `--nds-white`, header `--nds-grey-25`, row rule `--nds-grey-150`, header rule/frame `--nds-grey-200`, cell
   ink `--nds-grey-800`, hover `--nds-imgup-surface`, selected `--nds-blue-50`). Chrome stays in the engine folder;
   nothing per page. The `.h10-shell` pins the console light, exactly as today.
6. **Cells keep the consumers' markup.** `renderFirst` / `column.render` output is mounted unchanged inside AG cells.
   The legacy `.nds-wsgrid td.nm .nmw .tg …` rules are restated for AG's DOM in the engine's own sheet
   (`workspace/workspace.css`) — the ONLY file allowed to address `.ag-*`. Page stylesheets that keyed on
   `td`/`tr`/`th` move to the class contract in §4.
7. **Row hover reaches every pinned part.** Measured on AG 36.1: a row is ONE element (`.ag-row`) holding three cell
   containers (pinned-left, centre, pinned-right), so `.nds-ws-tr:hover …` reaches every cell exactly as `tr:hover` did —
   page CSS is rewritten to that (§4). The engine sheet ALSO publishes the hover as custom properties on the row
   (`--nds-ws-hover: 1`, `--nds-ws-reveal: inline-flex`, `--nds-ws-reveal-w: auto`) for a rule that prefers to read the
   state. (The original text assumed three row elements, which older AG versions rendered.)
8. **Sorting is AG's** (headers are AG's): `sortingOrder` asc → desc → none (the legacy's third-click clear), the
   engine's blank-sinking comparator (`compareForAgGrid` over `sortValue` / `firstSortValue`), `defaultSort` as the
   initial column state, `onSortChange` from `onSortChanged`, `enabledFirst` banding and `groupBy` ordering in
   `postSortRows`. Filtering, search and the edit diff stay the SHARED pure modules (`filterRows`, `editDrafts`,
   `sortValues`, `enabledRank`, `rowInteraction`) — no second implementation.
9. **Paging is AG's** (`pagination` + `paginationPageSize` + `suppressPaginationPanel`; `paginateChildRows` under
   groupBy), driven by the legacy pager markup. `server` mode: rows verbatim, page count from `server.total`, no AG
   paging. `hierarchy` mode: rows verbatim in tree order, comparators inert (AG's stable sort keeps the order), the
   chevron drawn inside the identity cell exactly as today.
10. **Selection is AG's** (`rowSelection` multiRow, checkboxes, header checkbox, no click-select), 46px selection
    column (the legacy `td.ck` width), the legacy 20px rounded checkbox drawn on AG's checkbox. `selected`/
    `onSelectedChange` stay a controlled Set: the adapter applies it with `setNodesSelected` and reads it back from
    `onSelectionChanged` (one-way per tick, no echo). Remainder rows (`hierarchy.isRemainder`) are unselectable.
11. **Preferences keep their storage shape and keys.** `GridPrefs {visible, stickyFirst, stickyLast}` under the same
    `storageKey` (43 keys) — the legacy reader (bare `string[]` too) is reused verbatim, so no operator loses a view.
    Additive: `widths?: Record<string, number>` so an AG header resize persists. A header drag writes the new order
    into `visible` (same shape). The Customize dialog is the DS `PreferencesModal` with the same wiring
    (`__first` locked, `pageSizeChoices={[]}`, `sortFieldOptions={[]}`, `showSticky`).
12. **Edit mode** (10 sites): `editing` swaps configured cells to `field.render(value, set, row)`; drafts live in a
    subscription store (`useSyncExternalStore`) so a keystroke re-renders ONE cell, never the grid; `collectEdits`
    computes the diff. The hover pencil (`.h10-ec` + `.h10-editpen`) and the portaled popover are the legacy's.
13. **Group bands** (`groupBy`, 5 sites): AG row grouping with `groupDisplayType: 'groupRows'`; the band renderer
    prints label + count in the legacy `.h10-am-grp` markup; `order` → group order in `postSortRows`.
14. **Loading / empty**: six skeleton rows rendered as rows (`.sk` + `.skb`, the legacy widths) so the loading grid
    is the height of a loaded one; the empty state is AG's no-rows overlay rendering `emptyNode ?? emptyLabel` with
    the legacy `.empty` geometry (28px, centred, wraps).
15. **Keyboard nav** (3 sites): the legacy document listener, `.kbd-focus` through `rowClassRules` +
    `redrawRows` on the two rows that change, `ensureIndexVisible`.
16. **`DataGrid`** (§6) follows the same rules with the `.nds-grid` look: the engine's default theme was measured
    from it (GDS §3), so the theme is the base one; `size` sm/md map to the legacy row heights, measured.
17. **Modules**: everything used is already in `design-system/grid/modules.ts` (CSRM, RowGrouping, PinnedRow,
    RowSelection, Pagination, ColumnMenu, Tooltip, RowStyle, CellStyle, RenderApi, ColumnApi, RowApi, EventApi,
    ScrollApi). `scripts/check-grid-modules.mjs` is the check.
18. **The legacy components and `workspace-grid.css` are removed from the design system at the end**, once the parity
    lab and the page walkthrough are green; a frozen copy lives under `app/design/grid-lab/legacy/` so the parity
    harness stays runnable. `check-grid-kit-ratchet` baselines go DOWN (`--write`, stated).

## 3. Files

```
apps/web/src/design-system/grid/workspace/          NEW — AG-backed WorkspaceGrid (lane AGW, this session)
  WorkspaceGrid.tsx      the component: props → AG options, chrome, state
  types.ts               GridPrefs · GridColumn · GridFilter… · WorkspaceGridProps (moved; the patterns file re-exports)
  columns.ts             pure: GridColumn[] + prefs → ColDef[] (identity, align class, pinned, width, comparator, tooltip)
  prefs.ts               pure: storage read (both shapes) / write, prefs ⇄ column state, header move/resize → prefs
  drafts.ts              the edit-draft store
  cells.tsx              IdentityCell · ValueCell · TotalCell · SkeletonCell · GroupBand · EmptyOverlay · HeaderTip
  chrome.tsx             AdsFilterBar + presets, toolbar, pager, footer, hover-edit popover (legacy markup, lifted)
  theme.ts               adsWorkspaceTheme = workspaceGridTheme.withParams(…)
  workspace.css          the legacy .nds-wsgrid rules restated for AG's DOM + the chrome rules moved from workspace-grid.css
  index.ts
apps/web/src/design-system/grid/datagrid/           NEW — AG-backed DataGrid (agent lane AGD)
  DataGrid.tsx · columns.ts · cells.tsx · datagrid.css · index.ts
apps/web/src/design-system/patterns/workspace-grid/ WorkspaceGrid.tsx → re-export of grid/workspace (then deleted at the end)
apps/web/src/app/marketing/ads/campaigns/_grid/AdsDataGrid.tsx   the shim: points at grid/workspace
apps/web/src/app/marketing/ads/campaigns/CampaignsGrid.tsx       rebuilt on the contract (agent lane AGC)
apps/web/src/app/design/grid-lab/                                workspace + datagrid parity tabs, full-prop fixtures (agent lane AGL)
scripts/check-workspace-parity.mjs                               the measurement (Playwright), run by hand + `npm run grid:parity`
```

Shared substrate NOT edited by this programme: `grid/NexusGrid.tsx`, `grid/theme/*`, `grid/modules.ts`,
`grid/columns/columnPrefs.ts`, `grid/renderers/*`, `grid/editors/*` (PES.2 / b0 / 45 own them). Anything the adapters
need from them is consumed through the barrel; a real gap is filed to the owner, never patched here.

## 4. The class contract (what page CSS may key on)

| Legacy | AG-backed |
|---|---|
| `.nds-wsgrid` wrapper | `.nds-wsgrid.nds-ag-ws` on the grid wrapper (same frame rules) |
| `tbody tr` | `.nds-ws-tr` (every row part) |
| `tbody tr:hover …` | `.nds-ws-tr:hover …` — AG 36.1 renders ONE row element per row (the pinned parts are containers inside it), so the plain hover reaches every cell, exactly as `tr:hover` did; the engine sheet ALSO publishes `var(--nds-ws-hover)` (0 → 1), `var(--nds-ws-reveal)` (none → inline-flex), `var(--nds-ws-reveal-w)` (0 → auto) on the hovered row for a rule that prefers to read the state |
| `tr.on` | `.nds-ws-tr.ag-row-selected` (engine sheet only; no page CSS keys on it today) |
| `tr.h10-am-total` | `.nds-ws-tr.h10-am-total` (the pinned row) |
| `tr.h10-am-grp` | `.nds-ws-tr.h10-am-grp` (the group band, full width) |
| `tr.kbd-focus` | `.nds-ws-tr.kbd-focus` |
| `tr.sk` | `.nds-ws-tr.sk` |
| `td` / `th` | `.nds-ws-td` (an AG cell) — header cells are AG's and take no page CSS |
| `td.nm`, `td.nm.fz` | `.nds-ws-td.nm`, `.nds-ws-td.nm.fz` (pinned) |
| `td.num` / `td.ed` / `td.ctr` / `td.ck` | `.nds-ws-td.num` / `.ed` / `.ctr` / `.ck` (the selection cell) |
| `td.fzr`, `td.fzr0` | `.nds-ws-td.fzr`, `.fzr0` |
| `td.editing` | `.nds-ws-td.editing` |
| `td.empty` | `.nds-ws-empty` (the overlay) |
| `.eb-tablebox` (3 eBay wizard `DataGrid`s) | stays a class on the AG DataGrid wrapper; its rules move to `ebay.css` |

Inside a cell nothing changes: `.nmw`, `.t`, `.tg`, `.pb`, `.mk`, `.bulb`, `.badge`, `.dot`, `.pin`, `.agi`,
`.h10-open`, `.h10-statuscell`, `.h10-ec`, `.h10-editpen`, `.nds-tree-*` keep their names and their rules.

## 5. `WorkspaceGridProps` → AG, prop by prop

| Prop | Mechanism |
|---|---|
| `rows`, `rowId` | `rowData` = the pipeline's output; `getRowId` = `rowId` |
| `loading` | six skeleton rows (`__skeleton`) in `rowData`; header/pager render as today |
| `noun`, `firstColLabel`, `renderFirst`, `firstSortValue` | identity `ColDef` `{colId:'__first', headerName, cellRenderer: IdentityCell, comparator over firstSortValue, sortable: !!firstSortValue, pinned by stickyFirst, minWidth 300, maxWidth 360, lockPosition}` |
| `columns[].key/label/tip/align/metric/sortable/sortValue/total/defaultHidden/freezeRight/width` | one `ColDef` each: `headerName`, `headerTooltip`, `cellClass` (`nds-ws-td num/ed/ctr`), `sortable`, `comparator`, `pinned:'right'` + `width` (freezeRight & stickyLast), `hide` from prefs, `suppressMovable` for pinned |
| `filters`, `filterState`/`onFilterStateChange`/`hideFilterPanel`, `initialFilters`, `onFilterChange`, `filterPresetsKey`, `filtersDefaultOpen` | unchanged legacy code — `filterRows` feeds `rowData` |
| `searchable`, `searchPlaceholder`, `searchValue`, `initialSearch`, `onSearchChange` | unchanged legacy code — the search narrows `rowData` |
| `defaultSort`, `onSortChange` | initial `sort` on the ColDef; `onSortChanged` → `onSortChange`; re-sync on seed change via `applyColumnState` |
| `enabledFirst` | `postSortRows`: when no sort is active, stable-band by `enabledRank` |
| `groupBy` | hidden group column + `groupDisplayType:'groupRows'`, `groupRowRenderer` band, `postSortRows` orders groups by `order` then label, `paginateChildRows` |
| `hierarchy` | rows verbatim; comparators inert; identity cell draws `.nds-tree-lead/.nds-tree-chev`; remainder rows unselectable + `nds-tree-remainder` |
| `server` | rows verbatim; pager from `server.total`/`rowsPerPage`; no AG pagination |
| `selectable`, `selected`, `onSelectedChange`, `selectionActions` | `rowSelection` multiRow + checkboxes; controlled Set applied/read back; toolbar as today |
| `showTotal`, `totalFirst`, `column.total` | `pinnedTopRowData=[TOTAL]`; `TotalCell` computes over the filtered rows; pinned row height = row height |
| `reportLabel`, `emptyLabel`, `emptyNode` | footer as today; no-rows overlay |
| `editMode` (+ `renderPopover`) | drafts store; `ValueCell` swaps to the field editor while `editing`; pencil + popover as today |
| `customizable`, `storageKey` | `PreferencesModal` + `prefs.ts`; column state applied on prefs change; header move/resize written back |
| `exportable`, `onExport`, `toolbarLeft/Right`, `pagerCentered` | toolbar/pager markup as today |
| `rowClassName` | `getRowClass` |
| `onRowClick` | `onCellClicked` guarded by `isInteractiveChild`; `.clickable` row class |
| `keyboardNav`, `onRowKey` | legacy document listener; `.kbd-focus` via `rowClassRules` + `redrawRows` |
| `initialPage`, `onPageChange` | page state as today; `paginationGoToPage` follows it |
| `rowHeight` (NEW, additive) | AG `rowHeight`; default 45 |
| `chromeless` (NEW, additive) | grid only, rows verbatim, comparators inert, sort out through `onSortChange` — the Ad Manager's mode (§7) |
| `prefs` / `onPrefsChange` (NEW, additive) | controlled `GridPrefs`; when passed, `storageKey` is not read or written |
| `selectAllIds` (NEW, additive) | the ids the header checkbox selects when the grid holds only a page of the consumer's result (`chromeless`): the Ad Manager's legacy `toggleAll` took every filtered campaign across pages; the shared grid's takes the current page (AG `selectAll: 'currentPage'`, the legacy `pageIds` rule) |

## 6. `DataGridProps` → AG (lane AGD)

Same rules: the `Column<T>` array becomes `ColDef[]`; `render` output mounts unchanged; `align`/`numeric`/
`className`/`sortable`/`sortValue`/`sticky`/`stickyRight`/`width`/`total`/`prefsLocked`/`group`/`prefsLabel` map to
ColDef fields; `selectable`/`selected`/`onSelectedChange`/`rowSelectable`/hints → `rowSelection` + `isRowSelectable`;
`showTotals` → pinned row; `emptyState` → no-rows overlay; `renderExpanded`/`expanded` → AG master-detail
(`MasterDetailModule`, full-width detail row rendering the caller's node); `getSubRows`/`subRowsSelectable` → the
children as data rows under their parent (flat rows in tree order + `flatTree` tint, exactly the legacy's); `rowProps`
→ `getRowClass` + `onRowDragEnter/…` is NOT expressible on AG rows, so the two drag-target consumers keep their
handlers on the identity CELL's wrapper (the adapter passes `rowProps(row)` to a wrapper element inside the first
cell that spans the row — verify on screen); `headerProps`/`cellProps` → `headerComponentParams`/`cellRendererParams`
for `data-*`, and header drag becomes AG's own column drag; `customizable`/`storageKey`/`prefsColumns` → the DS
`PreferencesModal` over `columnPrefs.ts`; `size` sm/md → measured row heights; `maxHeight` → bounded grid
(`domLayout` normal with that height); `className` on the wrapper; `sort`/`onSortChange` (controlled sort, if the
component offers it) → column state. Read `components/DataGrid.tsx` end to end before writing a line; the audit
`scratchpad/audit/audit-datagrid.md` lists which props the 47 ads sites actually use.

## 7. CampaignsGrid on the contract (lane AGC)

The Ad Manager keeps ALL of its own chrome, because that chrome is what "exactly as it is" means on that page and it
differs from the other 55 grids' (its toolbar sits above the card, its pager is the DS `Pagination`, its filter
panel and preset library are its own). So the contract gains three ADDITIVE props and the page uses them:

- `chromeless` — the grid renders ONLY the `.nds-wsgrid` card: no filter bar, no toolbar, no pager, no footer, no
  Customize dialog. Rows are rendered VERBATIM (the page filters, searches, sorts and pages, exactly as it does today);
  header sort clicks still flow out through `onSortChange` and `defaultSort` still seeds the indicator (the BID.S0
  bridge); the comparators are inert (the `server`/`hierarchy` rule).
- `prefs` / `onPrefsChange` — CONTROLLED column preferences (`GridPrefs`), so the page's own Customize dialog and its
  `h10-am-columns-v5 {order, visible}` storage stay untouched: the page derives `{visible: order.filter(inVisible),
  stickyFirst: true, stickyLast: true}` and writes a header drag/resize back through `onPrefsChange`. No storage
  migration anywhere.

Keep verbatim: the page header, the filter panel (`.h10-am-fpanel`), the preset library (`h10-am-preset-lib`), the
graph, delivery/authority/bid-owner reads, Bulk Actions / Bid Multiplier / Rules / Strategy modals, the edit-mode bar
(`.h10-am-editbar`) + Apply modal, the export modal, `renderCol` / `settingsCell` (the edit-mode inputs live inside
`render`, so the page's own `mode` needs nothing from the grid), the toolbar, the DS `Pagination` pager, the Latest
Report line, selection state. `columns` = `physical` mapped to `GridColumn` (`metric` → align, `COL_TIPS` → `tip`,
`sortable` where the legacy header was sortable, `width` where the legacy set one). The identity cell is
`CampaignNameCell` inside `renderFirst`. Column drag-to-reorder becomes AG's header drag (the pointer choreography,
`data-item`/`data-col`, `.dragging` and the `colhi` header highlight are deleted under the header exemption; the
ORDER it produced is written back through `onPrefsChange`). Row height: `rowHeight={50}` (measured). Verify on
`http://localhost:3000/marketing/ads/campaigns`, which renders all 219 campaigns from the local API: sort each
column, page, select, edit mode round trip (Discard — never Apply against the live API), Customize, presets.

## 8. Verification — what "exactly as it is" means, measured

1. **Baseline** (before any edit): `scratchpad/baseline/<page>.json` + `.png` for 14 pages — wrapper, header, row,
   identity cell, chips, checkbox, totals, group band, pager, toolbar computed styles + rects.
2. **Parity lab** (`/design/grid-lab?tab=workspace`, `?tab=datagrid`): one fixture per contract exercising EVERY prop;
   legacy and AG side by side; `scripts/check-workspace-parity.mjs` diffs the measured properties and prints a table.
   Acceptance: every non-header property equal (colours exact, geometry within 1px, fonts exact).
3. **Page walkthrough** on `:3000` for every route that renders a grid (65 routes), with the baseline screenshot
   beside the new one: sort, filter, search, page, select, edit, hover-edit, customise, group band, tree, totals,
   export, keyboard nav — exercised, not assumed. Findings go to `scratchpad/reports/`.
4. **Gates**: web `tsc` 0 new errors (baseline in `scratchpad/tsc-baseline.log`), web vitest, `check-ag-grid-import-boundary`,
   `check-grid-modules`, `check-grid-option-identity`, `check-grid-kit-ratchet` (baselines lowered, stated),
   `check-grid-chrome` (untouched), `check-ds-fork-drift`, `p3-token-sweep`, `check-css-hex-ratchet`, `check-help-cursor`,
   `check-button-vocabulary`, `check-silent-disabled`. Every gate that reads the working tree is run bare (exit code read).

## 9. Coordination

- (Resumed 2026-09-05 23:20 after the 17:31 session limit — same lane, new session id; the state found on disk, the shim flip at 23:36 and the relaunched lanes are in the ledger.)
- Claim in `docs/pes-claims.md` before the first write; announce every browser gate (peers hold apps/* writes) and
  hold during theirs. Never edit a file another live lane claims; disclose additive touches.
- Agents write ONLY inside their lane's files (§3); cross-lane needs are messages to this session, never edits.
- Nothing is committed. Every agent reports what it MEASURED, with the numbers, and what it did not.
