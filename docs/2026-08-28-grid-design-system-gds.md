# GDS — the Grid Design System on AG Grid · Phase 0 audit and plan

**Date:** 2026-08-28 · **Baseline:** `2b0e43fc4` (the `/products/next` + inventory-editor batch, committed and pushed) ·
**Status:** Phase 0 — read-only audit. **Nothing in this document has been implemented.** Every later phase is
proposed here and built only after approval, one phase at a time.

Brief: `docs/2026-08-28-grid-design-system-gds-prompt.md`. Predecessor plan: `docs/2026-08-28-ag-grid-migration-ag.md`.

How to read this: §1 corrects the brief's counts against the tree (several are off by 10×). §2 is the inventory,
§3 the feature matrix over the §6 scenarios, §4 the token audit and the tokens proposed, §5 the spec outline with the
**open questions and my recommendation for each** (the decisions I need from you), §6 the phase plan, §7 the
migration map, §8 the guards, §9 the definition of done.

---

## 0. The one-paragraph verdict

The seed is sound and the engine's seams are the right ones (thin `AgGridReactProps` passthrough, Theming API,
verbatim SSRM request, Grid State views, DS Customise over AG column state). What does **not** exist yet is a
system: the grid's geometry is stated in **four** places with **three** different vocabularies (engine tiers
xs–xl, the page triple compact/cozy/spacious, and the ads grid's 46/44.5), its colours are **ramp** tokens that do
not flip in dark mode despite the theme's comment saying they do, the DS grid leans on the Tailwind kit it is meant
to retire (`Thumbnail`, `DensityContext`), page-specific files live inside the engine, and the migration surface is
**~5× larger than the brief says** (71 + 65 + 57 + 200 files, not 7 + 63 + 62 + 196). The plan below turns the seed
into tokens → theme → cells → hosts → state → catalog → guards, in that order, and only then starts migrating — with
the migration re-ordered by what each wave can retire.

### 0b. The framing, restated by the Owner after Phase 0 (2026-08-28)

> "We are doing a complete rebuild for each and everything … I'll slowly rebuild each and everything: every page on
> the platform, including advertising, and every other page, every other table, every other flat file."

This is a **rebuild programme, not a migration**, and it changes four things in this plan:

1. **The GDS must be complete before the second page is rebuilt.** Phases 1–3 (tokens → engine → catalog/lab/spec)
   are the immediate work; §7's "waves" are the Owner's rebuild backlog, in whatever order the Owner chooses, and
   the ratchets in §8.7 measure the backlog burning down. Each rebuilt page is built **from `GRID.md` and the lab**,
   the way `/products/next` was built beside `/products` — a new route or a swapped client, never an edit of the old
   grid in place.
2. **No localStorage adapters (Q4 revised).** A rebuilt page starts clean, as `/products/next` did. The only state
   worth carrying is what lives on the server: `SavedView` rows (surfaces `products`, `ads-reporting`, `stock`…) get
   a one-time payload conversion when their page is rebuilt. The 60+ localStorage key shapes in §2 are documented so
   nobody is surprised by what stops being read; they are not mapped.
3. **No column adapters at all (Q9 confirmed).** Every rebuilt page writes its own `columns.tsx` against the cell
   library, exactly like `/products/next`.
4. **The flat-file editors join the backlog** (they were "untouchable" — that rule stands for the *existing* pages:
   the rebuild is a new surface beside them, switched over on the Owner's word, the same way `/products/next` sits
   beside `/products`). They need one host the GDS does not have yet — **Q15**.

Two new questions: **Q15** the sheet host, **Q16** which page is rebuilt next (it sets Phase 2's cell-library order).

### 0c. DECIDED 2026-08-28 — the Owner took every recommendation (Q1–Q16) and set the folder

> "I'd actually like to keep the current design system as it is now and maybe add another folder in it for the
> AG grid-related stuff."

The DS stays as it is; the grid system is **one new folder inside it: `apps/web/src/design-system/grid/`**. The
Owner's research proposed a five-layer layout (`theme/ renderers/ editors/ toolbars/ hooks/ columns/ + core`); it is
adopted with those names, mapped onto what already exists:

| Layer (Owner's research) | Folder | What goes there | From |
|---|---|---|---|
| core wrapper `<DataGrid<T>>` | `grid/NexusGrid.tsx` | the thin `AgGridReactProps<T>` passthrough + `density`/`rows`/`columnDialog`/`storageKey` sugar; generic `<NexusGrid<T>>`. **Keeps the name `NexusGrid`** — `DataGrid` is the retiring `<table>` component with 71 importers; the name is free only when wave 1 ends | `engine/NexusGrid.tsx` |
| `theme/` | `grid/theme/theme.ts`, `grid/theme/grid.css` | Theming API bound to `--nds-grid-*` (decision 2 — **not** an `--ag-*` override stylesheet, **not** Tailwind vars: the DS is Tailwind-free and guarded); `grid.css` holds only what the API has no param for | `engine/theme.ts`, `engine/ag-grid.css` |
| tokens | `tokens/grid.ts` → generated `tokens*.css` | the §4.2 `--nds-grid-*` set; density **compact 28/52 · cozy 43/68 · spacious 49/85** (text/media rows, measured) — not the research's 36/44/52, and "cozy" not "standard" (Q3 as approved; Spacious stays the default) | new |
| `renderers/` | `grid/renderers/*.tsx` | memoised cell renderers, each with its `ColDef` fragment and a null-vs-zero test: `Badge` (`Pill`), `Currency`/`Numeric`/`Percent`/`Delta`, `Date`, `Thumbnail` (lifted from grid-lens, `nds-*`), `Identity`, `Tags`, `Coverage`, `ActionMenu`, `Locked`, `Link`, `Stock`, `Group`, `Empty`/`Loading` overlays | `products/next/columns.tsx`, `ProductTreeCell`, `InventoryGrid` cells |
| `editors/` | `grid/editors/*.tsx` | `NumericEditor` (AG's `agNumberCellEditor` params as a preset), `SelectEditor` (DS `Listbox` in a cell), the per-cell round-trip state (`saving`/`saved`/`refused`) | `InventoryGrid` |
| `columns/` | `grid/columns/presets.ts` | factories: `selectColumn()`, `numericColumn`, `currencyColumn(field)`, `dateColumn(field)`, `actionsColumn(actions)` (pinned-right variant), `identityColumn()`, `lockedColumn()` | `numericColumn`, `projectColDefs` |
| `toolbars/` | `grid/toolbars/*.tsx` | `GridToolbar` (DS pattern, re-exported), the selection-actions variant, `GridPager`, `GridFooterStrip`, density `SegmentedControl`; **column visibility = the DS `PreferencesModal` via `columnPrefs`** (decision 7 — no separate popover); search debounced 250ms; CSV export (Q11) | `products/next` pager/strip, `GridToolbar` |
| `hooks/` | `grid/hooks/*.ts` | `useGridState(surface)` (Q4: last-used auto-persist + server views), `useGridExport`, `useAgThemeMode`, `useGridDensity` (context) | `useGridViews`, `useAgThemeMode`, `DensityContext` |
| hosts | `grid/hosts/*.tsx` | `GridCard` (page, autoHeight), `GridPanel` (modal/drawer, bounded), `GridSheet` (Q15) | `nds-gridcard` usage |
| filters | `grid/filters/` | the three DS column filters | `engine/filters/` |
| modules | `grid/modules.ts` | curated list + `MasterDetailModule` (Q12) | `engine/modules.ts` |
| page-specific | **out** → `app/products/next/` | `productsDatasource.ts`, `productsServerContract.ts` | `engine/` |

Also adopted from the research: memoised renderers; `sizeColumnsToFit` as an **opt-in** preset (`autoSize: 'fit'`) —
page grids keep explicit widths because widths are state; shift-click range selection (AG `multiRow` has it — the
spec documents it); `noRowsOverlayComponent`/`loadingOverlayComponent` as DS components. Not adopted: Excel export
(Q11), a Tailwind token bridge, a `--ag-*` stylesheet, 36/44/52.

---

## 1. Corrections to the brief (measured 2026-08-28 against `2b0e43fc4`)

| Brief says | Tree says | Consequence |
|---|---|---|
| DS `DataGrid`: **7** importers | **71** files import it (66 product routes + 4 drawers/modals + 1 wizard). "7" is the count of grids passing `customizable`. | The first migration wave is 10× larger; it must be sub-waved (§7). |
| `AdsDataGrid`: **62**, "hand-rolled" | **57** importers (52 render sites, 5 type-only). Since WG.3e it is a **31-line shim** over the DS `WorkspaceGrid` (1,074 lines); `AdsDataGridProps` ≡ `WorkspaceGridProps`. | There is one props contract to retire, not two. The 52 sites still import the shim; the DS name has **0** product importers. |
| `grid-lens`: **63** | **65** (63 + a 9-line re-export shim + a type-only import). **41 of 65 use only `AutoRefreshSelect`/`GridToolbar`** — toolbar consumers, not grid consumers. **20** render `VirtualizedGrid`. | Only 20 grid-lens sites carry the 8-key localStorage contract; 41 are cheap toolbar swaps. |
| `WorkspaceGrid`: **2** importers | 2 runtime (`AdsDataGrid` shim, `/design/grid-lab`) + 1 type-only. `AgWorkspaceGrid` is imported only by the lab. | Both retire in the ads wave. |
| **196** raw `<table>` files | **206** matches; 6 are prose-only → **200** real. Classified: **117 data grids · 47 matrices · 10 key-value · 19 form rows · 4 print/email · 3 other**. | 164 are grid work; 36 are not grids and leave the programme. |
| The ads console = `AdsDataGrid` | The **Ad Manager itself** (`campaigns/CampaignsGrid.tsx`, 2,190 lines) does **not** use it — hand-rolled `<table>`, own pager, own `PreferencesModal` wiring, own storage shapes. | It is the single largest un-migrated grid and a DATA migration (memory: `project_campaignsgrid_workspacegrid_blocked`). |
| "Both DS copies byte-identical" | `apps/factory` has **no** `patterns/workspace-grid/` at all, no `workspace-grid.css`, no `tokens-global.css`; the four shared stylesheets differ by 842 / 279 / 178 / 133 lines; factory's token generator cannot run (`__dirname` in ESM). | The engine is web-only today and the guard is blind to every stylesheet. §5 Q1 decides what "both copies" means for the GDS. |
| Engine colours "already flip under `.dark`" (`theme.ts` header) | `.dark` in `tokens.css` redefines **54 semantic tokens and zero ramp steps**. `theme.ts` binds ground, header ground, row rule, header rule, partition, frame and the pinned row to `--nds-white` / `--nds-grey-25/150/200` — none flip. Only the four `nds-ag-nexus` overrides (`--nds-text-strong`, `--nds-text`, `--nds-surface-raised`, `--nds-wash-primary`) and the hover (`--nds-imgup-surface`) do. | Dark mode on any NexusGrid today = dark text tokens on a white ground. §4 fixes this by deriving every grid token from a **semantic** token. (Separately, `.dark` is inert on `/products/next` for a load-order reason — pre-existing, outside GDS.) |
| Four grid engines | **Five**: DS `DataGrid`, `WorkspaceGrid`/`AdsDataGrid`, grid-lens `VirtualizedGrid`, NexusGrid — **plus `@tanstack/react-table`** (4 files: `InventoryTable`, `SyncQueueTable`, `PricingRulesTable`, `BulkActionsTable`) and two hand-rolled outliers (`CampaignsGrid`, `FlatFileGrid` 3,318 lines with its own 10-key persistence — **untouchable** per the flat-file rule). | TanStack joins the raw wave; `FlatFileGrid` is out of scope and stated so. |
| `/design/catalog` | No such route. The catalog renders at **`/design`** (`TokenCatalog.tsx`, section `data-cat="datagrid"` shows the DS `DataGrid`). Labs: `/design/grid-lab`, `/design/console`. | The GDS catalog section replaces the `datagrid` section at `/design`; scenarios go in `/design/grid-lab` as a tab (extend, don't add pages). |
| `sinkBlanks`/`compareSortValues` are the engine's | They live in `patterns/workspace-grid/sortValues.ts` — the **legacy** folder — and the engine imports `../sortValues`. | Moves into the engine before `WorkspaceGrid` retires. |
| `Thumbnail`, density context are shared pieces | Both come from `app/_shared/grid-lens` (Tailwind); `columns.tsx`, `InventoryGrid.tsx`, `ProductsNextClient.tsx`, `density.ts` import them. `useGridViews`/`productsDatasource` import `@/lib/backend-url`. | The DS grid depends on the app layer in three places. The GDS lifts `Thumbnail` + density into the DS. |

Two more facts the brief does not carry:

- **`size` on the DS `DataGrid` is passed by 70 of 71 importers** (mostly `xs`/`sm`); the default `md` is dead.
- **A `null` is rendered as an em-dash by 55 of 71 `DataGrid` sites and not at all by 16** — the DS gives no
  affordance for "unmeasured vs measured-zero", so every grid hand-rolls it and 16 got it wrong. This is the single
  biggest consistency defect in the inventory and it is a cell-library problem (§5 Cell types).

---

## 2. Inventory of every grid surface

Counts are distinct files; "host" is where the grid sits; "state" is what it persists and in what shape.
Full per-file tables (route, features, cells, storage keys) are in the four audit reports this section
condenses; they are reproduced in Appendix A at the end of this document.

### 2.1 NexusGrid — the seed (3 surfaces, 13 importer files)

| Surface | Path | Host | Row model | Features | State it owns |
|---|---|---|---|---|---|
| **Catalogue** `/products/next` | `app/products/next/ProductsNextClient.tsx` (1,065) + `columns.tsx` (451), `ProductTreeCell.tsx`, `FamilyFooter.tsx`, `GridViewsMenu.tsx`, `density.ts`, `useBulkActions.ts`, `BulkEditModal.tsx`, `TagDialog.tsx`, `styles.module.css` (540) | page card `nds-gridcard` | **SSRM** + tree (families lazy, preview capped at 10 in the grid's sort, 48px footer row) OR server row grouping + aggregation (view mode) | `autoHeight` + AG pagination + DS pager 50/100/200/500 · sort server-side · AG `filterModel` is the ONE filter state (accordion + search + 3 DS column filters write it) · Customise = DS `PreferencesModal` tabbed (Columns + Grouping) via `columnPrefs` · saved views (server, `SavedView` surface `products-next`, `{v:1, gridState, page:{filters,tile,density,lockedColumns,pageSize}}`) · one-way selection, `selectAll:'currentPage'` · bulk toolbar swap · CSV export · KPI tiles · header menu with Customise/Reset | server: views; localStorage: `products-next:*` warning dismissal only |
| **Family page** `?parent=` | same client, `familyId` context | page card | SSRM, flat list of one family's variations | as catalogue minus tree | same |
| **Inventory editor** (modal behind Available) | `InventoryEditorModal.tsx` (243), `InventoryGrid.tsx` (294), `useInventoryEditor.ts`, `inventoryEditor.logic.ts` (+7 tests) | **modal** `xxl`, inside its own `nds-gridcard` + `GridToolbar` + in-card footer strip | **CSRM**, ≤ ~40 rows | column groups per location rendered as the 30px strip · number editor, Enter↓/Tab→/Esc · fill handle, paste, undo/redo · pending overlay (amber + delta chip) · batch Apply → per-change results (refused = red + reason) · pinned totals at header height · identity col pinned 320px + thumb delta · quick filter · locked FBA/Shopify in the ColDef · bounded height ≤ 480 · follows the page's density | localStorage `products-next:inventory-editor:hidden-columns` (`OptionalColumnKind[]`) |

Engine files: `NexusGrid.tsx` 230 · `theme.ts` 149 · `modules.ts` 122 · `ag-grid.css` 290 · `filters/gridFilters.tsx` 173 ·
`columnPrefs.ts` 122 (+114 test) · `useGridViews.ts` 165 · `useAgThemeMode.ts` 38 · `productsDatasource.ts` 108 ·
`productsServerContract.ts` 86 (+42 test) · `theme.vitest.test.ts` 25 · `AgWorkspaceGrid.tsx` 498 (spike, lab-only).

Stable-identity compliance (decision 12): `/products/next` memoises every option object and callback it passes
(`rowSelection`, `selectionColumnDef`, `columnDialog`, `localeText`, `getRowHeight`, `isFullWidthRow`, datasource,
`initialState`, 9 event handlers). The inventory editor memoises `rowSelection`/`selectionColumnDef`/`cellSelection`/
`defaultColDef`/`getRowId` but passes **five inline arrow callbacks** (`onCellValueChanged`, `onUndoEnded`,
`onRedoEnded`, `onPasteEnd`, `onFillEnd`) — the memoisation guard (§8.5) will catch exactly these.

### 2.2 DS `DataGrid` — 71 importers (`design-system/components/DataGrid.tsx`, `<table>`, class `.nds-grid`)

| Family | Files | Host | Rows | What they use | State |
|---|---|---|---|---|---|
| Workspace pages with Customise | 6 (`fleet/activity`, `fleet/map` list, `stock/locations`, `sync-control/history`, `pricing/volume-pricing`, `fleet/workers`) | page card / modal | 100s | `customizable` + `storageKey` (DS `PreferencesModal`), sort, density `size`, paging via DS `Pagination` | localStorage `area.page.columns` (`string[]` visible order); **`WorkersClient` hand-rolls `COLS_KEY`** |
| Ads-console tabs & cards | 17 (`ads-console/automation/*` 12, `bulk`, `campaigns/CampaignsTable`, `products/ProductsTable`, `rank/KeywordBidStation`, `targeting`) | tab panel / card | 100s; **CampaignsTable + ProductsTable large** | controlled sort, gated `selectable`, `getSubRows` **and** `renderExpanded` together (2), totals (`RankPlacementCockpit`), rowClassName, CSV | `CampaignsTable` hand-rolls `STORAGE_KEY`; `RankPlacementCockpit` stores **expansion state** `rc3kwdis:${campaignId}:${market}` (no DS prop for it) |
| Ads main — cards/inline/tabs | 27 (`rules-automation/*` 15, `campaign-builder/*` 4, `reporting/*` 2, `analytics` 2, `portfolios` 2, `dashboard`, `health`) | card / inline / tab | 10s–100s | `renderExpanded`, `rowProps` (**drag-drop rows** in `PortfoliosClient`), totals, rowClassName, URL-bridged sort/filter | none beyond URL |
| Drawers | 4 (`BudgetPoolsDrawer`, `BidTargetDrawer`, `LeverDrawer`, `TermDrawer`) | **drawer** | 10s | `maxHeight`, expand, paging | — |
| Modals | 7 (`AiGoalBuilder`, `ImportCsvModal`, `WhyModal`, `LaunchStep`, `ebay` wizard steps 3, `EbayImportWizard`) | **modal** | 10s (one large) | `maxHeight`, totals, locked cells | — |
| Fulfilment / sync-control | 6 (`ImportClient`, `SyncControlClient`, `SyncProductsGrid`, `ProductDetailClient`, `HistoryClient`, `LocationsClient`) | page card / modal / tab | **large** (sync) | thumbnail identity, gated select, expand, paging | `localStorage: MAPPING_STORE_KEY`, `sessionStorage: WIZARD_SESSION_KEY` (import wizard) |
| Other | 4 (`EbayDigest`, `ProfitPanel`, `BusinessContextPanel`, `IncrementalityPanel`) | card | small | — | — |

`DataGrid` prop surface: `columns/rows/rowKey`, `selectable/selected/onSelectedChange/rowSelectable/*Hint/subRowSelectable`,
`initialSort` | `sort+onSortChange`, `renderExpanded/getSubRows/expanded`, `rowProps/headerProps/cellProps/rowClassName`,
`showTotals/emptyState/size/maxHeight`, `customizable/storageKey/customizeOpen/onCustomizeOpenChange/customizeTitle`.
Column: `key/label/render/align/numeric/className/sortable/sortValue/prefsLocked/sticky/stickyRight/width/total/group/prefsLabel`.
**No filtering, pagination, export, density toggle or tree beyond `getSubRows`** — every site that has those built them.
`headerProps`/`cellProps` have **zero** users. 16 app stylesheets patch `.nds-grid` per route (`map.css`, `reporting.css`, `amazon.css`…).

### 2.3 `grid-lens` — 65 importers (`app/_shared/grid-lens/`, 22 files, 5,112 lines, **100 % Tailwind, 0 `nds-*` classes**)

| Family | Files | Host | Rows | Table | State (the de-facto 8-key contract) |
|---|---|---|---|---|---|
| Workspaces on `VirtualizedGrid` | **20** (`ProductsWorkspace`+`GridView`, `ListingsWorkspace`, `StockWorkspace`, `ReplenishmentWorkspace`, `PricingMatrixClient`, `stock/{analytics,channel-drift,lots,mcf,reservations,shopify-locations,stockouts,transfers}`, `ebay/{campaigns,markdowns}`, …) | page card | 100s–**10k+** | `VirtualizedGrid` (1,049 lines: virtualised `<table>`, resize, sticky edges, expand, selection) | `<ns>.visibleColumns` (`string[]`, **order significant**; `orders` uses `.v2`) · `<ns>.columnWidths` (`Record<key,px>`, the only key the kit writes itself) · `<ns>.density` (`compact|cosy|comfortable`, raw string) · `<ns>.stickyFirstColumn`/`.stickyLastColumn` (`"true"/"false"`, **read as `!== 'false'` so absent = true**) · `<ns>.filterOrder` · `<ns>.autoRefreshMin` · `<ns>.lensTabOrder`, `.nameDisplay` (products). **`ListingsWorkspace` namespaces per marketplace** (`amazon-it.visibleColumns`). Replenishment uses `nexus-replenishment-*`; `StockWorkspace` did the only real migration (localStorage views → server, then `removeItem`). Saved views (server): `filters` is an untyped bag with `_density`, `_pageSize`, `_columnWidths`. |
| Toolbar-only consumers | **41** (`AutoRefreshSelect`/`GridToolbar`/`DensityToggle`/`KeyboardShortcutsModal` around a raw `<table>` or a list) | page card | 10s–10k | raw `<table>` (33) / list / cards | `<ns>.density`, `<ns>.autoRefreshMin` |
| `PreferencesModal` **fork** users | 6 (`Products`, `Listings`, `Stock`, `Replenishment`, `PurchaseOrders`, `PricingMatrix`) | — | — | 416-line Tailwind dialog; DS one is a strict superset except `labelKey` (i18n) and `width` on the column spec | as above |
| Pieces `/products/next` borrows | `Thumbnail` (396 lines, hover-zoom portal, lazy, fallback; sizes 32/40/56), `DensityContext`, `Density` type | — | — | — | — |

A **third** Customise dialog exists: `products/[id]/edit/_shared/TabPreferencesModal.tsx`.

### 2.4 `AdsDataGrid` = DS `WorkspaceGrid` — 57 importers (52 render sites)

| Route family | Files | Dominant props | Inline edit → server | Host | Rows |
|---|---|---|---|---|---|
| `campaigns/[id]/tabs`, `ad-groups/[agId]/tabs` | 8 | `editMode`, `selectionActions`, `enabledFirst`, `storageKey`, `filters` | **yes, 7 of 8** (bid/budget/state `fetch` per cell) | tab panel + Modal | 10s–1000s (search terms) |
| `ebay/campaigns/*/tabs`, `ebay/*` lists | 14 | `storageKey`, `searchValue`, `selectable`, `defaultSort`, `groupBy`, `filterPresetsKey` (1) | yes, 3 | tab panel / page card | 10s–1000s |
| `reporting/*` | 6 | **`showTotal` (all 6)**, `hierarchy` (1: `ExplorerTab`), `groupBy`, **`server` mode (1: `ReportRunner`, 12,276-row report)** | no | tab / card | **10k+** |
| `rules-automation/*` | 19 (+3 type) | `filterState`+`onFilterStateChange`+`hideFilterPanel` (the ONE filter bar), `emptyNode`, `selectionActions`, `onRowClick`, `totalFirst` | 1 (`CampaignLimitsModal`) | page card; 8 with Drawer; 1 Modal | 100s–1000s |
| `suggestions`, `ai-advertising`, `budget-manager`, `changelog` | 5 | `keyboardNav`+`onRowKey`, **`freezeRight` columns (2)**, full URL bridge | no | page card + Drawer/Modal | 100s–1000s |

`WorkspaceGrid` persists `GridPrefs = {visible: string[], stickyFirst, stickyLast}` under `storageKey` (48 distinct keys in **four**
naming conventions: `h10-*`, `er1-ebay-*`/`h10-ebay-*`, `nexus.*.cols`, bare/`rpt-`/`rpx-`, one dynamic
`suggestions-grid-${view}-v1`), plus `filterPresetsKey` (1 file). No widths, no sort, no density, no page size.
It renders **no density toggle** at all. It has no expandable rows (`RuleDetail` is a Drawer for that reason), no
column groups, no dynamic row height. Its CSS is `workspace-grid.css` (146 rules) which **must load after `ads.css`**,
plus 74 `.h10-am-*` rules still in `ads.css` (toolbar, pager, total, group header, search box).

Prop demand over 52 sites (drives the cell/host library): `storageKey` 38 · `selectable` 35 · `defaultSort` 34 ·
`emptyLabel` 32 · `searchable` 31 · `showTotal` 25 · `selectionActions` 23 · `filters` 23 · `pagerCentered` 21 ·
`toolbarRight` 19 · `emptyNode` 19 · `customizable` 19 · `toolbarLeft` 17 · `selected` 16 · `reportLabel` 16 ·
`exportable` 14 · `enabledFirst` 14 · `onRowClick` 13 · `editMode` 10 · `groupBy` 3 · `keyboardNav` 3 · `server` 1 · `hierarchy` 1.

### 2.5 The Ad Manager — `marketing/ads/campaigns/CampaignsGrid.tsx` (2,190 lines, hand-rolled)

Page card · 1000s of rows · own `<table>` + `campaigns-ds.css` · own pager and `rowsPerPage` · own `PreferencesModal`
wiring (title "Table Customization") · borrows only `enabledRank` · localStorage shapes documented in
`project_campaignsgrid_workspacegrid_blocked` (`${storageKey}-hidden-cols`, `-frozen-cols`, `COLS_KEY`,
`SAVED_VIEWS_STORAGE_KEY`, `ACTIVE_VIEW_KEY`, `ff-*`; 0 rows locally — verification is prod-only).

### 2.6 Raw `<table>` — 200 files (classified)

| Class | Files | Where | Disposition |
|---|---|---|---|
| **(1) Data grid** | **117** | orders 11 · fulfilment/stock/suppliers 28 · inventory/sync 7 · listings 3 · catalog/products 23 · marketing 13 · pricing 4 · bulk-ops 9 · settings/admin 9 · dashboard/reports 10 | → NexusGrid (wave 5) |
| **(3) Matrix / pivot** | **47** | products variant×channel/locale 25 (`_lenses/*`, edit tabs, datasheet, cockpits) · catalog 2 · insights 9 · dashboard 2 · fulfilment 5 · other 3 | → NexusGrid with column groups (the inventory editor is the reference) — except `FlatFileGrid` (untouchable) and the two heatmaps (charts, not grids) |
| (2) Key-value / detail | 10 | drawers, datasheet overview, diff modals | **not grids** → a DS description-list (does not exist yet; DS-GAPS entry) |
| (4) Settings / form rows | 19 | settings, PO create/receive, list-wizard steps | not grids → DS form layout |
| (5) Print / email / static | 4 | datasheet print, A+ render, shared report | out of scope |
| (6) Other | 3 | `components/ui/DataTable.tsx` (generic shell — retire), 2 style-guide demos | retire / out of scope |
| TanStack (`@tanstack/react-table`) | 4 (inside class 1) | `InventoryTable`, `SyncQueueTable`, `PricingRulesTable`, `BulkActionsTable` | → NexusGrid (wave 5); removes a fifth engine |

20 raw tables also write localStorage (own key shapes each); `app/_shared/useColumnResize.tsx` is a shared
column-width persistence hook several use.

---

## 3. Feature matrix — §6 scenarios × surface families

Legend: **U** uses today · **N** needs (has it hand-rolled, or will need it on NexusGrid) · **–** n/a.
Columns: **A** `/products/next` catalogue · **B** family page · **C** inventory editor · **D** DS `DataGrid` ×71 ·
**E** grid-lens `VirtualizedGrid` ×20 · **F** grid-lens toolbar-only ×41 · **G** `AdsDataGrid` edit tabs ×8 ·
**H** `AdsDataGrid` reporting ×6 · **I** `AdsDataGrid` rules/ebay/other ×38 · **J** Ad Manager `CampaignsGrid` ·
**K** raw data grids ×117 (+4 TanStack) · **L** raw matrices ×47 · **M** out of scope (KV 10, forms 19, print 4, `FlatFileGrid`, heatmaps).

| Scenario (§6) | A | B | C | D | E | F | G | H | I | J | K | L | M | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Catalogue page (SSRM, tree, pagination, autoHeight) | U | – | – | – | N (Products/Listings/Stock/Repl 10k+) | – | – | N (`ReportRunner` server mode) | – | N | N (11 lists at 1000s) | – | – | SSRM only where the server can page; everything else CSRM |
| Family page (`?parent=`) | – | U | – | – | – | – | – | – | – | – | – | – | – | one surface |
| Row grouping with aggregates | U | – | – | – | – | – | – | U (`groupBy` client-side) | U (`groupBy` ×2) | – | N (sync logs, PO lines) | – | – | server-side on SSRM, AG client grouping on CSRM |
| Bulk-select + toolbar swap | U | U | U (Set N selected) | U (gated `selectable` ×18) | U (`BulkActionShell`) | – | U (`selectionActions`) | U | U | U | N (~30 selectable) | – | – | one `GridToolbar` selection variant |
| Column customise (locked, groups, totals) | U (tabbed) | U | U (MultiSelect, 4 optional kinds) | U ×6 (DS modal) | U ×6 (**fork**) | – | U ×19 | U | U | U (own wiring) | N (~15 with pickers) | N | – | ONE dialog; the fork and the third copy retire |
| Saved views incl. default on first load | U (server) | U | – | – | U (server + `_density/_pageSize/_columnWidths` bag) | – | – | U (`ads-reporting` surface) | – | U (localStorage!) | N (orders, sync logs) | – | – | Grid State API payload on `SavedView` |
| CSV export | U | U | – | N (11 hand-rolled) | N | – | U (`exportable` 14) | U | U | U | N | N | – | AG CsvExport; Excel = Q11 |
| Grid inside a modal (editor) | – | – | U | U ×7 | – | – | U (bulk modals) | – | U (1) | – | N (import previews ×6) | – | – | bounded height, no card frame |
| Grid inside a drawer | – | – | – | U ×4 | – | – | – | – | U (8 routes open drawers with grids) | – | N | – | – | bounded, narrow, no pinned identity |
| Grid inside a tab panel | – | – | – | U ×~25 | – | – | U | U | U | – | N | N | – | page-height rules apply |
| Read-only reporting grid | – | – | – | U (34 ads main) | – | – | – | U | U | – | U (logs, reports) | U | – | totals row + export |
| Editable grid, server round-trip per cell (bid/budget) | – | – | – (batch) | – | – | – | **U ×7** (`editMode`) | – | U (1) | U (bid/budget inline) | N (costs, suppliers) | N (pricing matrix) | – | needs the per-cell "saving → saved / refused" state the batch editor lacks |
| Frozen/pinned right actions column | U (`actions` lockPosition right, **not pinned**) | U | – | U (`stickyRight`) | U (sticky last) | – | – | – | U (`freezeRight` ×2) | – | N (~40 have an actions column) | – | – | pinned-right = spec section |
| Pinned totals row | – | – | U (header height) | U (`showTotals` ×5) | – | – | – | **U ×6** | U (25 total) | U | N (finance, reports) | N | – | one pinned-row style |
| Expandable detail rows | – | – | – | U (`renderExpanded` ×9) | U (expand) | – | – | – | – | – | N | – | – | AG master/detail — module NOT registered today (Q12) |
| Column groups | – | – | U (30px strip) | – | – | – | – | – | – | – | – | **N ×47** | – | the strip is the spec |
| Matrix (rows × locations) | – | – | U | – | – | – | – | – | – | – | – | U/N | – | inventory editor is the reference |
| 0-row grid | U (overlay) | U | U (no locations state) | U (`emptyState` ×40) | U | – | U (`emptyLabel` 32, `emptyNode` 19) | U | U | U | U | U | – | one empty-state renderer with a CTA slot |
| 1-row grid | U (single product editor) | – | U | U | – | – | – | – | – | – | U | U | – | header + 1 row + pager reads correctly |
| 10,000-row grid | U (paged 500) | – | – | U (sync ×2) | U (×5 at 10k+) | – | – | U (12k server) | – | U | U (~15 logs) | – | – | pagination 500 cap under autoHeight; SSRM where the server pages |
| Very long text / wrapping cells | U (product title ellipsis) | U | – | U | U | – | U (search terms) | U | U | U | U | – | – | ellipsis + `title`; wrap only in the empty state and full-width rows |
| Dark mode | N (tokens don't flip; shell pins light) | N | N | U (semantic tokens) | – (Tailwind) | – | N (`.h10-shell` pins light) | N | N | N | N | N | – | grid tokens derive from semantic tokens (§4); verified in the lab and on non-shell routes |
| Compact / Cozy / Spacious | U | U | U (follows page) | U (`size` ×70) | U (`compact/cosy/comfortable`) | U (toggle only) | – (none) | – | – | – | N | N | – | ONE vocabulary (Q3) |
| 962px laptop / 1440px monitor | U (measured) | U | U (≤480 cap) | N | N | – | N | N | N | N | N | N | – | lab scenario at both viewports |
| Keyboard-only operation | U (AG) | U | U (Enter/Tab/Esc) | partial | partial (`KeyboardShortcutsModal`) | – | U (`keyboardNav` j/k ×3) | – | U | U | N | N | – | AG's map + the DS additions, documented |
| Screen-reader announcement of sort/selection | U (AG ARIA) | U | U | partial | – | – | – | – | – | – | N | N | – | AG's `aria-sort`/`aria-selected` kept; live-region for bulk counts = spec |
| RTL | – | – | – | – | – | – | – | – | – | – | – | – | – | **out of scope** (Q8) |
| Mobile widths (< 1024) | – | – | – | – | – | – | – | – | – | – | – | – | – | **out of scope** — desktop console; the card scrolls horizontally (Q8) |
| Ads console "cannot verify locally" | – | – | – | U (ads-console ×17) | – | – | **U** | **U** | **U** | **U** | – | – | – | parity measured in `/design/grid-lab` from frozen fixtures; prod verification per wave |

---

## 4. Token audit → the grid tokens

### 4.1 Every visual value the grid surfaces use today

Sources: `engine/theme.ts`, `engine/ag-grid.css`, `products/next/density.ts` + `styles.module.css`, `InventoryGrid.tsx`
constants, `styles/components.css` `.nds-grid*`, `styles/workspace-grid.css`, `styles/patterns.css` `.nds-gridcard`/`.nds-toolbar`.

| Property | NexusGrid (theme + nexus overrides) | DS `DataGrid` `.nds-grid` | `WorkspaceGrid` `.nds-wsgrid` | Hard-coded? |
|---|---|---|---|---|
| Ground | `--nds-white` ✗dark | `--nds-surface` | `--nds-white` | theme ramp |
| Header ground | `--nds-grey-25` ✗dark | `--nds-surface-raised` | `--nds-grey-25` | theme ramp |
| Header text | `--nds-text-strong` (override; theme says `--nds-wsgrid-head-fg`) | `--nds-text-strong` | `--nds-wsgrid-head-fg` | two answers |
| Header type | 11.5px / 700 | 11.5 / 700 | 11.5 / 700 | numbers in 3 files |
| Body text | `--nds-text` (override; theme `--nds-grey-800`) | `--nds-text` 500 | `--nds-grey-800` 500 | two answers |
| Body type | 13px / 500, `--nds-font-sans` | 13 / 500 | 13 / 500 | |
| Row rule | `--ag-row-border: 1px solid --nds-grey-150` (ag-grid.css) ✗dark | `--nds-border-subtle` | `--nds-grey-150` | ramp + a CSS var workaround |
| Header rule | 1px `--nds-grey-200` ✗dark | `--nds-border` | `--nds-grey-200` | ramp |
| Header partition | 2px `--nds-grey-150`, 30 % height, handle 0 ✗dark | none | none | ramp |
| Frame | 1px `--nds-grey-200`, r 12 (removed in card) | `--nds-border`, `--nds-radius-2xl` | `--nds-grey-200`, 12px | ramp; card = semantic |
| Hover | `--nds-surface-raised` (override; theme `--nds-imgup-surface`) | `--nds-surface-raised` | `--nds-imgup-surface` | two answers |
| Selected | `--nds-wash-primary` (override; theme `--nds-blue-50`) | `--nds-wash-primary` | `--nds-blue-50` | two answers |
| Pinned totals | `--nds-grey-25` 700 ✗dark; height = header height | `--nds-surface-raised` 700, border-top `--nds-border` | `--nds-grey-25` 700 `--nds-grey-900` | ramp |
| Child tint / rail / child hover | `--nds-surface-sunken` / 3px inset `--nds-border` / `--nds-surface-hover` | same (`.nds-grid-kid`) | `--nds-surface-sunken` italic (remainder) | ✓ |
| Group strip | `--nds-surface-sunken`, inset 1px `--nds-grey-150`, 11/700/.05em caps `--nds-text-2`, 30px | — | `--nds-grey-100` 7/16 12/700 `--nds-grey-700` (group header row) | ramp in the inset |
| Empty state | `--nds-text-2`, 28px, max 320, wraps | `--nds-text-3`, 40px | `--nds-text-2`, 28px | 3 answers |
| Accent / focus | `--nds-primary`; focus ring `--nds-focus-ring` (page css) | `accent-color --nds-primary` | `--nds-blue-600` custom 20px checkbox r5 | |
| Radius | `--nds-radius-sm` (AG `borderRadius`) | — | 4–7px literals | literals in wsgrid |
| Cell padding | 14px; xs 10px (AG renders −1) | 10–11/14; sm 7/10; xs 5/9; lg 14; xl 19 | 12/14 | 3 tables |
| Row height | engine 28/34/43/49/59 (xs–xl); page 52/68/85; footer 48; ads 46 | derived from padding | derived (46 measured) | **4 vocabularies** |
| Header height | 28/32/38/46/56; page uses xs/md/lg = 28/38/46; ads 44.5 | derived | 44.5 | |
| Selection column | 43px | 40px | 46px (`.ck`) | 3 answers |
| Checkbox | AG default (16px, theme accent) | 15px native `accent-color` | 20px custom SVG r5 | 3 answers |
| Thumbnail | 32/40/56 (`THUMB_PX`, grid-lens) | — | — | app kit |
| Identity col | 320 + thumb delta (editor); name at x=155 (page) | `td.nm` 300px sticky | 300px sticky | |
| Sort indicator | AG icon | `--nds-text-disabled` → sorted `--nds-text-link` | `--nds-grey-300/600/500`, sorted `--nds-blue-600` | |
| Skeleton | `ProductsSkeleton` (page) | — | `--nds-grey-100/150` shimmer | |
| Editing: editable hover / editor / pending / refused / locked / delta chip | inset 1px `--nds-border` / AG default / `color-mix(--nds-warning 14%)` / `color-mix(--nds-danger 10%)` + inset 1px `--nds-danger` / `--nds-text-muted` + 🔒 / bg `--nds-warning`|`--nds-danger`, **`color: #fff`** | — | `h10-edit*` in ads.css | **one raw hex** |
| Stock levels | out/low/ok = `--nds-danger`/`--nds-warning`/`--nds-success` 600 | — | — | |
| Shadows (frozen edges) | none | `inset 1px 0 0 --nds-border-subtle` | `rgba(16,24,40,.08)` ×3 | **raw rgba** |
| Pager | page css: 10px 14px, top rule `--nds-border`; DS `Pagination` + `Listbox` | DS `Pagination` | `.h10-am-pager` 30px buttons r7 `--nds-grey-150/600`, on `--nds-blue-600` | ramp literals |
| Toolbar | `.nds-gridcard .nds-toolbar` 14px 16px, rule `--nds-border-subtle` | same | `.h10-am-toolbar` (ads.css) | |
| Filter popover | 8px pad, 240–320 wide, list 260 max | — | `.h10-am-fpanel` | |
| Popup parent | `document.body` + `data-ag-theme-mode` on `<html>` | — | — | ✓ |

**Nothing hard-coded survives** means: the raw `#fff`, the three `rgba(16,24,40,.08)`, every ramp binding in `theme.ts`,
the `--ag-row-border` workaround, the four `nds-ag-nexus` overrides (which exist only because the theme binds the wrong
tier), and the row/header/thumb numbers in `NexusGrid.tsx`, `density.ts`, `InventoryGrid.tsx` (`HEADER_PX`, `STRIP_PX`,
`IDENTITY_BASE_PX`) and `ProductsNextClient.tsx` (`FAMILY_FOOTER_PX`, 43) all move into **one** token table.

### 4.2 Proposed grid component tokens (tier 3, `--nds-grid-*`)

Declared in a new `tokens/grid.ts`, emitted by `css-vars.ts` into **both** generated files (`tokens.css`,
`tokens-global.css`) under a `Tier 3: grid` section, consumed by `theme.ts` (colours, radii, type) and `ag-grid.css`
(what the Theming API has no param for). Dark values are **not** restated: every colour derives from a semantic token
that `.dark` already flips, which is the whole fix for §1's dark-mode finding. Numbers are the measured ones.

| Token | Value | Derives from | Replaces |
|---|---|---|---|
| **Surfaces** | | | |
| `--nds-grid-bg` | `var(--nds-surface)` | semantic | theme `--nds-white` |
| `--nds-grid-header-bg` | `var(--nds-surface-raised)` | semantic (= grey-25 light) | theme `--nds-grey-25` |
| `--nds-grid-strip-bg` | `var(--nds-surface-sunken)` | semantic | ag-grid.css literal token |
| `--nds-grid-totals-bg` | `var(--nds-surface-raised)` | semantic | theme `--nds-grey-25` |
| `--nds-grid-hover-bg` | `var(--nds-surface-raised)` | semantic | nexus override + theme `--nds-imgup-surface` |
| `--nds-grid-selected-bg` | `var(--nds-wash-primary)` | semantic | nexus override + theme `--nds-blue-50` |
| `--nds-grid-child-bg` | `var(--nds-surface-sunken)` | semantic | ag-grid.css |
| `--nds-grid-child-hover-bg` | `var(--nds-surface-hover)` | semantic | ag-grid.css |
| `--nds-grid-child-rail` | `var(--nds-border)` | semantic | ag-grid.css |
| `--nds-grid-chrome-bg` | `var(--nds-surface-raised)` | semantic | theme `chromeBackgroundColor` (menus, tool panels) |
| **Rules** | | | |
| `--nds-grid-row-rule` | `var(--nds-border-subtle)` | semantic (= grey-150) | `--ag-row-border` workaround |
| `--nds-grid-header-rule` | `var(--nds-border)` | semantic (= grey-200) | theme `--nds-grey-200` |
| `--nds-grid-partition` | `var(--nds-border-subtle)` | semantic | `HEADER_COLUMN_PARTITION.color` |
| `--nds-grid-partition-w` / `-h` | `2px` / `30%` | measured | `HEADER_COLUMN_PARTITION` |
| `--nds-grid-strip-rule` | `var(--nds-border-subtle)` | semantic | ag-grid.css inset |
| `--nds-grid-frame` | `var(--nds-border)` | semantic | theme `--nds-grey-200` |
| `--nds-grid-frame-radius` | `var(--nds-radius-2xl)` | DS scale (12px — confirm in Phase 1) | theme `12` |
| **Type** | | | |
| `--nds-grid-header-fg` | `var(--nds-text-strong)` | semantic (9.87:1) | nexus override; `--nds-wsgrid-head-fg` retires with the wsgrid |
| `--nds-grid-header-size` / `-weight` | `11.5px` / `700` | measured | theme + components.css |
| `--nds-grid-cell-fg` | `var(--nds-text)` | semantic | nexus 3-var override |
| `--nds-grid-cell-size` / `-weight` | `13px` / `500` | `--nds-font-size-base` / medium | theme |
| `--nds-grid-muted-fg` | `var(--nds-text-muted)` | semantic (5.9:1) | page css (`noSales`, `updatedCell`, locked) |
| `--nds-grid-strip-fg` / `-size` / `-tracking` | `var(--nds-text-2)` / `11px` / `0.05em` | semantic | ag-grid.css |
| `--nds-grid-empty-fg` | `var(--nds-text-2)` | semantic | 3 different answers today |
| **Density** (three tiers, two row kinds — see Q3) | | | |
| `--nds-grid-row-text-{compact,cozy,spacious}` | `28px` / `43px` / `49px` | measured (engine xs/md/lg) | `ROW_HEIGHT` |
| `--nds-grid-row-media-{compact,cozy,spacious}` | `52px` / `68px` / `85px` | measured (page) | `DENSITY_ROW_PX` |
| `--nds-grid-header-{compact,cozy,spacious}` | `28px` / `38px` / `46px` | measured | `HEADER_HEIGHT`, `HEADER_PX` |
| `--nds-grid-thumb-{compact,cozy,spacious}` | `32px` / `40px` / `56px` | measured | `THUMB_PX`, grid-lens sizes |
| `--nds-grid-cell-pad-x` / `-x-compact` | `14px` / `10px` | measured | theme + ag-grid.css |
| `--nds-grid-strip-h` | `30px` | measured | `STRIP_PX` |
| `--nds-grid-footer-row-h` | `48px` | Owner decision | `FAMILY_FOOTER_PX` |
| `--nds-grid-select-col-w` | `43px` | measured | `selectionColumnDef` ×2 |
| `--nds-grid-identity-w` | `320px` | measured (34-char SKU) | `IDENTITY_BASE_PX` |
| **Controls** | | | |
| `--nds-grid-accent` | `var(--nds-primary)` | semantic | theme |
| `--nds-grid-focus-ring` | `var(--nds-focus-ring)` | DS | page css |
| `--nds-grid-radius` | `var(--nds-radius-sm)` | DS | theme `borderRadius` |
| `--nds-grid-checkbox-size` / `-radius` | `16px` / `var(--nds-radius-sm)` | AG default as live on /products/next (Q7) | 15 / 20 elsewhere |
| `--nds-grid-drag-handle` / `--nds-grid-fill-handle` | `var(--nds-primary)` | semantic | AG defaults |
| **Editing states** | | | |
| `--nds-grid-editable-ring` | `var(--nds-border)` | semantic | `.ieEditable:hover` |
| `--nds-grid-editor-ring` | `var(--nds-primary)` | semantic | AG default |
| `--nds-grid-pending-bg` | `color-mix(in srgb, var(--nds-warning) 14%, transparent)` | semantic | `.iePending` |
| `--nds-grid-refused-bg` / `-ring` | `color-mix(in srgb, var(--nds-danger) 10%, transparent)` / `var(--nds-danger)` | semantic | `.ieFailed` |
| `--nds-grid-saving-bg` | `color-mix(in srgb, var(--nds-info) 10%, transparent)` | semantic | **new** — per-cell server round-trip state (ads bids) |
| `--nds-grid-delta-bg` / `-neg-bg` / `-fg` | `var(--nds-warning)` / `var(--nds-danger)` / `var(--nds-text-inverse)` | semantic | `.ieDelta` (**the `#fff`**) |
| `--nds-grid-locked-fg` | `var(--nds-text-muted)` | semantic | `.ieLocked` |
| **Overlays** | | | |
| `--nds-grid-skeleton-bg` / `-shine` | `var(--nds-surface-sunken)` / `var(--nds-border-subtle)` | semantic | wsgrid `--nds-grey-100/150` shimmer |
| `--nds-grid-loading-veil` | `color-mix(in srgb, var(--nds-surface) 60%, transparent)` | semantic | AG default overlay |
| `--nds-grid-pinned-shadow` | `var(--nds-shadow-card)` (or `rgb(var(--nds-shadow-rgb) / 0.08)`) | DS shadow channel | the three `rgba(16,24,40,.08)` |

Retired with their consumers: `--nds-wsgrid-*` (10 tokens) once `workspace-grid.css` is deleted (wave 4).
Not tokens (stay as spec numbers in the engine, locked by the conformance test): AG's `−1px` padding rendering
quirk, the `line-height: normal` cell rule, `z-index: 1` on the hovered row.

---

## 5. The GDS spec — outline and open questions

The spec ships as `apps/web/src/design-system/docs/GRID.md` (+ mirrored in factory's `docs/`), one section per bullet
of the brief's §5; each section states numbers, names the token, and links its lab scenario. Below: what each section
will say, and the questions I need decided (**Q1–Q14**, with my recommendation first).

### Q1 — What does "both DS copies" mean for the grid? *(blocks Phase 1)*
Factory has no engine folder, no `workspace-grid.css`, no `tokens-global.css`, stale stylesheets and a broken token
generator. Options: (a) copy the engine + AG dependency into factory and hold both identical; (b) the engine and its
CSS stay **web-only**, the **tokens** (`tokens/grid.ts` and both generated CSS files) are mirrored, and the web
generator is made to write factory's output too; (c) replace the copy with a single source (`packages/design-system`).
**Recommend (b) now, (c) as its own programme.** Factory renders no AG grid; copying a licensed engine into an app with
no consumer is weight with no job. (b) keeps the token contract identical in both apps and unblocks the fork-drift
stylesheet guard (§8.3). (c) is the right end state but is a build-system change the GDS should not smuggle in.

### Q2 — Engine location and name
Today: `design-system/patterns/workspace-grid/engine/` — a subfolder of the pattern it retires. Proposal: `git mv` to
**`design-system/grid/`** (`NexusGrid.tsx`, `theme.ts`, `modules.ts`, `grid.css`, `cells/`, `hosts/`, `filters/`,
`state/`, `lab/` fixtures), the import boundary and the barrel updated in the same commit; `workspace-grid/` keeps only
the legacy `WorkspaceGrid` until wave 4 deletes it. **Recommend yes**, in Phase 2 (13 importers, all under our control).

### Q3 — ONE density vocabulary *(blocks Phase 1 tokens)*
Three exist: engine tiers `xs/sm/md/lg/xl` (text rows 28/34/43/49/59), the page triple `compact/cozy/spacious` (media
rows 52/68/85, headers 28/38/46 = tiers xs/md/lg), and the ads grid's 46/44.5 which is no tier at all.
Proposal: the page-facing prop is **`density: 'compact' | 'cozy' | 'spacious'`** (replacing `size`), and the engine
picks the row height from **row kind**: `rows="text"` (28/43/49) or `rows="media"` (52/68/85, when the identity cell
carries a thumbnail). Header 28/38/46 in both kinds. `sm` and `xl` retire (zero consumers). The ads console migrates
onto **cozy text rows (43)** — a 3px change per row against today's 46, which the AG plan's "pixel parity with the
retiring grid" standard would forbid but the GDS's "parity with `/products/next`" standard requires.
**Recommend this**, and that the 70 `DataGrid` sites passing `xs`/`sm` map to `compact` (28) — measured on the lab
before the wave, with the two DS `DataGrid` paddings (xs 5/9, sm 7/10) retired. Alternative: keep five tiers and add
`ads = 46/44.5` as a sixth number. I do not recommend it: the ads row is a measurement of the old grid, not a design.

### Q4 — Where grid state lives, and auto-restore *(revised under §0b)*
Today `/products/next` persists only **named** views (server) and remembers nothing between visits unless a default
view exists; grid-lens/ads/DataGrid sites auto-persist columns/density/widths to localStorage under 60+ key shapes.
Proposal: one engine hook `useGridState(surface)` that (1) auto-persists the **last-used** `{v, gridState, page}` to
localStorage `nds-grid:<surface>:v1` on every change (debounced), (2) restores it on mount unless a server **default
view** exists (default view wins), and (3) offers named views on the server exactly as `useGridViews` does today.
**No legacy-key adapters** — a rebuilt page starts clean; only server `SavedView` payloads are converted, once, per
surface, when that page is rebuilt. **Recommend auto-restore ON** (every reference product does it; "my columns
reset on every visit" is the complaint a rebuilt page should not ship with). The page keeps only what AG state
cannot hold (accordion open, density, tile, page size) in `page`.

### Q5 — Grid height in hosts
Decision 4 fixes the page: `autoHeight` + pagination + the DS pager, the page scrolls. For **modals and drawers** the
brief allows a bounded grid. Proposal: `host="page" | "modal" | "drawer"` on the engine (or on the `GridCard` host) —
page = autoHeight (no `height`), modal = bounded to `min(rows, cap)` with cap 480 (the editor's number), drawer =
bounded to the drawer body. **Recommend** the host prop lives on the `GridCard`/`GridPanel` host component, not on
`NexusGrid`, so the grid itself never knows where it is. A tab panel is a page host.

### Q6 — Page size choices and the 500 cap
`/products/next` offers 50/100/200/500. Under `autoHeight` AG renders every row of the page (no vertical
virtualisation), so 500 media rows × 12 columns is the most expensive thing the platform draws. **Recommend** keeping
50/100/200/500 as the DS pager's one choice list, default 50, and a lab scenario that **measures** the 500-row page
(paint time, DOM nodes) on both viewports so the number is defended by a measurement rather than a hope.

### Q7 — Checkbox
Three exist: AG's (16px, live on `/products/next`), the DS `DataGrid`'s 15px native, the ads grid's custom 20px
rounded SVG. **Recommend AG's, tokenised** (`checkboxBorderRadius = --nds-grid-radius`, checked = `--nds-grid-accent`,
size 16) — it is what the Owner has approved on screen, and it is the one AG keeps accessible. The ads 20px box retires.

### Q8 — RTL and mobile
**Recommend both explicitly out of scope** for GDS v1: the operator console is desktop, LTR, English. Below 1024px the
grid card scrolls horizontally inside its frame; nothing collapses. Stated in the spec so nobody builds for it by
accident; the lab still renders the 962px scenario because that is a real laptop.

### Q9 — The ads column contract
Decision 1 forbids a compatibility layer over AG's **props**. The 52 ads sites pass `GridColumn[]`
(`key/label/render/align/…`). Proposal: **no adapter component**; each page gains a `columns.tsx` registry projected
to `ColDef[]` exactly as `/products/next` does (`projectColDefs`), with the shared **cell library** (§5 Cell types)
replacing `renderFirst`/`render` bodies. A pure `gridColumnToColDef()` helper may exist as a migration aid inside the
wave, deleted when the wave closes. **Recommend this** — the props contract is what produced the sort bug; a column
projection at the call site is what the reference page already does.

### Q10 — Ad Manager `CampaignsGrid` and the "0 rows locally" problem
It is a data migration with prod-only verification. **Recommend** it goes **last in the ads wave**, behind the 52
`AdsDataGrid` sites, with its legacy keys mapped by the Q4 adapter, and that the wave's parity is proven on prod
against a screenshot + DOM probe taken **before** the swap (the method already in `reference_video_frame_study_method`).

### Q11 — Export formats
CSV (registered) for every grid. Ads reporting hand-rolls an export today. **Recommend CSV only in v1**; `ExcelExportModule`
is one registration away and is a later decision on evidence, not a guess.

### Q12 — Modules not registered today
`MasterDetailModule` (9 `DataGrid` sites use `renderExpanded`; needed for wave 1), `ClipboardModule` is registered
for the editor but copy-from-a-read-grid is universal. `ContextMenuModule` is not registered. **Recommend**
registering MasterDetail in Phase 2 (it is a listed scenario) and Clipboard stays; context menu stays off (the header
menu and the row ⋯ are the product's menus).

### Q13 — Customise: one title, one spelling
DS default `Customise`; the Ad Manager says "Table Customization", `WorkspaceGrid` "Table Customisation"; the app's
user-visible strings are 86 `Customiz*` vs 19 `Customis*`. **Recommend the DS default ("Customise columns…" in the
header menu, "Customise" on the button)** — it is the Owner's spelling in the brief — and a ratchet on the other
spelling in grid chrome.

### Q14 — `DataGrid` tiny tables in drawers/modals
11 of the 71 are ≤10-row tables inside drawers/modals. AG is already in the bundle, so the cost is render-time not
bytes; **recommend they migrate too** (one grid, `host="drawer"|"modal"`, CSRM) so the DS `DataGrid` can be deleted
rather than kept alive for eleven small tables. The 10 key-value tables are **not** grids and get a DS
`DescriptionList` (a DS-GAPS entry; not part of the GDS).

### Q15 — The sheet host (the flat-file editors) *(new under §0b)*
`FlatFileGrid` (3,318 lines) is a full-page spreadsheet: 1000s of rows, frozen columns, grouped headers, smart paste,
row/column reorder, 10 persisted keys. Decision 4 (page grid = `autoHeight` + pagination, the page scrolls) is right
for a **list** and wrong for a **sheet** — nobody pastes 2,000 rows into page 3 of 4. Proposal: a third host,
**`GridSheet`**: viewport-bounded, row-virtualised (AG's normal layout), fills the page below its toolbar, CSRM,
`cellSelection` + fill handle + clipboard + undo/redo, the inventory editor's pending/refused/batch-Apply model, and
the group strip for the flat-file's two-row headers. It is the **only** page-level bounded grid the GDS allows, and
only for `rows="sheet"`. **Recommend yes** — it is the inventory editor's pattern scaled up, and the alternative
(paginated flat files) would be a regression the operators would feel on day one. The existing `amazon-flat-file`
/ `ebay-flat-file` pages are **not edited**; the rebuilt editor is a new surface switched over on your word.

### Q16 — Which page is rebuilt next? *(new under §0b; sets Phase 2's order)*
The cell library (§5) has ~13 types; Phase 2 builds them all, but the **first** page after `/products/next` decides
which get the deepest verification. **Recommend one ads tab with inline edits** (`campaigns/[id]/tabs` — keywords or
targets: bid edit → server → saved/refused per cell, totals row, `enabledFirst`, selection actions, the ONE filter
bar). It exercises the one pattern `/products/next` does not (per-cell server round-trip) on the console you named
first, and its lab fixture already exists (`grid-lab/fixture.ts`). Alternatives: a raw-table list page (orders
`GridLens`, exercises nothing new) or the flat-file sheet (exercises Q15 — the largest single build).

### The spec sections (what each will define — numbers, not adjectives)

- **Tokens** — §4.2, with the derivation table; the conformance test reads them back off the DOM.
- **Density** — Q3's table; `density` prop; `rows` kind; a modal follows its page (`DensityContext` moves into the DS as
  `GridDensityContext`); the toolbar's `SegmentedControl` is the one density control (`GridToolbar right`).
- **Header chrome** — one row at 28/38/46; partitions 2px 30% from the theme; AG sort icon; menu button only on columns
  with a menu (`suppressHeaderMenuButton` for read-only tiny grids); `suppressHeaderFilterButton` engine-wide; the
  column-group strip 30px eyebrow; header checkbox; pinned-left identity; resize on, handle mark width 0.
- **Cell types** (`grid/cells/`, each a memoised renderer + a `ColDef` fragment like `numericColumn`): `text`,
  `numeric` (integer · money via `eur0` cents · percent · delta ± chip), `date` (`formatDate`), `status` (`Pill`),
  `tags` (glyph chips + `InfoTip`), `coverage` (`CoverageSummary`), `identity` (photo · title/SKU · sub-line; SKU-first
  variant; `Thumbnail` lifted into the DS), `actions` (Edit + ⋯ `Menu`, pinned-right variant), `locked` (🔒 + muted),
  `link` (same-tab / new-tab pill), `stock` (out/low/ok), **`nullable`** — the rule: a measured zero renders `0` or the
  muted `—` **with a `title` that says measured**; an unmeasured `null` renders `—` in `--nds-grid-muted-fg` with no
  title; no formatter ever coerces `null` to `0` (a unit test per cell type).
- **Row kinds** — data · child (tint + rail, no indent) · group row (label + count, expander in the cell) · full-width
  footer row (48) · pinned totals (header height) · loading rows (skeleton) · master/detail row; hover/selected/focus
  states; z-order (hovered row above siblings, pinned columns above rows, popups on `document.body`).
- **Selection** — 43px column, AG checkbox, `selectAll:'currentPage'` under SSRM, `isRowSelectable` for group/footer
  rows, one-way (`readSelection(api)`), the toolbar swap contract (`GridToolbar` selection variant with the
  container-query collapse from `styles.module.css`).
- **Toolbar** — `GridToolbar` = count · children (search / selection actions) · right (density · Customise · Views ·
  Export · live pill); the ads console's `toolbarLeft/Right` map onto it.
- **Footer** — the DS pager (`Pagination` + `Listbox`, 10px 14px, top rule) as `GridPager`; the in-card footer strip
  (`GridFooterStrip`: reason/notes/message/actions) for editors.
- **Filtering** — `FilterBar` writes `api.setFilterModel`; the three DS column filters; `unsupported` banner.
- **Sorting** — server under SSRM, `blankSafeComparator` under CSRM; `null` sinks both ways.
- **Tree + grouping** — lazy families, cap 10 + footer, group rows, tree OR groups, `autoGroupColumnDef.cellRenderer`.
- **Editing** — number/text editors, key map, fill/paste, undo/redo, pending overlay + delta, batch Apply, **and** the
  per-cell server round-trip state machine (`idle → editing → saving → saved | refused`) the ads bid/budget cells need.
- **Row models** — SSRM (verbatim request, server owns column-id maps, block 100, `maxBlocksInCache` only with a fixed
  row height) and CSRM (≤ ~2,000 rows; modals; client grouping allowed).
- **State** — Q4; `columnPrefs` bridge; what `page` may hold; the legacy adapter registry.
- **Hosts** — `GridCard` (page), `GridPanel` (modal/drawer), tab panel = page; frame rules; popup parent; stacking
  with DS overlays (`--nds-z-*`).
- **Themes** — tokens; `browserColorScheme` per mode; probe both themes; the `.h10-shell` light pin.
- **Accessibility** — AG ARIA kept; documented keyboard map; a live region for bulk counts; AA on every state; never
  `cursor: help`.
- **Locale & formatting** — `localeText` in one file; numbers/dates only through `design-system/lib`.
- **Performance** — curated modules; stable identities (guard); memoised renderers; the 500-row measurement.
- **Empty / loading / error** — one `GridEmpty` (message + CTA slot), skeleton overlay, failed-block banner + retry.

---

## 6. Phase plan (each proposed before it is built; nothing committed until you say so)

### Phase 1 — DONE 2026-08-28 (local, uncommitted) — see `CHANGELOG.md [GDS-1]`

Delivered: `tokens/grid.ts` (69 `--nds-grid-*`, identical in both apps) → generated `tokens*.css`
(311 + 91 dark); `theme.ts` bound to grid tokens only, locked by 27 assertions that read the emitted
css; `ag-grid.css` and the two live grids read every number and editing colour from the table.
**Measured identical** before/after on 17 properties across `/products/next` and the editor; one
intended fix (spanning-cell partition 22.8 → 13.8). Dark mode verified on the grid with the shell pin
lifted. Build exit 0; 94 test files / 1088 tests; every pre-push guard green.

What Phase 1 taught, for Phase 2: (1) AG's Theming API accepts `var()` and `calc()` strings for
lengths, weights and colours — the whole theme can be token-bound; (2) "derives from a semantic
token" is not dark-aware by itself — an alias must be re-declared in `.dark` AND pinned in
`.h10-shell` (two guards enforce it; both fired); (3) factory's token CSS was hand-edited ahead of
its generator — converged, generator-owned again.

### Phase 2 — DONE 2026-08-29 (local, uncommitted) — see `CHANGELOG.md [GDS-2]`

Delivered exactly the §0c layout under `design-system/grid/` (24 files: engine, theme, 15 renderers +
2 overlays, 13 column presets, 3 editors + the round-trip state machine, 4 toolbar pieces, 2 hosts,
`useGridState`, density context), `Thumbnail` in the DS (both apps), `AgWorkspaceGrid` deleted, the lab
on `NexusGrid`, `/products/next` + the editor rebuilt on the library with **zero measured change**
(17 properties, both grids, before/after each step) and the four guards §8.4–8.7 wired into pre-push
(baselines: DataGrid 71 · grid-lens 60 · AdsDataGrid 56 · WorkspaceGrid 4 · TanStack 17 · raw `<table>`
194 — the ratchet's own counting, which differs from the audit's grep by method). Full web suite 97 files /
1116 tests; every guard green.

Learned: the cell library must not share the retiring `DataGrid`'s `.nds-grid-*` namespace (it is
`.nds-cell-*`); AG's `ColDefField<T>` cannot be instantiated through a generic preset (TS2589 — the
preset takes a path string); BSD `sed -E` has no `\b`.

### Phase 3 — DONE 2026-08-29 (local, uncommitted) — see `CHANGELOG.md [GDS-3]`

`/design/grid-lab?tab=gds` (16 grids + 5 statements, outside the shell, `window.__gdsProbe()`),
`design-system/grid/spec.json`, `scripts/check-grid-chrome.mjs` (Playwright; **12 probes green**), `GRID.md`,
the `/design-system` Grid section. The runner found two engine rules that were missing and they are now the
engine's: totals row = header height; rows re-measure on a density change.

**Next — the first rebuilt page (Q16):** an ads tab with inline bid edits, built from `GRID.md` and the lab's
`#roundtrip` + `#reporting` scenarios. Proposed as its own file list before it is built.

## 7. Migration map — read as the REBUILD BACKLOG (§0b)

Under the rebuild framing "order" is a recommendation, not a sequence; "state today → GDS state" tells you what stops
being read when the page is rebuilt clean (only server views are converted); "retired when" is what can be deleted
once the last page of a family is rebuilt.

| Surface | Order | Effort | State today → GDS state | Shared pieces that replace local ones | Retired when | Guard that stops a new fork |
|---|---|---|---|---|---|---|
| `/products/next` + editor | done (0) | — | server views + `page`; editor `hidden-columns` list | already on the engine; adopts `useGridState`, `GridPager`, `GridFooterStrip`, DS `Thumbnail` in Phase 2 | — | §8.4, §8.5 |
| DS `DataGrid` ×71 | 1 | M | `area.page.columns` (`string[]`) ×6 + 3 hand-rolled keys + 1 expansion-state key → `nds-grid:<surface>:v1` via adapter | `GridCard`/`GridPanel`, cells, `GridToolbar`, `GridPager`, `GridEmpty`, DS `PreferencesModal` | `DataGrid.tsx` + `.nds-grid*` deleted at the end of wave 1 | §8.7 importer ratchet (71 → 0) |
| grid-lens ×65 | 2 | L | 8-key family per namespace (+ per-marketplace), `nexus-replenishment-*`, `_density/_pageSize/_columnWidths` in server views → adapter; `columnWidths` → `columnState.width` | `GridToolbar` + `SegmentedControl` (density) + `Listbox` (auto-refresh), `Thumbnail` (DS), `MetricStrip` for `KpiStrip`, DS `PreferencesModal`, `BulkActionBar` | kit folder deleted at the end of wave 2 | §8.7 (65 → 0); §8.8 storage-key guard |
| `AdsDataGrid` ×57 + Ad Manager | 3 | XL | `GridPrefs {visible, stickyFirst, stickyLast}` under 48 keys in 4 conventions; `filterPresetsKey`; Ad Manager's 6 bespoke keys → adapter | cells (`identity` with A/M/SP/SD badges as `Tag`s, `status`, `numeric`, `actions` pinned-right), `GridToolbar`, `GridPager`, one `FilterBar`, per-cell round-trip editing | `WorkspaceGrid`, `AgWorkspaceGrid`, `workspace-grid.css`, 74 `.h10-am-*` rules, `--nds-wsgrid-*`, the shim — all deleted at the end of wave 3 | §8.4 (no `.ag-`/`nds-ag-` outside the engine), §8.7 (57 → 0) |
| `WorkspaceGrid` ×2 | with 3 | — | — | — | with wave 3 | — |
| Raw tables ×168 (of 200) | 4 | XL | 20 bespoke localStorage sites + `useColumnResize` → adapter or dropped (widths are AG state) | everything above; column groups for the 47 matrices | `components/ui/DataTable.tsx`, `useColumnResize`, `@tanstack/react-table` removed | §8.7 (`<table` 200 → 36 non-grids, frozen) |
| Flat-file editors (`FlatFileGrid` 3,318 lines; `/products/amazon-flat-file`, `/products/ebay-flat-file`) | 5 (after Q15's `GridSheet` exists) | XL | own 10-key `${storageKey}-*` scheme → `useGridState`; API routes **unchanged** | `GridSheet`, editing cells, group strip, `GridFooterStrip` | old pages deleted only on the Owner's switch-over word | the untouchable rule: the rebuild is a NEW surface beside the old |
| Out of scope (36 non-grids + 2 heatmaps) | — | — | — | `DescriptionList` (DS gap), form layout | never by the GDS | listed in the ratchet baseline as exempt |

---

## 8. Guards (added in Phase 2–3, all in `.githooks/pre-push`; every ratchet reads from a staged private index, not `git ls-files`)

1. **Theme params test** (extend `theme.vitest.test.ts`) — `_getParamsCss()` must contain every `--nds-grid-*` token
   the spec lists, and no `--nds-grey-*`/`--nds-blue-*`/`--nds-white` binding at all (the ramp is banned from the theme).
2. **Grid chrome conformance** — `scripts/check-grid-chrome.mjs`: Playwright (already a devDependency) opens
   `/design/grid-lab?tab=gds` against `:3000`, calls `window.__gdsProbe()` and asserts the measured row/header/strip
   heights per tier, partition width, header/body/hover/selected colours, checkbox size, select column width, in
   light and dark, at 962×… and 1440×…, against `grid/spec.json` (the same numbers `GRID.md` prints). It needs a
   server, so it runs as `npm run grid:conformance` — **required before any grid PR is shown** and in the pre-push
   only when `:3000` answers (skips with a loud line otherwise, never a silent pass).
3. **Fork drift, stylesheets** — extend `check-ds-fork-drift.mjs`: for the four already-differing stylesheets, freeze
   the **diff** (`diff web factory | md5`) in the baseline; a push may shrink the diff, never change it. For
   `tokens*.css` the generator writes both, so they leave the frozen set in Phase 1.
4. **CSS + class boundary** — extend `check-ag-grid-import-boundary.mjs` with a stylesheet pass: no `.ag-` selector
   and no `.nds-ag-`/`.nds-grid-` **definition** outside `design-system/grid/`; the existing import rule kept;
   `app/design/grid-lab/` stays exempt for imports only.
5. **Memoisation guard** — `scripts/check-grid-option-identity.mjs` (TypeScript AST, like the button-vocabulary
   guard): on every `<NexusGrid` JSX element, an inline object literal or arrow function for any prop in
   `{rowSelection, selectionColumnDef, cellSelection, defaultColDef, autoGroupColumnDef, localeText, columnDialog,
   getRowHeight, getRowId, isRowSelectable, serverSideDatasource, on*}` fails. Baseline 0 — the inventory editor's
   five inline handlers are fixed in Phase 2.
6. **DS-GAPS append-only** — `scripts/check-ds-gaps-append-only.mjs`: the file's line count and its `##` heading set
   may only grow; a line removed fails.
7. **Migration ratchet** — `scripts/check-grid-kit-ratchet.mjs`: counts importers of `components/DataGrid`,
   `_shared/grid-lens`, `_grid/AdsDataGrid`, `patterns/workspace-grid/WorkspaceGrid`, `@tanstack/react-table`, and
   files with a real `<table` (JSX, not prose) — each may only go **down** from its baseline (71 / 65 / 57 / 2 / 4 / 200);
   the 36 non-grid tables are listed exempt so they are not "migrated" to make a number move.
8. **Storage-key guard** — no `localStorage.setItem` whose key matches `/(columns|cols|density|widths|views)/i`
   outside `design-system/grid/state/`; baseline = today's count, ratchets down as adapters replace sites.
9. **Null-rendering tests** — every cell renderer ships a test that `null` and `0` render differently.
10. **Density vocabulary** — a grep ratchet: `size="xs|sm|md|lg|xl"` on a grid and the strings `cosy`/`comfortable`
    outside the legacy adapters, baseline frozen, ratchets to 0 with wave 2.

---

## 9. Definition of done (restated with the numbers)

- One grid component (`design-system/grid/NexusGrid`), one theme, **one token set (§4.2, ~55 tokens)**, one Customise
  dialog, one density vocabulary; a lab tab with all **30 §6 scenarios** rendered and measured; `GRID.md` complete.
- `apps/web` and `apps/factory` carry identical `tokens/*.ts` and generated `tokens*.css`; the stylesheet diff is
  frozen and shrinking; every pre-push guard green from a staged private index.
- `/products/next` and the editor: header colour, row/header/strip heights, partition, thumbnail, hover and selected
  identical before and after Phases 1–2 (probe numbers recorded in the phase's CHANGELOG entry).
- Importer counts `DataGrid` 71 → 0, grid-lens 65 → 0, `AdsDataGrid` 57 → 0, `WorkspaceGrid` 2 → 0, TanStack 4 → 0,
  raw `<table` 200 → 36 (all non-grids, exempt) — by the end of wave 4.
- Nothing committed until you say so; each phase and sub-wave proposed before it is built.

---

## 10. Sequencing, risks, and what I need from you

**Sequencing.** The batch is committed (`2b0e43fc4`) — Phase 1 works from that baseline. Phase 0 changed no file
but this document.

**Risks carried forward from the AG plan, still true:** page stylesheets beat DS primitives (`ads.css`/`amazon.css`
selectors will fight AG cells in wave 3 — probe a real control bay); ~20 pre-push gates; bundle size on a 330-route
app (AG is paid once; MasterDetail adds a module); the ads console is unverifiable locally; every wave with
localStorage state is a **data migration** (Q4's adapters are the answer, tested against captured real key sets).

**New risks found in Phase 0:** the theme's dark-mode claim is false today (Phase 1 fixes it; the `/products/next`
`.dark` inertness is a separate load-order defect and is **not** in scope); `autoHeight` renders every row of the
page, so the 500-row page is the platform's most expensive paint (Q6 measures it); the grid-lens `stickyFirstColumn`
default is `true` when **absent** (an adapter that reads "absent → false" silently un-pins 20 workspaces).

**Decisions needed (recommendation in §5):** Q1 factory scope · Q2 engine location · Q3 density vocabulary ·
Q4 auto-restore (no adapters) · Q5 host height rule · Q6 page-size cap · Q7 checkbox · Q8 RTL/mobile out · Q9 no ads
column adapter · Q10 Ad Manager last · Q11 CSV only · Q12 MasterDetail on, context menu off · Q13 "Customise" ·
Q14 tiny tables rebuild too · **Q15 the `GridSheet` host for flat files · Q16 which page is rebuilt next.**
**Q1 and Q3 block Phase 1; Q16 orders Phase 2.** → **All sixteen DECIDED per recommendation on 2026-08-28 (§0c).**

---

## Appendix A — per-file inventories (the §8.7 ratchet baselines are derived from these lists)

Paths are under `apps/web/src/`. Feature detection was file-scoped, so a file hosting two grids can carry an attribute
of the other one (marked ⚠ where confirmed). `money` over-matches template literals — read it as "probable".

### A.1 DS `DataGrid` — 71 importers

Legend: host · rows (client/server, scale) · features · storage · cells · `—` = renders null distinctly from 0.

**Fleet (5)**
| File | Route | Host | Rows | Features | Storage | Cells | `—` |
|---|---|---|---|---|---|---|---|
| `app/fleet/activity/ActivityClient.tsx` | `/fleet/activity` | drawer + card | server, med | initialSort, expand, customise, density, paging | `fleet.activity.columns` | pill, link, money, pct | yes |
| `app/fleet/assignments/AssignmentsClient.tsx` | `/fleet/assignments` | card | server, med | controlled sort, gated select, maxHeight, empty | URL | pill, actions, link, money | no |
| `app/fleet/map/EntityListView.tsx` | `/fleet/map` | inline | client, small | initialSort, rowClassName, empty | — | money | no |
| `app/fleet/map/ListView.tsx` | `/fleet/map` | inline | client, small | sort, customise, rowClassName, empty, paging | `fleet.map.list.columns` | link, money | yes |
| `app/fleet/workers/WorkersClient.tsx` | `/fleet/workers` | inline | server, small | sort, gated select, expand, density, empty | hand-rolled `COLS_KEY` | link, locked, money | yes |

**Fulfilment / stock (6)**
| File | Route | Host | Rows | Features | Storage | Cells | `—` |
|---|---|---|---|---|---|---|---|
| `app/fulfillment/stock/import/ImportClient.tsx` | `/fulfillment/stock/import` | modal + tab + card | server, med | sort, maxHeight, density, paging, CSV | `MAPPING_STORE_KEY`; session `WIZARD_SESSION_KEY` | pill, tag, money | yes |
| `app/fulfillment/stock/locations/LocationsClient.tsx` | `/fulfillment/stock/locations` | modal + card | server, med | sort, customise, density, empty | `stock.locations.columns` | pill, tag, money | yes |
| `app/fulfillment/stock/sync-control/SyncControlClient.tsx` | `/fulfillment/stock/sync-control` | inline | server, **large** | gated select, density, empty, `Pagination` | URL | pill, link, money, pct | yes |
| `app/fulfillment/stock/sync-control/SyncProductsGrid.tsx` | same | inline | server, **large** | gated select, expand, density, empty, paging | URL | **thumbnail**, pill, link, money, pct | yes |
| `app/fulfillment/stock/sync-control/history/HistoryClient.tsx` | `…/history` | inline | server, med | customise, empty, paging | `stock.syncControl.history.columns` | money | no |
| `app/fulfillment/stock/sync-control/product/[masterId]/ProductDetailClient.tsx` | `…/product/[masterId]` | inline | server, small | gated select, density, empty, paging | URL | **thumbnail**, pill, link, money | yes |

**Ads console `app/marketing/ads-console/` (17)**
| File | Host | Rows | Features | Cells | `—` |
|---|---|---|---|---|---|
| `automation/AnalyticsTab.tsx` | inline | server, med | density, empty, CSV | money | yes |
| `automation/BudgetPacingTab.tsx` | inline | server, med | density, empty | money, pct | yes |
| `automation/HarvestTab.tsx` | inline | server, med | density, empty, CSV | link, money | no |
| `automation/HealthTab.tsx` | inline | server, med | density, empty | money | yes |
| `automation/NegativeMiningTab.tsx` | inline | server, med | gated select, rowClassName, density, CSV | link, money | no |
| `automation/RankConquestMode.tsx` | inline | server, med | density, empty | link, money | yes |
| `automation/RankKeywordsMode.tsx` | inline | server, med | select, density, empty | link, money, pct | yes |
| `automation/RankPlacementCockpit.tsx` | card | server, med | expand, **totals**, rowClassName, density; storage `rc3kwdis:${campaignId}:${market}` (expansion state) | link, locked, money, pct | yes |
| `automation/RankStrategyMode.tsx` | inline | server, med | select, density, empty | link, money, pct | yes |
| `automation/RankTosMode.tsx` | inline | server, med | density, empty | link, money, pct | yes |
| `automation/RetailTab.tsx` | inline | server, med | rowClassName, density, empty | money | no |
| `automation/SovTab.tsx` | inline | server, med | density, empty, CSV | money, pct | no |
| `bulk/BulkOpsClient.tsx` | tab + card | server, med | density, empty, URL, CSV | link, money | yes |
| `campaigns/CampaignsTable.tsx` | tab + card | server, **large** | controlled sort, gated select, `getSubRows` **+** `renderExpanded`, rowClassName, density, paging, CSV; hand-rolled `STORAGE_KEY` | pill, **actions menu**, link, locked, money, pct | yes |
| `products/ProductsTable.tsx` | card | server, **large** | controlled sort, gated select, `getSubRows` + `renderExpanded`, rowClassName, density, paging, CSV | **thumbnail**, link, money, pct | yes |
| `rank/KeywordBidStation.tsx` | inline | server, med | select, expand, maxHeight, rowClassName, density | money, pct | yes |
| `targeting/TargetingClient.tsx` | tab | server, med | initialSort, density, empty, URL | pill, money, pct | yes |

**Ads main `app/marketing/ads/` (40)**
| File | Host | Rows | Features | Cells | `—` |
|---|---|---|---|---|---|
| `ai-advertising/new-goal/AiGoalBuilder.tsx` | modal ⚠ | server, small | select, density | thumb, tag, money | yes |
| `analytics/ConflictsTab.tsx` | inline | server, med | rowClassName, density, URL | money, pct | yes |
| `analytics/CoverageClient.tsx` | tab | server, med | initialSort, density, URL, paging | money, pct | yes |
| `budget-manager/BudgetPoolsDrawer.tsx` | **drawer** | server, small | expand, maxHeight, density | money | yes |
| `bulk/BulkClient.tsx` | tab + card | server, med | rowClassName, density, URL | money | yes |
| `campaign-builder/LaunchReceipt.tsx` | inline | client, small | expand, density | pill, money | no |
| `campaign-builder/replicate/LaunchStep.tsx` | modal | client, small | **totals**, density | locked, money, pct | yes |
| `campaign-builder/replicate/ReviewStep.tsx` | inline | client, small | **totals**, rowClassName, density | locked, money, pct | yes |
| `campaign-builder/replicate/ReviewTable.tsx` | inline | client, small | controlled sort, select, rowClassName, density | money | yes |
| `dashboard/ProfitPanel.tsx` | card | server, small | maxHeight, density | link, money, pct | yes |
| `ebay/_modals/ImportCsvModal.tsx` | modal | client, small | maxHeight, density | pill, pct | no |
| `ebay/automation/modals/WhyModal.tsx` | modal | client, small | density | pill, link, money | yes |
| `ebay/campaigns/[id]/tabs/AutomationTab.tsx` | card | server, small | density | pill, link, money, pct | no |
| `ebay/campaigns/[id]/tabs/CriterionCard.tsx` | inline | client, small | density | pill, money | no |
| `ebay/campaigns/new/_wizard/steps/KeywordsStep.tsx` | tab | client, small | maxHeight, rowClassName, density | pill, money | no |
| `ebay/campaigns/new/_wizard/steps/RatesStep.tsx` | card | client, small | maxHeight, density | pill, money, pct | yes |
| `ebay/campaigns/new/_wizard/steps/ReviewStep.tsx` | card | client, small | maxHeight, density | pill, locked, money, pct | yes |
| `ebay/digest/EbayDigestClient.tsx` | card | server, small | density | link, money, pct | no |
| `health/ProbePanel.tsx` | card | server, small | `renderExpanded`, `rowProps`, rowClassName, density | link, money | yes |
| `portfolios/PortfoliosClient.tsx` | modal | server, small | `rowProps` (**drag-drop rows**), density, empty | link, money, pct | yes |
| `portfolios/[id]/FamilyCockpitClient.tsx` | tab + card | server, med | `rowProps`, rowClassName, density | link, money, pct | yes |
| `reporting/BusinessContextPanel.tsx` | card | client, small | density | money, pct | no |
| `reporting/IncrementalityPanel.tsx` | card | server, med | expand, maxHeight, density, empty, URL, CSV | money, pct | yes |
| `rules-automation/_shared/TabRules.tsx` | inline | server, med | density | link, money | yes |
| `rules-automation/automations/LedgerView.tsx` | inline | server, med | rowClassName, density, URL | money | yes |
| `rules-automation/automations/LimitsView.tsx` | inline | server, med | rowClassName, density | link, money | yes |
| `rules-automation/bid/BidActivity.tsx` | inline | server, med | rowClassName, density, URL | link, money | yes |
| `rules-automation/bid/BidBounds.tsx` | card | server, med | rowClassName, density | money | yes |
| `rules-automation/bid/BidTargetDrawer.tsx` | **drawer** | server, small | rowClassName, density, URL | link, locked, money | yes |
| `rules-automation/control-room/ActivityTab.tsx` | inline | server, med | rowClassName, density | link, locked, money | yes |
| `rules-automation/control-room/GuardrailGrid.tsx` | inline | server, med | select ⚠, rowClassName, density, URL | money | yes |
| `rules-automation/control-room/LeverDrawer.tsx` | **drawer** | server, small | rowClassName, density | money | yes |
| `rules-automation/dayparting/Next24Preview.tsx` | inline | client, small | rowClassName, density | money | yes |
| `rules-automation/fleet/FleetTab.tsx` | card | server, med | expand, density | money | yes |
| `rules-automation/fleet/worker/[key]/CharterStudio.tsx` | inline | server, small | expand, density | locked, money | no |
| `rules-automation/fleet/worker/[key]/WorkerClient.tsx` | card | server, med | expand, density | link, money | yes |
| `rules-automation/keyword-harvest/HvCohort.tsx` ⚠ | inline | server, med | select ⚠, rowClassName, density (its `storageKey="nexus.hv.cohortcols"` belongs to the sibling `AdsDataGrid`) | money | yes |
| `rules-automation/keyword-tracker/BidAction.tsx` | card | server, small | density, URL | locked, money | yes |
| `rules-automation/keyword-tracker/TermDrawer.tsx` | **drawer** | server, med | expand, density, URL, paging | money, pct | yes |
| `rules-automation/placement/PlcBulkPanel.tsx` | card | server, med | density, URL | link, locked, money, pct | yes |

**Other (2)**
| File | Route | Host | Rows | Features | Storage | Cells | `—` |
|---|---|---|---|---|---|---|---|
| `app/pricing/volume-pricing/VolumePricingClient.tsx` | `/pricing/volume-pricing` | modal + card | server, med | initialSort, customise, maxHeight, density, empty | `pricing.volume.columns` | pill, tag, money, pct | yes |
| `app/products/ebay-flat-file/EbayImportWizard.tsx` | `/products/ebay-flat-file` | modal | server, large | maxHeight, density, empty, CSV | — | tag, locked, money, pct | yes |

Excluded (lab/catalog): `app/design/grid-lab/GridLabClient.tsx`, `design-system/catalog/TokenCatalog.tsx`.
Cross-cutting: `size` passed by 70/71 · `—` for null by 55/71 (16 do not) · `customizable` by 6 · 3 hand-rolled storage
keys · controlled sort by 4 · `getSubRows` by 2 (both also `renderExpanded`) · `rowProps` by 3 · `headerProps`/`cellProps` by 0.

### A.2 `grid-lens` — 65 importers; the kit

**Kit** (`app/_shared/grid-lens/`, 22 files, 5,112 lines, all Tailwind): `VirtualizedGrid.tsx` 1049 (engine; also
exports `SearchContext`, `RiskFlaggedContext`, `DensityContext`, `ColumnResizeHandle`) · `FilterPopover.tsx` 675 ·
`PreferencesModal.tsx` 416 (**the fork**) · `Thumbnail.tsx` 396 · `ActionCluster.tsx` 393 · `SavedViewsButton.tsx` 248 ·
`AnchoredPopover.tsx` 210 · `MatrixSortPanel.tsx` 206 · `ColumnPicker.tsx` 195 · `SortStack.tsx` 174 ·
`ProductIdentityCell.tsx` 170 · `StockSplit.tsx` 155 · `GridToolbar.tsx` 130 · `KeyboardShortcutsModal.tsx` 117 ·
`GridFooter.tsx` 114 · `KpiStrip.tsx` 113 · `BulkActionShell.tsx` 106 · `LensTabs.tsx` 62 · `AutoRefreshSelect.tsx` 54 ·
`DensityToggle.tsx` 52 · `types.ts` 25 · `index.ts` 52.

**Keys.** Written by the kit: `${storageKey}.columnWidths` (`Record<key,px>`, `VirtualizedGrid:282-298`). Host-written
family: `<ns>.visibleColumns` (`string[]`, order = column order; `orders.visibleColumns.v2`) · `<ns>.density`
(`compact|cosy|comfortable`) · `<ns>.stickyFirstColumn`/`.stickyLastColumn` (`"true"/"false"`, **absent = true**) ·
`<ns>.filterOrder` · `<ns>.autoRefreshMin` · `<ns>.lensTabOrder`, `<ns>.nameDisplay` (products). Divergent:
`nexus-replenishment-{columns,pageSize,density,autorefresh,uplift,sales-tf,recbasis}`; `stock.columns` (validated
`.every()`); `stock.savedViews` + `.bootstrapped` (one-shot → server); `matrix-order:${id}`, `matrix-sort:${id}`;
`ListingsWorkspace` namespaces per marketplace (`amazon-it.*`, `ebay-de.*`); server views carry `_density`,
`_pageSize`, `_columnWidths`.

**Importers**
| File (lines) | Kit pieces | Table | Host | Scale | Keys |
|---|---|---|---|---|---|
| `app/products/ProductsWorkspace.tsx` (2753) | AutoRefresh, AnchoredPopover, DensityToggle, GridToolbar, KpiStrip, Shortcuts, FilterPopover, **PreferencesModal fork** | VG (via GridView) | page card | 10k+ | `products.*` (9 keys) |
| `app/products/_components/GridView.tsx` (1876) | VirtualizedGrid, SearchContext, RiskFlaggedContext, ProductIdentityCell, StockSplit, Thumbnail, ActionCluster | VG `products` | page card | 10k+ | inherits |
| `app/products/_components/SavedViewsButton.tsx` (9) | re-export shim | — | — | — | — |
| `app/products/_shared/flat-file-shortcuts.ts` (64) | `ShortcutGroup` type | — | — | — | — |
| `app/products/[id]/edit/tabs/MatrixTab.tsx` (2076) | MatrixSortPanel | raw | tab | 100s | `matrix-*:${id}` |
| `app/products/next/ProductsNextClient.tsx` (1065) | `DensityContext` | **AG** | page card | 10k+ | AG |
| `app/products/next/InventoryGrid.tsx` (294) | Thumbnail, DensityContext | **AG** | modal | 10s | — |
| `app/products/next/columns.tsx` (451) | Thumbnail | **AG** | — | — | — |
| `app/products/next/density.ts` (55) | `Density` type | — | — | — | — |
| `app/fulfillment/stock/StockWorkspace.tsx` (4301) | VG, GridFooter, ProductIdentityCell, StockSplit, DensityToggle, AutoRefresh, BulkActionShell, Shortcuts, FilterPopover, GridToolbar, **fork**, ActionCluster | VG `stock` + raw | page card | 10k+ | `stock.*`, `nexus-stock-autorefresh` |
| `app/fulfillment/stock/analytics/AnalyticsClient.tsx` (991) | DensityToggle, GridToolbar, VG, GridFooter | VG ×2 | card + section | 1k | `stock-analytics.*`, `stock-analytics-eoq.*` |
| `app/fulfillment/stock/channel-drift/ChannelDriftClient.tsx` (457) | + AutoRefresh | VG | page card | 1k | `stock-channel-drift.*` |
| `app/fulfillment/stock/lots/LotsClient.tsx` (280) | AutoRefresh, DensityToggle, GridToolbar, VG, GridFooter | VG | page card | 100s | `stock-lots.*` |
| `app/fulfillment/stock/mcf/MCFClient.tsx` (364) | same 5 | VG | page card | 100s | `stock-mcf.*` |
| `app/fulfillment/stock/reservations/ReservationsClient.tsx` (338) | same 5 | VG | page card | 100s | `stock-reservations.*` |
| `app/fulfillment/stock/shopify-locations/ShopifyLocationsClient.tsx` (285) | same 5 | VG | page card | 10s | `stock-shopify-locations.*` |
| `app/fulfillment/stock/stockouts/StockoutsClient.tsx` (475) | same 5 | VG | page card | 1k | `stock-stockouts.*` |
| `app/fulfillment/stock/transfers/TransfersClient.tsx` (286) | same 5 | VG | page card | 100s | `stock-transfers.*` |
| `app/fulfillment/stock/control-tower/ControlTowerClient.tsx` (1060) | AutoRefresh, DensityToggle, GridToolbar | raw | page card | 1k | `inventory-control-tower.*` |
| `app/fulfillment/stock/cycle-count/CycleCountListClient.tsx` (447) | AutoRefresh, GridToolbar | list | page card | 100s | — |
| `app/fulfillment/stock/fba-pan-eu/FbaPanEuClient.tsx` (365) | AutoRefresh, GridToolbar | cards | page card | 10s | — |
| `app/fulfillment/stock/recalls/RecallsClient.tsx` (415) | AutoRefresh, GridToolbar | list | page card | 10s | — |
| `app/fulfillment/stock/sync-control/SyncProductsGrid.tsx` (552) | Thumbnail, DensityContext | DS DataGrid | page card | 1k | — |
| `app/fulfillment/stock/sync-control/product/[masterId]/ProductDetailClient.tsx` (531) | Thumbnail, DensityContext | DS DataGrid + raw | detail | 10s | — |
| `app/fulfillment/replenishment/ReplenishmentWorkspace.tsx` (1915) | VG, GridFooter, ProductIdentityCell, StockSplit, DensityToggle, AutoRefresh, GridToolbar, BulkActionShell, SortStack, Shortcuts, FilterPopover, **fork**, ActionCluster | VG | page card | 10k | `nexus-replenishment-*`, `replenishment.*` |
| `app/fulfillment/inbound/InboundWorkspace.tsx` (3518) | AutoRefresh, DensityToggle, GridToolbar, Shortcuts | raw | card + tabs | 1k | `inbound.*` |
| `app/fulfillment/returns/ReturnsWorkspace.tsx` (2826) | + KpiStrip | raw | page card | 1k | `returns.*` |
| `app/fulfillment/outbound/PendingShipmentsClient.tsx` (1890) | AutoRefresh, DensityToggle, GridToolbar, Shortcuts | raw | page card | 1k | `outbound-pending.*` |
| `app/fulfillment/outbound/ShipmentsClient.tsx` (982) | same 4 | raw | page card | 1k | `outbound-shipments.*` |
| `app/fulfillment/purchase-orders/PurchaseOrdersClient.tsx` (2108) | ActionCluster, AutoRefresh, DensityToggle, GridToolbar, **fork** | raw | page card | 100s | `po.spend.collapsed` |
| `app/fulfillment/routing-rules/RoutingRulesClient.tsx` (631) | AutoRefresh, GridToolbar | raw | page card | 10s | — |
| `app/listings/ListingsWorkspace.tsx` (6588) | VG + SearchContext, GridFooter, ProductIdentityCell, StockSplit, DensityToggle, AutoRefresh, GridToolbar, KpiStrip, BulkActionShell, Shortcuts, LensTabs, FilterPopover, **fork**, ActionCluster | VG + raw | page card | 10k+ | `${storageKey}.*` per channel-market + `listings.filterOrder` |
| `app/listings/ebay/campaigns/EbayCampaignsClient.tsx` (526) | DensityToggle, GridToolbar, VG, GridFooter | VG | page card | 100s | `ebay-campaigns.*` |
| `app/listings/ebay/markdowns/EbayMarkdownsClient.tsx` (576) | same 4 | VG | page card | 100s | `ebay-markdowns.*` |
| `app/listings/ebay/gaps/EbayGapsClient.tsx` (375) | AutoRefresh, GridToolbar | raw | page card | 100s | — |
| `app/pricing/PricingMatrixClient.tsx` (1901) | AutoRefresh, DensityToggle, FilterPopover, GridToolbar, Shortcuts, KpiStrip, **fork**, ProductIdentityCell, VG | VG `pricing-matrix` + raw | page card | 10k | `pricing.*` |
| `app/pricing/alerts/PricingAlertsClient.tsx` (587) | AutoRefresh, GridToolbar | raw | page card | 100s | — |
| `app/pricing/buybox/BuyBoxClient.tsx` (367) | AutoRefresh, GridToolbar | raw | page card | 100s | — |
| `app/orders/OrdersWorkspace.tsx` (1155) | AutoRefresh, DensityToggle, FilterPopover, Shortcuts | delegates | card + tabs | 10k | `orders.*` (`visibleColumns.v2`) |
| `app/customers/CustomersWorkspace.tsx` (556) | AutoRefresh, DensityToggle, GridToolbar, Shortcuts | raw | page card | 1k | `customers.*` |
| `app/customers/risk-queue/RiskQueueClient.tsx` (314) | AutoRefresh, GridToolbar | raw | page card | 100s | — |
| `app/catalog/matrix/MatrixClient.tsx` (1409) | MatrixSortPanel | custom matrix | page card | 1k | — |
| `app/catalog/organize/OrganizeClient.tsx` (2467) | AutoRefresh, GridToolbar | raw | card + tree | 1k | — |
| `app/marketing/analytics/AnalyticsClient.tsx` (147) | KpiStrip | raw | page card | 10s | — |
| `app/marketing/campaigns/MarketingCampaignsClient.tsx` (464) | KpiStrip, LensTabs | raw | page card | 100s | — |
| `app/marketing/aplus/AplusListClient.tsx` (427) | AutoRefresh, GridToolbar | raw | page card | 100s | — |
| `app/marketing/automation/AutomationListClient.tsx` (819) | AutoRefresh, GridToolbar | cards | page card | 100s | — |
| `app/marketing/brand-story/BrandStoryListClient.tsx` (443) | AutoRefresh, GridToolbar | raw | page card | 100s | — |
| `app/bulk-operations/exports/ExportsClient.tsx` (414) | AutoRefresh, GridToolbar | raw | page card | 100s | — |
| `app/bulk-operations/history/HistoryClient.tsx` (878) | AutoRefresh, GridToolbar | raw | page card | 1k | `nexus_bulkops_column_widths` |
| `app/bulk-operations/imports/ImportsClient.tsx` (752) | AutoRefresh, GridToolbar | raw | page card | 100s | — |
| `app/bulk-operations/schedules/SchedulesClient.tsx` (412) | AutoRefresh, GridToolbar | raw | page card | 10s | — |
| `app/sync-logs/outbound-queue/OutboundQueueClient.tsx` (890) | AutoRefresh, DensityToggle, GridToolbar, Shortcuts | raw | page card | 10k | `outbound-queue.*` |
| `app/sync-logs/alerts/*.tsx` (625) · `api-calls` (1038) · `errors` (472) · `events` (236) · `webhooks` (664) | AutoRefresh, GridToolbar | raw (api-calls, webhooks) / list | page card | 1k–10k | — |
| `app/audit-log/AuditLogClient.tsx` (710) | AutoRefreshSelect | list | page card | 10k | — |
| `app/inbox/InboxClient.tsx` (426) | AutoRefresh, GridToolbar | list | page card | 1k | — |
| `app/dashboard/health/ChannelStockEventPanel.tsx` (216) · `CronStatusPanel.tsx` (271) · `StockDriftPanel.tsx` (373) | AutoRefreshSelect | raw | dashboard panel | 10s–100s | — |
| `components/dashboard/GlobalSnapshot.tsx` (1447) | AnchoredPopover | raw | dashboard panel | 100s | `nexus.snapshot.baseCurrency.v1` |
| `components/flat-file/FlatFileGrid.tsx` (3318) | KeyboardShortcutsModal | raw (own engine, **untouchable**) | full-page editor | 10k | own 10-key `${storageKey}-*` scheme |

Fork users (6): `ProductsWorkspace`, `ListingsWorkspace`, `StockWorkspace`, `ReplenishmentWorkspace`,
`PurchaseOrdersClient`, `PricingMatrixClient`. DS-modal users: `products/next/ProductsNextClient`,
`marketing/ads/campaigns/CampaignsGrid`, `marketing/ads/reporting/SectionControls`, `components/DataGrid` (all 71 hosts),
`patterns/SectionLayout`. Third copy: `products/[id]/edit/_shared/TabPreferencesModal.tsx`.

### A.3 `AdsDataGrid` (= DS `WorkspaceGrid`) — 57 importers, 52 render sites

| Route family | Files | Dominant props | Inline edit → server | Host | Rows |
|---|---|---|---|---|---|
| `marketing/ads/campaigns/[id]/tabs` | 4 | `editMode`, `selectionActions`, `enabledFirst`, `storageKey`, `filters` | **yes, 4/4** | tab + Modal | 10s–100s |
| `marketing/ads/campaigns/[id]/ad-groups/[agId]/tabs` | 4 | same | **yes, 3/4** | tab + Modal | 100s–1000s |
| `marketing/ads/ebay/campaigns/[id]/tabs` | 5 (+1 type) | `storageKey`, `searchValue`, `selectable`, `defaultSort`, `editMode` | yes, 2 (`postEbayAds`) | tab | 10s–100s |
| `marketing/ads/ebay/campaigns/[id]/ad-groups/[agId]/tabs` | 4 | `storageKey`, `searchValue`, `selectable` | yes, 1 | tab | 10s–100s |
| `marketing/ads/ebay/campaigns` (list) | 1 | `filterPresetsKey`, `toolbarLeft/Right`, `onRowClick`, `initialFilters` | no | page card | 100s |
| `marketing/ads/ebay/automation/tabs` | 2 | `selectionActions`, `rowClassName`, `storageKey` | no | tab | 10s–100s |
| `marketing/ads/ebay/change-log`, `ebay/products` | 2 | `filters`, `groupBy`, `reportLabel`, `toolbar*` | no | page card + Modal | 100s–1000s |
| `marketing/ads/reporting` | 6 | **`showTotal` ×6**, `selectable`, `hierarchy` (`ExplorerTab`), `groupBy` (`LibraryTab`), **`server`** (`ReportRunner`, 12,276 rows) | no | tab / page card | **10k+** |
| `marketing/ads/rules-automation/*` | 19 (+3 type) | `filterState`+`onFilterStateChange`+`hideFilterPanel`, `emptyNode`, `toolbarLeft/Right`, `selectionActions`, `onRowClick`, `totalFirst` | 1 (`CampaignLimitsModal`) | page card; 8 with Drawer; 1 Modal | 100s–1000s |
| `marketing/ads/suggestions` | 2 | `keyboardNav`+`onRowKey`, `filterState`, `groupBy`, **`freezeRight`** (`SuggestionsClient`, `RecommendationsView`) | no | page card + Drawer + Modal | 100s |
| `marketing/ads/ai-advertising` | 1 | full URL bridge | no | page card + Drawer | 100s |
| `marketing/ads/budget-manager` | 1 | `customizable`, `searchValue`, no `storageKey` | no | page card + Drawer/Modal | 100s |
| `marketing/ads/changelog` | 1 | `filters`, `onExport`, `toolbarRight` | no | page card + Modal | 1000s |
| `campaigns/_grid/filters.ts` | 1 (type) | — | — | — | — |

Prop frequency (52 sites): `rows/rowId/renderFirst/noun/firstSortValue/firstColLabel/columns` 52 · `storageKey` 38 ·
`selectable` 35 · `loading` 34 · `defaultSort` 34 · `emptyLabel` 32 · `searchable` 31 · `searchValue` 27 · `showTotal` 25 ·
`selectionActions` 23 · `searchPlaceholder` 23 · `filters` 23 · `pagerCentered` 21 · `toolbarRight` 19 · `emptyNode` 19 ·
`customizable` 19 · `toolbarLeft` 17 · `selected` 16 · `reportLabel` 16 · `onSelectedChange` 16 · `exportable` 14 ·
`enabledFirst` 14 · `onRowClick` 13 · `editMode` 10 · `onFilterStateChange` 8 · `onExport` 8 · `hideFilterPanel` 8 ·
`filterState` 8 · `onSortChange` 7 · `totalFirst` 5 · `filtersDefaultOpen` 5 · `onPageChange` 3 · `keyboardNav` 3 ·
`initialPage` 3 · `initialFilters` 3 · `groupBy` 3 · `rowClassName` 2 · `onSearchChange` 2 · `onRowKey` 2 · `initialSearch` 2 ·
`server` 1 · `onFilterChange` 1 · `hierarchy` 1 · `filterPresetsKey` 1. No spread props anywhere.

Storage-key conventions (48 keys): `h10-*` (Amazon/legacy, e.g. `h10-cd-adgroups-cols`), `er1-ebay-*` + `h10-ebay-*`,
`nexus.*.cols` (rules-automation), bare/`rpt-`/`rpx-` (reporting, ranks, suggestions), dynamic
`suggestions-grid-${activeView.key}-v1`. Stylesheet order (`marketing/ads/layout.tsx`): `tokens.css` → `primitives.css`
→ `_shared/shared-shell.css` → `ads.css` → `workspace-grid.css`. Not `AdsDataGrid`: `campaigns/CampaignsGrid.tsx`
(2,190 lines, hand-rolled) and `campaign-builder/sp-super-wizard/CampaignSetup.tsx` (purpose-built table).

### A.4 Raw `<table>` — 200 real files

Prose-only (excluded, 6): `app/_shared/useColumnResize.tsx`, `app/marketing/ads-console/campaigns/CampaignsTable.tsx`,
`app/marketing/ads/reporting/ReportingClient.tsx`, `app/marketing/ads/reporting/ExplorerTab.tsx`,
`app/pricing/PricingMatrixClient.tsx`, `app/products/[id]/datasheet/AttributesTab.tsx`.

**(1) Data grids — 117**
- orders/customers (12): `app/orders/_lenses/{GridLens,FinancialsLens,CustomerLens,ReturnsLens,ReviewsLens}.tsx`, `app/orders/[id]/OrderDetailClient.tsx`, `app/orders/_components/BulkActionBar.tsx`, `app/orders/reviews/rules/RulesClient.tsx`, `app/performance/feedback/page.tsx`, `app/customers/CustomersWorkspace.tsx`, `app/customers/risk-queue/RiskQueueClient.tsx`, `app/customers/[id]/CustomerDetailClient.tsx`
- fulfilment/stock/suppliers (28): `app/fulfillment/outbound/{ShipmentsClient,PendingShipmentsClient}.tsx`, `outbound/pick-list/PickListClient.tsx`, `outbound/rules/RulesClient.tsx`, `routing-log/RoutingLogClient.tsx`, `routing-rules/RoutingRulesClient.tsx`, `inbound/InboundWorkspace.tsx`, `returns/ReturnsWorkspace.tsx`, `returns/automation/AutomationClient.tsx`, `returns/policies/PoliciesClient.tsx`, `repricing/{RepricingDecisionsClient,RepricingRuleStats}.tsx`, `stock/StockWorkspace.tsx`, `stock/control-tower/ControlTowerClient.tsx`, `stock/import/ImportClient.tsx`, `stock/pool-drift/PoolDriftClient.tsx`, `stock/cycle-count/[id]/CycleCountSessionClient.tsx`, `stock/recalls/[id]/RecallDetailClient.tsx`, `purchase-orders/PurchaseOrdersClient.tsx`, `purchase-orders/[id]/PurchaseOrderDetailClient.tsx`, `purchase-orders/_shared/CsvImportModal.tsx`, `purchase-orders/templates/PoTemplatesClient.tsx`, `suppliers/SuppliersClient.tsx`, `suppliers/development/DevelopmentClient.tsx`, `replenishment/_shared/{SlowMoversCard,SupplierSpendCard,CannibalizationCard,ForecastBiasCard,ScenariosCard}.tsx`
- inventory/sync (7): `components/inventory/InventoryTable.tsx` (TanStack), `components/inventory/ChannelResolverClient.tsx`, `components/outbound/SyncQueueTable.tsx` (TanStack), `app/sync-logs/outbound-queue/OutboundQueueClient.tsx`, `app/sync-logs/api-calls/ApiCallsClient.tsx`, `app/sync-logs/webhooks/WebhooksClient.tsx`, `app/dashboard/sync/SyncHealthClient.tsx`
- listings (3): `app/listings/ListingsWorkspace.tsx`, `app/listings/ebay/gaps/EbayGapsClient.tsx`, `app/listings/publish-status/PublishStatusClient.tsx`
- catalog/products (23): `app/catalog/CatalogClient.tsx`, `catalog/organize/OrganizeClient.tsx`, `catalog/organize/_components/OrganizeGridTab.tsx`, `catalog/drafts/page.tsx`, `catalog/[id]/edit/tabs/VariationsTab.tsx`, `app/products/costs/CostGridClient.tsx`, `products/drafts/DraftsClient.tsx`, `products/stranded/page.tsx`, `products/upload/page.tsx`, `products/amazon-flat-file/{AmazonFlatFileClient,FeedSubmissionsPanel}.tsx`, `products/ebay-flat-file/EbayPushHistoryPanel.tsx`, `components/flat-file/HistoryModal.tsx`, `products/[id]/edit/tabs/{VariationsTab,AdsTab}.tsx`, `products/[id]/edit/tabs/ebay-cockpit/cards/CompatibilityCard.tsx`, `products/[id]/edit/tabs/images/{PublishAuditLog,ImagePublishHistory,ChannelPublishPreviewModal}.tsx`, `products/[id]/edit/tabs/images/amazon/PublishPreviewModal.tsx`, `products/[id]/datasheet/FlatVariantTable.tsx`, `app/reconciliation/ReconciliationClient.tsx`, `app/analytics/products/PortfolioClient.tsx`
- marketing (13): `app/marketing/ads/campaigns/CampaignsGrid.tsx`, `marketing/campaigns/MarketingCampaignsClient.tsx`, `marketing/campaigns/[id]/CampaignDetailClient.tsx`, `marketing/advertising/funnel/FunnelClient.tsx`, `marketing/automation/history/page.tsx`, `marketing/automation-os/AutomationStudioClient.tsx`, `marketing/budgets/BudgetCenterClient.tsx`, `marketing/content/mapping/MappingCanvasClient.tsx`, `marketing/reviews/by-product/ByProductClient.tsx`, `marketing/reviews/requests/page.tsx`, `marketing/reviews/import/ImportClient.tsx`, `marketing/aplus/AplusListClient.tsx`, `marketing/brand-story/BrandStoryListClient.tsx`
- pricing (4): `app/pricing/buybox/BuyBoxClient.tsx`, `pricing/alerts/PricingAlertsClient.tsx`, `pricing/promotions/PromotionsClient.tsx`, `pricing/rules/PricingRulesTable.tsx` (TanStack)
- bulk-ops (9): `app/bulk-operations/history/HistoryClient.tsx`, `imports/ImportsClient.tsx`, `exports/ExportsClient.tsx`, `imports/ScheduledImportsPanel.tsx`, `exports/ScheduledExportsPanel.tsx`, `schedules/SchedulesClient.tsx`, `BulkOperationModal.tsx`, `PreviewChangesModal.tsx`, `app/_shared/bulk-edit/modals/PreviewChangesModal.tsx`
- settings/admin (9): `app/settings/ai/{AiUsageClient,AiAgentsClient}.tsx`, `settings/channels/[type]/ChannelDetailClient.tsx`, `settings/pim/attributes/AttributesClient.tsx`, `settings/pim/families/FamiliesClient.tsx`, `settings/team/TeamAccessClient.tsx`, `app/admin/recycle-bin/RecycleBinClient.tsx`, `app/fleet/workflows/RunsSection.tsx`, `app/fleet/assignments/[id]/AssignmentClient.tsx`
- dashboard/reports (10): `app/dashboard/reports/[reportId]/ReportDetailClient.tsx`, `dashboard/bulk-actions/BulkActionsTable.tsx` (TanStack), `dashboard/health/{StockDriftPanel,ChannelStockEventPanel,CronStatusPanel}.tsx`, `dashboard/analytics/revenue/RevenueClient.tsx`, `app/reports/business/BusinessReportsClient.tsx`, `app/insights/amazon-reports/_components/AmazonReportsClient.tsx` (+2 counted in the census under other areas)

**(3) Matrices — 47**
- products (25): `app/products/_lenses/{CoverageLens,PricingLens,ReadinessLens,TranslationsLens}.tsx`, `products/[id]/matrix/MatrixWorkspace.tsx`, `products/[id]/edit/tabs/{MatrixTab,InventoryTab,PricingTab,AnalyticsTab,ChannelInventorySection,ChannelPricingSection}.tsx`, `products/[id]/edit/tabs/amazon-cockpit/variations/{VariantCube,VariationMatrix}.tsx`, `products/[id]/edit/tabs/ebay-cockpit/cards/VariationsMatrixCard.tsx`, `products/[id]/edit/_shared/cockpit-shell/CrossChannelMatrix.tsx`, `products/[id]/datasheet/{VariantMatrix,VariantPricingPanel,VariantChannelCoverage,VariantCompliancePanel,VariantIdentifiers,PricingTab,TranslationsTab,LaunchReadiness,ChannelExpansion}.tsx`, `products/_modals/CompareProductsModal.tsx`
- catalog (2): `app/catalog/[id]/edit/tabs/VariationMatrixTable.tsx`, `components/catalog/VariationMatrixTable.tsx`
- insights/analytics (9): `app/insights/profit/_components/ProfitClient.tsx`, `insights/sales/_components/SalesClient.tsx`, `insights/forecast/_components/ForecastClient.tsx`, `insights/customers/_components/CustomersClient.tsx`, `insights/_components/MarketplaceMatrixWidget.tsx`, `app/marketing/analytics/AnalyticsClient.tsx`, `components/insights/charts/HeatmapGrid.tsx` (chart), `components/insights/charts/TableWithSparkline.tsx`, `app/dashboard/overview/_components/HeatmapPanel.tsx` (chart)
- dashboard (2): `app/dashboard/overview/_components/MarketplaceMatrix.tsx`, `components/dashboard/GlobalSnapshot.tsx`
- fulfilment (6): `app/fulfillment/stock/sync-control/SyncControlClient.tsx`, `stock/sync-control/product/[masterId]/ProductDetailClient.tsx`, `purchase-orders/_shared/ThreeWayMatchPanel.tsx`, `returns/analytics/AnalyticsClient.tsx`, `outbound/analytics/AnalyticsClient.tsx`, `replenishment/_shared/PanEuDistributionCard.tsx`
- other (3): `components/flat-file/FlatFileGrid.tsx` (**untouchable**), `app/marketing/reviews/heatmap/HeatmapGrid.tsx` (chart), `app/orders/reviews/rules/send-times/SendHourReport.tsx`

**(2) Key-value — 10:** `app/products/_shared/ProductDrawer.tsx`, `products/[id]/datasheet/OverviewTab.tsx`, `products/amazon-flat-file/PullDiffModal.tsx`, `CarrierConfigDrawer`, `OutboundOrderDrawer`, `suppliers/development/[id]/ProjectDetailClient`, `ImportFromAmazonModal`, `dashboard/analytics/inventory/InventoryAnalyticsClient`, `po/ack/[token]/PoAckClient`, `po/approve/[token]/PoApproveClient`.
**(4) Form rows — 19:** `settings/terminology/TerminologyClient`, `settings/notifications/NotificationsClient`, `products/[id]/list-wizard/steps/_MatrixVariantBuilder`, `settings/ai/AiModelsClient`, `settings/pim/families/[id]/FamilyEditorClient`, `settings/pim/workflows/WorkflowsClient`, `pricing/rules/CreateRuleModal`, `pricing/volume-pricing/VolumePricingClient`, `orders/reviews/rules/send-times/SendTimesClient`, `orders/reviews/rules/timing/TimingDefaultsClient`, `catalog/add/page`, PO `CreatePoModal`/`EditableSummaryPane`/`QuickReceiveModal`, `stock/sync-control/SyncExcelBar`, `cockpit-shell/AutoMapModal`, list-wizard `Step5Variations`/`Step8Pricing`, `amazon-flat-file/ImportWizardModal`.
**(5) Print/email — 4:** `products/[id]/datasheet/print/page.tsx`, `datasheet/print/PrintVariantMatrix.tsx`, `marketing/aplus/_components/ModuleRender.tsx`, `app/shared/report/[token]/page.tsx`.
**(6) Other — 3:** `components/ui/DataTable.tsx`, `app/design/page.tsx`, `app/design/console/page.tsx`.

Raw tables writing localStorage (20): `customers/CustomersWorkspace`, `fulfillment/inbound/InboundWorkspace`, `outbound/PendingShipmentsClient`, `outbound/ShipmentsClient`, `purchase-orders/PurchaseOrdersClient`, `returns/ReturnsWorkspace`, `stock/StockWorkspace`, `stock/control-tower/ControlTowerClient`, `stock/import/ImportClient`, `listings/ListingsWorkspace`, `marketing/ads/campaigns/CampaignsGrid`, `orders/_lenses/GridLens`, `products/[id]/edit/tabs/MatrixTab`, `products/amazon-flat-file/{AmazonFlatFileClient,FeedSubmissionsPanel,ImportWizardModal}`, `reconciliation/ReconciliationClient`, `settings/notifications/NotificationsClient`, `sync-logs/outbound-queue/OutboundQueueClient`, `components/dashboard/GlobalSnapshot`, `components/flat-file/{FlatFileGrid,HistoryModal}`.
