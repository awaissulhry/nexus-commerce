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
  AgMenuItemDef,
  CellClassParams,
  ColDef,
  ColGroupDef,
  ColumnState,
  DefaultMenuItem,
  GetContextMenuItemsParams,
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
export { LoadedRowsSelectionHeader } from './renderers/LoadedRowsSelectionHeader'
export { GridSetFilter, GridNumberRangeFilter, GridTextFilter, gridFilterDef, type SetFilterOption, type SetFilterParams, type NumberRangeFilterParams } from './filters/gridFilters'
export { setFilterPasses, numberFilterPasses, textFilterPasses, BLANK_FILTER_VALUE } from './filters/filterPredicates'
export { GridTextFloatingFilter, GridNumberRangeFloatingFilter, GridSetFloatingFilter } from './filters/gridFloatingFilters'
// The action registry (ruling #113): the TYPE and its adapters are the DS's; the definitions are each lane's.
export { actionsFor, isRunnable, requiresTypedConfirm, validateImpact, sameScope, ROW, SELECTION, contextOf, AVAILABLE, HIDDEN, disabled, type GridAction, type ActionScope, type ContextAxis, type ActionAvailability, type ActionImpact, type ActionResult, type ActionInvalidation, type ConfirmLevel } from './actions/registry'
export { PARAMETERISED_VERB_ORDER } from './actions/registry'
// MX.G (2026-09-13) — the Matrix's eleven verbs, declared once, and the registry adapter that runs them.
export {
  matrixActions, matrixGridActions, matrixImpact, matrixImpactTitle,
  MATRIX_PARENT_ONLY_REASON, MATRIX_NO_INVENTORY_REASON, MATRIX_NO_PRICE_REASON, MATRIX_NO_PRICE_PERMISSION_REASON, MATRIX_NO_FAILURE_REASON, MATRIX_NO_SOURCE_COORDINATE_REASON,
  type MatrixVerbField, type MatrixVerbSpec, type MatrixActionsContext, type MatrixVerbHost, type MatrixVerbCollected,
} from './actions/matrixActions'
// The engine's declaration of the Matrix shapes (parity-gated against the wire contract). Explicit,
// not `export *`: the contract's cell INTERFACES (`FulfilmentCell`, `PriceCell`, `SaleCell`) share
// their names with the renderer COMPONENTS above, and a star export would be TS2308-ambiguous. The
// interfaces are reachable by deep import (`@/design-system/grid/matrix/contract`).
export {
  MATRIX_CELL_KINDS, INVENTORY_CELL_KINDS, WRITABLE_CELL_KINDS, MATRIX_CELL_LABELS, MATRIX_CELL_WIDTHS, MATRIX_VERB_LABELS,
  type MatrixCellKind, type MatrixCells, type MatrixCoordinate, type MatrixCopy, type CoordinateKey, type CoordinateKind,
  type ListingState, type FulfilmentMethod, type SyncKind, type SyncMode, type QueueState, type PriceSource,
  type MatrixWriteCell, type MatrixWritableKind, type MatrixVerbId, type MatrixVerbTarget,
  type VerbPreview, type VerbChange, type VerbRefusal, type RefusalKind,
} from './matrix/contract'
// The SEQUENCE a verb runs in, and the two React pieces around it. Exported from the barrel so a
// lane never has a reason to re-implement the preflight → validate → confirm → run rules: two
// copies of `validateImpact` is how a type-to-confirm becomes a click on exactly one surface.
export { runAction, type ActionOutcome, type AskToConfirm } from './actions/runAction'
export { useActionConfirm, type ActionConfirmApi } from './actions/ActionConfirm'
export { useActionPress, type ActionPressApi } from './actions/useActionPress'
// The row-menu and ⋯-column adapters — the other half of ruling #110. Without these a lane can
// declare a row verb and have it render on exactly one surface (#141).
export { actionMenuItems, actionContextMenu, type MenuAdapterOptions } from './actions/menuAdapters'
export { spanWithinSection, bandColSpan, type SpanColumnLike, type BandRowOptions } from './columns/spanRow'
export { prefsToColumnState, columnStateToPrefs, operatorLocks, AG_SELECTION_COL, AG_AUTO_COL, type PrefsColumnMeta, type PrefsBridgeOptions } from './columns/columnPrefs'
export { useAgThemeMode } from './hooks/useAgThemeMode'
export { GridDensityProvider, useGridDensity, useGridDensityTier, DEFAULT_GRID_DENSITY } from './hooks/useGridDensity'
export { gridDensity, gridGeometry, gridType, GRID_DENSITIES, type GridDensityName } from '../tokens/grid'
export { useGridViews, GRID_VIEW_SCHEMA, isGridStatePayload, type GridViewPayload, type SavedGridView, type SavedViewPayload, type UseGridViewsOptions } from './hooks/useGridViews'
export { resolvePreset, landingPreset, allColumnsPreset, ALL_VIEW_ID, type GridViewPreset, type PresetResolution } from './views/presets'
// 2026-09-04 (design V.1–V.3, V.8): a saved view as a column-key list, and the ONE landing rule the
// studio sheets share — full unless an explicit default view; widths/pins/sort restored, never
// visibility or order.
export { columnsViewPayload, sheetLayoutPayload, isColumnsViewPayload, COLUMNS_VIEW_SCHEMA, SHEET_LAYOUT_SCHEMA, type ColumnsViewPayload, type ColumnsViewPayloadV2, type SheetLayoutPayload, type SheetLayoutInput } from './views/viewPayload'
export { preferencesFromLayout, layoutFromPreferences, visibleLayoutKeys } from './views/columnLayout'
export { resolveLanding, arrangementColumnState, allColumns, type Landing, type LandingSource, type LandingInput, type PersistedArrangement } from './views/landing'
export { useGridState, readLastUsed, writeLastUsed, clearLastUsed, lastUsedKey, pickGridState, LAST_USED_SCHEMA, gridViewPayload, type GridStateApi, type GridStateKey, type LastUsedState, type UseGridStateOptions } from './hooks/useGridState'
export { compareSortValues, compareForAgGrid, type SortDir, type SortValue } from './sortValues'
export * from './renderers'
export {
  gridSelection, selectionColumn, integerColumn, moneyColumn, euroColumn, percentColumn, deltaColumn, dateColumn, statusColumn, textColumn,
  stockColumn, lockedColumn, holdColumn, actionsColumn, type GridSelectionOptions, type ActionsColumnOptions,
} from './columns/presets'
export * from './editors'
export * from './toolbars'
export * from './hosts'
// AG.1-e — CSV. `gridCsv` is the FORMAT (RFC 4180, UTF-8 BOM, dated file name); `exportGrid` is
// the SOURCE (the columns on screen, the operator's sort and filter order, cells as the grid
// renders them). It REFUSES under SSRM rather than exporting the loaded blocks as if they were
// the result set — see the header of `export/gridCsv.ts` for why that matters.
export { toCsv, csvField, downloadCsv, csvFileName, hasKeyRow, type CsvColumn } from './export/gridCsv'
export { exportGridCsv, gridCsvRows, gridCsvSourceFromApi, GridExportRefused, type GridCsvSource, type GridCsvResult, type GridCsvExtraColumn, type GridCsvSourceOptions, type ExportGridCsvOptions } from './export/exportGrid'
export { sheetFilterFor } from './filters/sheetFilterFor'

export { useGridLifetime } from './hooks/useGridLifetime'

export { intentMeta, factMeta, verdictMeta, presenceVerdict, presenceLine, PRESENCE_INTENTS, CHANNEL_FACTS, PRESENCE_VERDICTS, type Presence, type PresenceIntent, type ChannelFact, type PresenceVerdict, type PresenceMeta } from './renderers/presence'
export { CellSaveMark, type CellSaveMarkProps } from './renderers/CellSaveMark'
export { SheetStatuses, type SheetStatus, type SheetStatusesProps } from './toolbars/SheetStatus'
export { frictionFor, requiresAcknowledgement, reversalSentence, validateAction, type Reach, type Fidelity, type ActionReversal, type ActionSubject, type ActionFinding, type ActionRefusal, type ActionHandoff, type ActionReview } from './actions/registry'
