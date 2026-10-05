# 03 — Design-system building blocks for the Approvals grid

Read-only research, 2026-10-05, worktree `/private/tmp/feat-approvals-grid` at `7039b95ef`. All paths are under
`apps/web/src/` unless they start with `scripts/` or `.claude/`. Props were read from the `.tsx` source, not the
`.d.ts`. **[unverified]** marks anything read in code but not seen in a browser.

## Summary
1. Build it on `NexusGrid` (`design-system/grid/NexusGrid.tsx`) — a thin `AgGridReactProps<T>` wrapper over AG Grid
   Enterprise **36.1.0**. Pages pass AG's own `ColDef[]` and options; the engine adds theme, density, the blank-last
   sort, the checkbox column kept first, and the DS Customise dialog in the header menu.
2. Host it in `GridCard` (page host: `domLayout="autoHeight"`, the page scrolls, `GridPager` below). Use `GridSheet` only for editing spreadsheets.
3. The products page (`app/products/next/ProductsNextClient.tsx`) is the pattern to copy for the toolbar:
   `GridToolbar` + `GridSearchSlot` ⇄ `GridSelectionActions`, `PreferencesModal` through the `columnPrefs` bridge,
   `GridViewsMenu` + `useGridState`, `GridDensityToggle`, `GridPager`, `FilterBar`. It does NOT use `BulkActionBar`.
4. The closest queue + detail-panel exemplar is publish history: `app/products/_publication/history/PublishRuns.tsx`
   + `PublishRunDrawer.tsx` (MetricStrip/FilterChip tiles, FilterPanel + TokenChip, Drawer modal|dock, Timeline,
   KeyValue, ChangeReview, row Enter opens, `?run=` deep link, phone column set). It is built on the AG `DataGrid` adapter (`grid/datagrid`), not on `NexusGrid` directly.
5. Row and bulk verbs belong in the DS action registry (`grid/actions`: `GridAction`, `useActionPress`,
   `actionMenuItems`, `actionContextMenu`, `ActionConfirm`), so a verb is declared once and every surface renders the same declaration.
6. Status = `Pill` / `statusColumn` (`BadgeCell`) with a per-value tone map; detail = DS `Drawer` (+ `DrawerOverlayCard`
   for confirms inside it); feedback = `useToast` (+ composed Undo button); empty/loading = `EmptyState`,
   `GridNoRowsOverlay`, `GridLoadingOverlay`, `Skeleton`; notices = `Banner`.
7. Modules: selection, master/detail, tree, row grouping, pagination, tooltips, context menu, quick filter, auto
   height, grid state are all registered. **`ExternalFilterModule` and AG's built-in Text/Set/Number filters are NOT** —
   they would fail silently in production.
8. Guards a builder hits: AG import boundary, grid option identity (no inline objects/arrows on `<NexusGrid>`),
   module gate, grid-kit ratchet (never import `DataGrid` from `@/design-system/components`), raw-primitives ratchet
   (new file = zero raw controls), ds-conformance, CSS hex/radius ratchets, DS fork drift (most grid renderer files are mirrored byte-for-byte in `apps/factory`).
9. Phone width: `NexusGrid` has **no card fallback** (GRID.md §11: "RTL and mobile widths are out of scope for v1");
   only the GridCard toolbar wraps under 640 px. PublishRuns solves it page-locally with fewer columns.
10. DS gaps to add + log: before→after cell, multi-verb row action cell, registry selection-bar adapter, toast action
    slot, glossary `Term` (fleet-local, CSS-only), phone/narrow helper, live countdown, keyboard-shortcut hook; plus a
    fleet light-pin integration risk for portals and the AG theme mode.

---

## 1. The grid — `design-system/grid/`

### 1.1 `NexusGrid` (`grid/NexusGrid.tsx`, barrel `@/design-system/grid`)
`NexusGridProps<T> extends AgGridReactProps<T>`, plus:

| prop | type / default | meaning |
|---|---|---|
| `density` | `'compact' \| 'cozy' \| 'spacious'`; default = nearest `GridDensityProvider`, else spacious | row/header heights from `tokens/grid.ts` (text rows 28 / 43 / 49) |
| `rows` | `'text' \| 'media' \| 'media-line'`, default `text` | row kind (thumbnail rows) |
| `height` | default 640 | ignored under `domLayout="autoHeight"` or `fill` |
| `fill` | default false | take the host's remaining height (GridSheet) |
| `flatTree` | default false | DS tint + 3px rail on child rows |
| `columnDialog` | `{ customise?, reset? }` | replaces AG's "Choose Columns / Reset Columns" with the DS dialog |
| `pinSides` | `'left'` | header Pin menu offers only left |
| `emptyCells` | `'dash'` (default) \| `'blank'` | what an empty cell draws |

Engine-set defaults (a page can override via the spread, which comes last): `animateRows={false}`,
**`suppressCellFocus` (true)**, `popupParent=document.body`, `defaultColDef = { sortable, resizable,
suppressHeaderFilterButton, comparator: blank-last }`, selection column 43 px locked left and re-pinned first
whenever any other column is pinned left. Re-exported AG types: `ColDef`, `ColGroupDef`, `GridApi`, `IRowNode`,
`ICellRendererParams`, `GetContextMenuItemsParams`, `AgMenuItemDef`, `GridState`, …

⚠ Keyboard: with the default `suppressCellFocus`, arrow-key cell navigation is OFF. A queue that wants keyboard row
navigation must pass `suppressCellFocus={false}` (SHEET_GRID_OPTIONS and the AG `DataGrid`'s `keyboardScroll` both do
this). **[unverified]** how Space/Enter behave on a focused row with `gridSelection()`.

### 1.2 Options for the asked features

| need | how, in this DS | where proven |
|---|---|---|
| row selection + checkbox column | `rowSelection={SELECTION}` where `const SELECTION = gridSelection<T>({ isRowSelectable })` (`grid/columns/presets.ts`): multiRow, checkboxes, header checkbox, **no click-to-select**, disabled boxes hidden, `selectAll: 'currentPage'` default. Read with `api.getSelectedNodes()`, clear with `api.deselectAll()` (GRID.md decision 8: never mirror selection back down) | grid-lab `GdsScenarios.tsx` "reporting"; products page builds its own memoised object |
| pinned columns | `pinned: 'left'` on a ColDef; `holdColumn(col, end, pinned)`; `actionsColumn({...})` pins right by default | products page, grid-lab "actions-right" |
| row grouping | `RowGroupingModule` + `AggregationModule` registered; `rowGroup: true` on a ColDef | products page (SSRM only); CSRM only in grid-lab **[unverified in production]** |
| tree (plan → steps) | `treeData` + `getDataPath` (CSRM), `flatTree` for the child tint | studio sheets, grid-lab |
| master/detail | `masterDetail isRowMaster detailCellRendererParams detailRowAutoHeight`; `MasterDetailModule` registered | **grid-lab only** (`GdsScenarios.tsx:695`); no production page uses it yet |
| status cells | `statusColumn(field, { tones: { WAITING: { tone, label } }, fallbackTone, size })` → `BadgeCell` → DS `Pill`; or a custom renderer returning `Pill` (ChannelEventsGrid) | ChannelEventsGrid, grid-lab |
| identity cell | `IdentityCell { image, title, href, openPill, sub, leading, noImage }` + `SkuTag` | products page |
| date / time | `dateColumn(field)` (`DateCell`); `AsOf { at, kind: 'event' \| 'check' }` for "5 min ago" | PublishRuns "Started" |
| row actions | `actionsColumn({ primary?: { label, href?, onClick? }, items?: (row) => MenuItemDef[], menuLabel?, width?, pinned = true })` → `ActionsCell`: ONE visible button + a ⋯ `Menu` | products page, grid-lab |
| right-click menu | `getContextMenuItems={actionContextMenu({ actions, onSelect, isRecord })}` (`ContextMenuModule` registered) | studio master sheet |
| tooltips | `tooltipValueGetter`, `headerTooltip` (TooltipModule registered; `.ag-tooltip` styled 42ch, pre-line) | ChannelEventsGrid "Actor" |
| wrapping / multi-line rows | `autoHeight: true` + `wrapText` on a ColDef (`RowAutoHeightModule` registered) | ads workspace grid |
| row classes | `rowClassRules` (RowStyleModule) — must be a memoised identifier | studio channel sheet |
| search | page state → filtered `rowData`, or `quickFilterText` (QuickFilterModule). **NOT** `isExternalFilterPresent` (module not registered) | — |
| column filters | DS filters only: `GridSetFilter`, `GridNumberRangeFilter`, `GridTextFilter` via `gridFilterDef` (CustomFilterModule). AG's `agTextColumnFilter`/`agSetColumnFilter` are NOT registered **[unverified on CSRM]** | products page (SSRM) |
| column state saving | `useGridState<TPage>({ surface, baseUrl: getBackendUrl(), getPageState, applyPageState, persistKeys? })` → `initialState`, `bind(api)`, last-used in `localStorage nds-grid:<surface>:v1`, named views on `/api/saved-views` (surface names are free strings; only `products-next*` and `product-edit:*` are validated in `apps/api/src/services/saved-views/persistence.service.ts`) | products page `surface: 'products-next'` |
| saved views menu | `GridViewsMenu { views, presets?, onNewView?, onSaveCurrent?, onUpdateCurrent?, manage? }` | products page, studio sheet toolbar |
| Customise dialog | `PreferencesModal` (patterns) + `columnStateToPrefs` / `prefsToColumnState` (`grid/columns/columnPrefs.ts`) + `columnDialog` on the grid | products page lines ~1446–1660 |
| density | `GridDensityProvider value`, `GridDensityToggle { value, onChange }` | products page |
| empty / loading | `noRowsOverlayComponent={GridNoRowsOverlay}` + `noRowsOverlayComponentParams={{ title, message, action }}`; `loadingOverlayComponent={GridLoadingOverlay}` + `{ rows, rowKind }` (`grid/renderers/overlays.tsx`) | studio `sheet/sheetGridStates.ts` |
| CSV | `exportGridCsv` / `toCsv` / `downloadCsv` (`grid/export`) | products page |
| land on a cell | `landOnCell` (`grid/landOnCell.ts`) | progress columns |

### 1.3 `modules.ts` — registered (production)
Server-Side + Client-Side row models and APIs · TreeData · RowGrouping · Aggregation · PinnedRow · **MasterDetail** ·
ColumnMenu · ContextMenu · **Tooltip** · CustomFilter · **RowSelection** · Pagination · CsvExport · Number/Text/LargeText/
Custom editors · RichSelect · CellSelection · Clipboard · UndoRedoEdit · **QuickFilter** · GridState · ColumnApi ·
ColumnAutoSize · **RowAutoHeight** · CellApi · RowApi · EventApi · RenderApi · ScrollApi · CellStyle · RowStyle · Locale.
`ValidationModule` in development only.
**Not registered (fails silently in production):** ExternalFilter, the AG Text/Number/Set/Date filters, SideBar /
ColumnsToolPanel / FiltersToolPanel, StatusBar, RowDrag, Charts. Adding one = edit `grid/modules.ts` only, then
`npm run grid:modules`.

### 1.4 The exemplar `app/settings/channels/ChannelEventsGrid.tsx`
Three read-only lists. Shape to copy: column defs as module-level constants (stable identity), a renderer returning a
DS `Pill` with a tone map (`STATUS_TONE`, `STATUS_LABEL`), `getRowId` at module scope,
`if (rows.length === 0) return <EmptyState …/>`, then
`<NexusGrid density="compact" domLayout="autoHeight" rowData columnDefs getRowId />`. No selection, toolbar or drawer.

### 1.5 The rules (apps/web/CLAUDE.md + guards)
- `ag-grid-*` may be imported only inside `design-system/grid/` and `app/design/grid-lab/`
  (`scripts/check-ag-grid-import-boundary.mjs`). Pages take AG types from `@/design-system/grid`.
- A feature without its module in `grid/modules.ts` does nothing in production (`scripts/check-grid-modules.mjs`,
  `npm run grid:modules`).
- Every option object or callback on `<NexusGrid>` must have a stable identity: no inline `{}`, `[]` or arrows for
  `rowSelection, columnDefs, rowData, getRowId, initialState, rowClassRules, context, noRowsOverlayComponentParams,
  on*` … (`scripts/check-grid-option-identity.mjs`, baseline 0).
- A custom cell editor must call `props.onValueChange`; a ref `getValue` is never read
  (`grid/editors/SelectPanelEditor.tsx`). Only relevant if a row cell becomes editable, for example a note.

---

## 2. The product grid on the products page

`/products` renders `app/products/next/ProductsNextClient.tsx` (`app/products/page.tsx`). It is the
"products page sheet". The studio's editing sheet is a different host:
`app/products/[id]/edit/_studio/sheet/ProductSheetSurface.tsx` = `GridSheet` + `SHEET_GRID_OPTIONS` + `StudioDock`.

**ProductsNextClient render tree** (lines ~1328–1660):
`ToastProvider` → `PageHeader { title, subtitle, actions }` → `MetricStrip` → `Banner`s → `FilterBar { dimensions,
activeCount, onClear }` → `<div className="nds-gridcard nds-grid-card">` → `GridToolbar { count, right }`, where the
count changes to "Selected **N** products" + `SelectionNote` and the children change from
`GridSearchSlot(Input)` to `GridSelectionActions(Button+SelectionLabel…, Menu ⋯, Clear)`; `right` = `GridDensityToggle`
(hidden while rows are selected), Customise `Button`, `GridViewsMenu`, Export `Button`, live-state `Pill dot`.
Then `GridDensityProvider` → `NexusGrid` (SSRM, tree, pagination, `columnDialog`, `rowSelection` memoised) →
`GridPager`. After the card come `PreferencesModal`, the bulk dialogs and `useActionConfirm().element`.

| part | generic DS | product-only |
|---|---|---|
| card, toolbar, search slot, selection swap, density, pager, views menu, Customise bridge, filters, CSV, overlays | ✔ `@/design-system/grid`, `/patterns` | — |
| SSRM datasource, family tree cell (`ProductTreeCell`), `FamilyFooter`, `InventoryEditorModal`, `BulkEditModal`, `TagDialog`, `ProductsPublishDialog`, `useBulkActions`, `productsLayout` | — | ✔ |
| side drawer | — (products page has none) | studio's `RecordDrawer`/`StudioDock` = DS `Drawer mode="dock"` + product panes (product-only) |

Bulk actions here are **toolbar-swap**, not a bottom bar. The studio also dropped its `BulkActionBar` on 2026-09-26
(`sheet/master/FamilySelectionBar.tsx` header). The DS `BulkActionBar` pattern has **no app consumer**: the three
`BulkActionBar` imports in `app/` are page-local copies.

---

## 3. DS components and patterns for each need

Barrels: `@/design-system/primitives`, `/components`, `/patterns`, `/grid` (no root barrel). Never `src/components/ui`.

| need | component (path) | key props | existing usage |
|---|---|---|---|
| page header | `PageHeader` (`patterns/PageHeader.tsx`) | `eyebrow?, title, subtitle?, actions?` | ProductsNextClient |
| fleet page header | `FleetPageShell` (`app/fleet/_shell/FleetPageShell.tsx`) — **not DS**: `acr-head` from control-room.css | `title, sub, aside?, rootClass?, children` | every fleet page incl. ApprovalsClient |
| toolbar | `GridToolbar` (`patterns/GridToolbar.tsx`, re-exported by `/grid`) | `count?, children?, right?` | products page, PublishRuns |
| search | `Input` in `GridSearchSlot` | `leadingIcon, placeholder, aria-label, value, onChange, size` | products page |
| filter chips with counts | `FilterChip` (`primitives/FilterChip.tsx`) | `pressed, count, badge, size?: 'md', compactLabel` | PublishRuns "What" chips, phone tiles |
| tabs with counts | `Tabs` (`components/Tabs.tsx`) | `tabs: { id, label, count?, badge?, icon?, disabled? }[], active, onChange, size, overflow?: 'scroll'` | `settings/sharing/SharingClient.tsx` |
| segmented | `SegmentedControl` (`primitives`) | `options: { value, label, icon?, disabled?, title? }[], value, onChange, size, ariaLabel` (no count slot) | `settings/sharing/CopyDrawer.tsx` |
| KPI tiles as filters | `MetricStrip` (`components/MetricStrip.tsx`) | `metrics: { label, value, hint?, accent?, onClick?, active? }[]` | PublishRuns |
| filter panel / tokens | `FilterPanel` + `FilterField`, `TokenChip { onRemove, removeLabel }`; or `FilterBar { dimensions: multiselect\|select\|range\|toggle }` | — | PublishRuns; products page |
| bulk bar | toolbar swap: `GridSelectionActions`, `SelectionLabel`, `SelectionNote` (`grid/toolbars/GridSelectionActions.tsx`); alt. `BulkActionBar { count, children, onClear, noun }` (sticky, unused) | — | products page |
| status | `Pill { tone, dot?, icon?, size?: 'sm'\|'md', onClick?, pressed? }`; `Tag`; `PublishStatusPill { meta }` is a model for a status-meta table | `Tone = neutral\|info\|success\|warning\|danger` | ChannelEventsGrid |
| side panel | `Drawer` (`components/Drawer.tsx`) | `open, onClose, title, subtitle, footer, width, overlay, mode: 'modal'\|'dock'\|'embedded', resizable, className` — modal = focus trap + backdrop; dock = fixed right, no trap (host reserves width) | `PublishRunDrawer.tsx` |
| confirm inside a drawer | `DrawerOverlayCard { labelledBy, onCancel }` via `Drawer.overlay` | — | PublishRunDrawer |
| modal | `Modal { open, onClose, title, subtitle, footer, size: sm\|md\|lg\|xl\|xxl\|full, readable, className, anchor }` | — | `settings/sharing/OfferShareModal.tsx` |
| verb confirm | `ActionConfirm` / `useActionConfirm` (components) — consequences, side effects, `review.rows {label,before,after}`, typed phrase, acknowledge | — | grid-lab `ActionConfirmScenario` |
| banner | `Banner { tone, title, children, icon, action, onDismiss }` | — | ApprovalCard, PublishRuns |
| toast + Undo | `ToastProvider` / `useToast().toast(message: ReactNode, tone, { duration })`; Undo = a `Button` inside the message | grid hosts mount a provider (`GridToastBoundary`) | `MediaPlanPage.tsx:137` |
| term tooltips | DS: `Tooltip { label, portal }`, `TooltipPortalProvider`, `InfoTip { tip }` (portal, viewport-clamped), `HoverCard`, `DetailPopover`; in grid: `headerTooltip` / `tooltipValueGetter`. Fleet `Term` is **not DS** | — | InfoTip across ads |
| empty state | `EmptyState { icon, title, description, action }`; in-grid `GridNoRowsOverlay` | — | ChannelEventsGrid |
| loading | `Skeleton { width, height, radius }`, `Spinner`, `GridLoadingOverlay { rows, rowKind }`, `GridSheetNote kind="slow"` | — | PublishRuns, products page |
| keyboard shortcuts | only `Kbd`; `ToolbarButton { shortcut }` shows a hint | — | `/design/chrome` |
| detail content | `KeyValue`, `Timeline { steps: {key,label,tone,at,detail}[] }`, `ChangeReview` (selectable changes with values), `SummaryTable`, `JobProgress`, `ProgressBar`, `Disclosure`, `AsOf` | — | PublishRunDrawer |
| row menu | `Menu { label, items: MenuItemDef[], align, triggerProps }`; `MenuItemDef { id, label, icon, tone, disabled, onSelect, href, title, description, separator, heading }` | — | products page |
| buttons | `Button` variants `primary, secondary, ghost, danger, danger-outline, success, warning, tonal, link, quiet`; sizes `lg, md, sm, xs` | — | everywhere |

---

## 4. Inbox and queue pages already on the DS grid

Few inbox pages use the grid. `/inbox`, `/sync-logs/*` (alerts, errors, outbound queue, webhooks), `/audit-log` and
`fulfillment/repricing` still use the legacy `components/ui` kit or raw `<table>`s. They are not exemplars. Pages on
`NexusGrid`: products page, studio sheets/matrix/variants, `channels/mapping`, `settings/channels`, `products/next-gen`.
On the AG `DataGrid` adapter: ~60 files, including publish history and the ads automation ledger.

**Best exemplars to copy:**
1. **`app/products/_publication/history/PublishRuns.tsx` + `PublishRunDrawer.tsx`** (`/listings/publish-status` and
   the studio Activity tab). It has the same shape as an approvals queue: a list of server events, each with a status, opened into a
   detail panel. Copy: MetricStrip tiles as filters (FilterChips on phone), `FilterPanel` folded + `TokenChip`s,
   `GridToolbar` count + search, explicit view states (loading Skeleton / error Banner / empty / no-match EmptyState),
   row click + Enter opens the `Drawer` (`modal` for business scope, `dock` with a measured width reserve),
   `?run=` deep link with `history.replaceState`, focus returned to the row, `aria-live` "finished" announcements,
   a separate phone column set. Missing for approvals: selection, bulk verbs, the registry.
2. **`app/products/next/ProductsNextClient.tsx`** — for selection + toolbar swap + Customise + views + density +
   pager on raw `NexusGrid`. Copy the wiring, not the SSRM/tree machinery.
Minimal reference: `ChannelEventsGrid.tsx`. Feature references (lab): `app/design/grid-lab/GdsScenarios.tsx` —
"reporting" (selection in a GridCard), "actions-right", "detail" (master/detail), "drawer" (`GridPanel` in a Drawer),
"action-confirm" (`useActionPress`).

---

## 5. Constraints a builder must know

- **No new Tailwind**. Feature CSS = layout + domain content only, `--nds-*` semantic tokens only (no hex, no
  numbered ramps). Never restyle a shared control locally. Guards: `scripts/check-raw-primitives-ratchet.mjs --check`
  (a new file is held at 0 raw `<button>/<input>/<select>/<textarea>/<table>`; the current approvals files have
  baselines of 13 / 16 / 2 / 1), `scripts/ds-conformance-guard.mjs --check` (fleet section is 0 on every count: select, date, fontSize, hex,
  legacyKit, rawColor, so no `components/ui` import is possible), `check-css-hex-ratchet`,
  `check-css-radius-ratchet`, `check-css-ds-shadow-ratchet` (approvals.css baseline 4), `check-grid-kit-ratchet`
  (importing `DataGrid` from `@/design-system/components` counts as a retiring kit; `@/design-system/grid/datagrid` is fine).
  All of them: `node scripts/ci/run-static-gates.mjs`.
- **i18n**: fleet pages do not use `t()`. If the new page does, every key goes in `lib/i18n/messages/en.json` + `it.json`
  (`scripts/check-i18n-catalog.mjs`).
- **DS edits are mirrored in Factory**: `grid/renderers/index.ts`, `grid/renderers/cells.tsx`, `grid/theme/grid.css`,
  `components/index.ts`, `primitives/index.ts`, `components/Toast.tsx`, `components/Drawer.tsx`, `styles/primitives.css`
  are byte-identical in `apps/factory/src/design-system` → copy any change there (`scripts/check-ds-fork-drift.mjs`).
  `grid/columns/presets.ts`, `grid/toolbars/index.ts` and the catalog are web-only. A new DS part also needs: a barrel export, a catalog entry
  (`design-system/catalog/*Example.tsx`, `/design-system` page), a `CHANGELOG.md` line, an append to
  `.claude/DS-GAPS.md` (append-only, `scripts/check-ds-gaps-append-only.mjs`).
- **Light / dark — the fleet is light-pinned.** `app/fleet/layout.tsx` wraps every fleet page in `.fleet-surface`;
  `fleet-pages.css` and `app/_shared/shared-shell.css` (`:where(.az-root, .fleet-surface, .fleet-portal)`, loaded
  globally by `components/layout/AppShell.tsx`) pin the `--nds-*` tokens, including `--nds-grid-*`, to their light
  values. So the grid itself stays light. Portals escape the subtree: `Drawer`/`Modal` need `className="fleet-portal"`
  (as `HowApprovalsWork.tsx:71` does). **[unverified]** `Menu`, `Listbox`, Toasts, `useActionConfirm`'s modal (it
  takes no className) and AG popups (`popupParent=document.body`, tooltips, header/context menus) render with the
  `.dark` values under a dark OS. `NexusGrid` sets `data-ag-theme-mode` from `<html class="dark">`, so AG's
  `browserColorScheme` turns dark (native scrollbars) inside a light grid. Decide in the plan: keep the pin and
  route portals, or make this all-DS page theme-aware (un-pin it). Either way, check it in light and dark.
- **Phone width**: no card or list fallback in `NexusGrid` (GRID.md §11). Under a 640 px container the GridCard
  toolbar wraps and the selection cluster drops to its own line (`grid/theme/grid.css` ~1192). The grid
  scrolls sideways, and pinned columns use up the width. `Drawer` dock becomes full width under 720 px; the modal drawer is capped at
  100%. PublishRuns uses a page-local `useNarrow()` (640 px) and a phone column list.
- **Grid geometry**: rows are integers (virtualisation); a list page is `autoHeight` + `GridPager` (50/100/200/500)
  and the page scrolls (GRID.md decision 4). A bounded grid belongs only in a modal or drawer (`GridPanel`).

---

## 6. Gaps — add to the DS and log in `.claude/DS-GAPS.md`

| # | gap | evidence | suggested DS home |
|---|---|---|---|
| G1 | **Before → after value cell** (old struck/muted · arrow · new, optional delta/percent, null-safe, a11y "from X to Y") | No renderer in `grid/renderers`. `DeltaChip` is numeric only. `ActionConfirm` review uses `SummaryTable`. ApprovalCard (`ArrowRight`, `aq-*` CSS) and ads `LedgerView.tsx` hand-roll "a → b" text | `grid/renderers` (+ preset `changeColumn`) |
| G2 | **Multi-verb row action cell** — Approve / Reject (/ Automate) visible per row, each with a variant and a disabled reason | `ActionsCell` = one `primary { label, href?, onClick? }` (no variant, no disabled) + ⋯ menu | extend `ActionsCell` / `actionsColumn`, driven by the registry |
| G3 | **Registry selection-bar adapter** (SELECTION verbs → Buttons with disabled reasons) | Registry header names 4 surfaces; DS ships the menu/⋯ adapters only; the selection bar adapter is lane-local `app/products/[id]/edit/_studio/sheet/master/FamilySelectionBar.tsx` | `grid/actions/` + `GridSelectionActions` |
| G4 | **Toast action slot** (Undo) + pause while hovered/focused | `ToastApi.toast(message, tone, {duration})` only; callers nest a `Button` (MediaPlanPage, SuggestionsClient) with page CSS; DS-GAPS line 68 `.rec-undo` 3.22:1 in a toast | `components/Toast.tsx` (mirrored in Factory) |
| G5 | **Glossary term** (dotted term + title/body tip, keyboard, Esc) | `Term` lives in `app/marketing/ads/rules-automation/fleet/glossary.tsx`, CSS-only `.acr-term` (control-room.css) → clips inside AG cells / scroll panes | promote into `primitives` on top of the portal `Tooltip`/`InfoTip` |
| G6 | **Narrow / phone behaviour for grids** | GRID.md §11 out of scope; PublishRuns `useNarrow` + phone column keys are page-local; legacy `MobileProductList` is old kit | `grid/hooks` (`useGridNarrow`) + phone column presets, or a card list on `PressableRow` |
| G7 | **Live relative time / countdown** ("expires in 2 h", ticking) | `AsOf`/`ago()` render a future time as "in 3 hours" but never re-render **[read in code]** | `components/AsOf.tsx` `live` option |
| G8 | **Keyboard-shortcut hook + help** (j/k, a/r, ?) | DS has only `Kbd`; `app/_shared/grid-lens/KeyboardShortcutsModal.tsx` is the retiring kit | `components` hook + dialog |
| G9 | **Dock width reserve** (list reflows beside a docked drawer) | `useDockReserve` is page-local in PublishRuns | `components/Drawer` helper |
| G10 | (only if needed) `ExternalFilterModule` | not in `grid/modules.ts` | `grid/modules.ts` |
| — | Optional: one **approval status vocabulary** (`approvalStatusMeta`, like `publishStatusMeta`) so the grid, drawer and other fleet pages use the same words and tones | `grid/renderers/publishStatus.ts` precedent | `grid/renderers` |
| — | Not a gap, a decision: `FleetPageShell` (non-DS `acr-head`) vs DS `PageHeader` | `app/fleet/_shell/FleetPageShell.tsx` | plan |
