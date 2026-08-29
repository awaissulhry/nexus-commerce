/**
 * GDS — the grid design system on AG Grid. ONE import surface for pages.
 *
 *   import { NexusGrid, numericColumn, type ColDef } from '@/design-system/grid'
 *
 * Layout (docs/2026-08-28-grid-design-system-gds.md §0c):
 *   NexusGrid.tsx   the thin `AgGridReactProps<T>` wrapper — pages hand it AG's own ColDef[]
 *   theme/          Theming API bound to `--nds-grid-*` (tokens/grid.ts) + the engine stylesheet
 *   modules.ts      the curated module list — the only place production registers AG modules
 *   renderers/      the cell library (memoised, null-safe) + the loading/empty overlays
 *   editors/        AG's number editor configured, a DS Listbox editor, the per-cell round trip
 *   columns/        column presets, the DS PreferencesModal ⇄ AG column-state bridge
 *   toolbars/       GridToolbar (DS pattern), GridPager, GridFooterStrip, GridDensityToggle
 *   hosts/          GridCard (page: autoHeight) and GridPanel (modal/drawer: bounded)
 *   filters/        DS-built column filters mounted in AG's column menu
 *   hooks/          density context, theme mode, grid state (last-used + named views)
 *   sortValues.ts   the blank-sinking comparator (KT.3)
 *
 * Only this folder (and app/design/grid-lab) may import `ag-grid-*` —
 * scripts/check-ag-grid-import-boundary.mjs fails the push otherwise.
 */
export { NexusGrid, numericColumn, type NexusGridProps, type GridDensity, type GridRowKind } from './NexusGrid'
export type {
  ColDef,
  ColGroupDef,
  ColumnState,
  GridApi,
  GridReadyEvent,
  GridState,
  ICellRendererParams,
  IRowNode,
  IServerSideDatasource,
  IServerSideGetRowsParams,
  SortModelItem,
  ValueGetterParams,
  ValueSetterParams,
} from './NexusGrid'
export { workspaceGridTheme, HEADER_COLUMN_PARTITION } from './theme/theme'
export { registerGridModules } from './modules'
export { GridSetFilter, GridNumberRangeFilter, GridTextFilter, gridFilterDef, type SetFilterOption, type SetFilterParams, type NumberRangeFilterParams } from './filters/gridFilters'
export { prefsToColumnState, columnStateToPrefs, AG_SELECTION_COL, AG_AUTO_COL, type PrefsColumnMeta, type PrefsBridgeOptions } from './columns/columnPrefs'
export { useAgThemeMode } from './hooks/useAgThemeMode'
export { GridDensityProvider, useGridDensity, useGridDensityTier, DEFAULT_GRID_DENSITY } from './hooks/useGridDensity'
export { gridDensity, gridGeometry, gridType, GRID_DENSITIES, type GridDensityName } from '../tokens/grid'
export { useGridViews, GRID_VIEW_SCHEMA, type GridViewPayload, type SavedGridView, type UseGridViewsOptions } from './hooks/useGridViews'
export { useGridState, readLastUsed, writeLastUsed, clearLastUsed, lastUsedKey, LAST_USED_SCHEMA, gridViewPayload, type GridStateApi, type LastUsedState, type UseGridStateOptions } from './hooks/useGridState'
export { compareSortValues, compareForAgGrid, type SortDir, type SortValue } from './sortValues'
export * from './renderers'
export {
  gridSelection, selectionColumn, integerColumn, moneyColumn, euroColumn, percentColumn, deltaColumn, dateColumn, statusColumn, textColumn,
  stockColumn, lockedColumn, holdColumn, actionsColumn, type GridSelectionOptions, type ActionsColumnOptions,
} from './columns/presets'
export * from './editors'
export * from './toolbars'
export * from './hosts'
