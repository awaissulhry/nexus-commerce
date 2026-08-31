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
  CellSelectionModule,
  CellStyleModule,
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  ClipboardModule,
  ColumnApiModule,
  ColumnMenuModule,
  ContextMenuModule,
  CsvExportModule,
  CustomFilterModule,
  EventApiModule,
  GridStateModule,
  LicenseManager,
  LocaleModule,
  MasterDetailModule,
  NumberEditorModule,
  PaginationModule,
  PinnedRowModule,
  QuickFilterModule,
  RenderApiModule,
  RowApiModule,
  RowGroupingModule,
  RowSelectionModule,
  RowStyleModule,
  ServerSideRowModelApiModule,
  ServerSideRowModelModule,
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
  CustomFilterModule,
  RowSelectionModule,
  PaginationModule,
  CsvExportModule,
  // editing (inventory editor): a number editor, Excel-style range + fill handle, paste, undo
  NumberEditorModule,
  CellSelectionModule,
  ClipboardModule,
  UndoRedoEditModule,
  QuickFilterModule,
  // state + APIs
  GridStateModule,
  ColumnApiModule,
  RowApiModule,
  EventApiModule,
  RenderApiModule,
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
