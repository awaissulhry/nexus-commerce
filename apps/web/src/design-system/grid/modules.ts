/**
 * AG.1 / AG.4 / PN.1 — AG Grid module registration. The ONLY place a production surface
 * registers modules.
 *
 * A CURATED list, not `AllEnterpriseModule`. AG Grid is tree-shaken by module: every module
 * registered here is bundled into the first route that renders a grid, on an app with 330
 * routes and a shared client bundle. The wildcard is 85 modules plus the AG Charts runtime;
 * this list is what the two engine components actually use, and nothing else.
 *
 *   NexusGrid (/products/next)                     AgWorkspaceGrid (ads console, Phase 3)
 *   ───────────────────────────────────────────    ────────────────────────────────────────
 *   Server-Side Row Model + its API                Client-Side Row Model + its API
 *   tree data (families), row grouping,            pinned Total row
 *   aggregation (group rows), column menu,
 *   custom filter components, row selection,
 *   pagination, CSV export, grid state (views)
 *
 *   Inventory editor (the modal behind the Available cell): spreadsheet editing —
 *   number editor, cell-range selection + fill handle, clipboard paste, undo/redo,
 *   quick filter (search), pinned totals row.
 *
 *   shared: column API (Customise dialog bridge), row API (forEachNode), event API,
 *           cell/row style (cellClass, rowClassRules), locale (localeText), render API.
 *
 * The feature lab (`/design/grid-lab`) shows EVERY feature and registers the wildcard itself —
 * see `app/design/grid-lab/labModules.ts`. Registration is additive and idempotent, so the lab
 * adds to this list rather than replacing it, and no production route pays for the lab.
 *
 * ADDING A FEATURE: register its module here, and only here. `ValidationModule` (dev only,
 * below) names the missing module in the console when a page uses a feature this list does not
 * carry — that message is the whole reason the module is registered in development.
 *
 * Registration is module-scoped so importing this file from several entry points is safe — but
 * it must run before the first grid mounts, which is why the engine components call it at module
 * scope rather than in an effect.
 */
import { ModuleRegistry } from 'ag-grid-community'
import {
  AggregationModule,
  CellApiModule,
  CellSelectionModule,
  CellStyleModule,
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  ClipboardModule,
  ColumnApiModule,
  ColumnAutoSizeModule,
  ColumnMenuModule,
  ContextMenuModule,
  TooltipModule,
  CsvExportModule,
  CustomEditorModule,
  CustomFilterModule,
  EventApiModule,
  GridStateModule,
  LargeTextEditorModule,
  LicenseManager,
  LocaleModule,
  MasterDetailModule,
  NumberEditorModule,
  PaginationModule,
  PinnedRowModule,
  QuickFilterModule,
  RenderApiModule,
  RichSelectModule,
  RowApiModule,
  RowAutoHeightModule,
  RowGroupingModule,
  RowSelectionModule,
  RowStyleModule,
  ScrollApiModule,
  ServerSideRowModelApiModule,
  ServerSideRowModelModule,
  TextEditorModule,
  TreeDataModule,
  UndoRedoEditModule,
  ValidationModule,
} from 'ag-grid-enterprise'

const PRODUCTION_MODULES = [
  // row models
  ServerSideRowModelModule,
  ServerSideRowModelApiModule,
  ClientSideRowModelModule,
  ClientSideRowModelApiModule,
  // structure
  TreeDataModule,
  RowGroupingModule,
  AggregationModule,
  PinnedRowModule,
  // GDS: expandable detail rows (9 DataGrid sites use `renderExpanded`; wave 1 needs it)
  MasterDetailModule,
  // interaction
  ColumnMenuModule,
  // Right-click on a row. NOT `MenuModule`, which bundles the column menu we already register —
  // this is the context menu alone, so the list above keeps naming exactly what is bundled.
  ContextMenuModule,
  /* 🔴 Without this, `tooltipValueGetter`, `headerTooltip` and `headerTooltipValueGetter` do
     NOTHING — on every grid in the app. Found by PES.3 (#548): `ChannelSheet`'s header tooltips
     have never rendered, and this engine leans on tooltips heavily by design — the action adapters
     put a verb's refusal REASON in a tooltip rather than in its label (a 900px menu, #141), the
     provenance mark explains itself only on hover, and `absent` controls carry their reason there.
     So an unregistered module quietly deleted the explanation channel three separate rulings chose.
     The dev-only `ValidationModule` names the missing module in the console; nothing in production
     says a word, which is the silent-omission trap this file exists to prevent. */
  TooltipModule,
  CustomFilterModule,
  RowSelectionModule,
  PaginationModule,
  CsvExportModule,
  // editing. The inventory editor needed only numbers; the Product Edit Studio's master sheet is
  // the first production surface that edits TEXT, and AG's editors are per-type modules:
  //   TextEditorModule       `agTextCellEditor`      — every text and identifier column
  //   LargeTextEditorModule  `agLargeTextCellEditor` — the popup for descriptions and bullets
  //   CustomEditorModule     any React component used as a cell editor
  // ⚠ `CustomEditorModule` no longer has a caller in this repo: the DS `SelectCellEditor` was its
  // only one and AG.1 (#184) replaced it with `agRichSelectCellEditor`. Kept deliberately — the
  // module gate's detector for it does not fire, and "no detector hit" is not proof of no caller
  // (`reference_a_scanner_passing_for_the_wrong_reason`), while dropping it would silently disable
  // the next React editor anyone writes. It is bundle weight with a known reason, not an oversight.
  // 🔴 Without them AG raises error #200 and the cell simply does not open an editor — measured in
  // the browser on the studio sheet, where every text column was silently uneditable while the
  // number columns worked. The lab never caught it because `grid-lab` registers the wildcard.
  NumberEditorModule,
  TextEditorModule,
  LargeTextEditorModule,
  CustomEditorModule,
  //   RichSelectModule       `agRichSelectCellEditor` — every `select` column on a studio sheet
  // 🔴 AG.1 (#184): this replaced a DS `Listbox` mounted as a React editor, which could not be
  // opened at all — its popover portalled to `document.body`, AG saw focus leave the cell and tore
  // the editor down in 2ms. The rich select lives inside AG's focus model and brings the type-ahead
  // search 268 options need. Registered HERE, not merely named in a comment, because the module
  // gate reads the registration — and an unregistered module fails SILENTLY in production, which
  // for an editor means a cell that simply never opens (measured twice before: the text editors,
  // then `CellApiModule`).
  RichSelectModule,
  CellSelectionModule,
  ClipboardModule,
  UndoRedoEditModule,
  QuickFilterModule,
  // state + APIs
  GridStateModule,
  ColumnApiModule,
  /* AGW (2026-09-05, additive, disclosed in docs/pes-claims.md): `api.autoSizeColumns` /
     `sizeColumnsToFit` for the ads console's workspace grid — the hand-rolled `<table>` sized its
     columns to their content, and the AG-backed grid does the same by measuring. 🔴 Without this
     module the call raises AG #200 in development and does NOTHING in production: every column
     would sit at AG's 200px default, silently. Measured on /marketing/ads/ebay/campaigns before
     the registration (2,746px of columns in a 1,600px card). */
  ColumnAutoSizeModule,
  /* AGW (2026-09-05 23:50, additive, disclosed in docs/pes-claims.md): `colDef.autoHeight` for the ads
     console's workspace grid — the legacy `<td>` grew with its content (measured: 44.5 · 46 · 47.5 · 51.3 ·
     62 · 82.3px rows, four heights inside one library grid), so every cell measures itself. 🔴 Without this
     module `autoHeight` raises AG #200 in development and is IGNORED in production: every row would sit at
     the 45px default and multi-line cells would clip, silently. */
  RowAutoHeightModule,
  // `api.getCellValue` — used by the sheet's paste processor to leave a column the pasted block did
  // not name exactly as it was. 🔴 Without it that call returns `undefined` SILENTLY in production
  // (the error text is ValidationModule's, and that is dev-only), so the paste would have blanked
  // those columns while the code read as if it protected them. Second time an unregistered module
  // disabled DS behaviour with no runtime signal; the first was the text editors.
  CellApiModule,
  RowApiModule,
  EventApiModule,
  RenderApiModule,
  // 🔴 AG.1 (#184, AG.1-e): `api.ensureColumnVisible` / `ensureIndexVisible`. Without it the call
  // raises AG #200 and there is NO supported way to scroll a cell into view — which blocks two
  // stated behaviours: the "Missing required" chip's job is to take the operator TO those cells
  // (today it only filters), and PES.4's drawer must scroll the originating cell clear of the
  // slide-over (layout spec §5.4). Registered before either is built, so neither builds against a
  // throwing call.
  ScrollApiModule,
  // presentation
  CellStyleModule,
  RowStyleModule,
  LocaleModule,
]

let registered = false

export function registerGridModules(): void {
  if (registered) return
  registered = true

  // ValidationModule is added in development only. Without it AG reports problems as a bare
  // number — "warning #25" turned out to be a real defect in `getRowId` that had been firing on
  // every mount since AG.1 and was unreadable for exactly that reason. It is dev-only because its
  // whole job is printing message text, which is weight a built page should not carry.
  ModuleRegistry.registerModules(
    process.env.NODE_ENV === 'development'
      ? [...PRODUCTION_MODULES, ValidationModule]
      : PRODUCTION_MODULES,
  )

  const key = process.env.NEXT_PUBLIC_AG_GRID_LICENSE_KEY
  if (key) LicenseManager.setLicenseKey(key)
}
