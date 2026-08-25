/**
 * WG.3e (2026-08-25) — the grid moved into the design system as
 * `@/design-system/patterns/workspace-grid`, making the #13 decision real: the ads console's grid
 * IS the platform's workspace grid, and the DS `DataGrid` is the one being retired.
 *
 * This file re-exports it so 49 component call sites and 83 type imports did not have to change in
 * the same commit as the move. New code should import from `@/design-system/patterns`.
 */
export {
  WorkspaceGrid,
  WorkspaceGrid as AdsDataGrid,
  AdsFilterBar,
  stripServerKeys,
  isServerKey,
  enabledRank,
} from '@/design-system/patterns/workspace-grid/WorkspaceGrid'
export type {
  GridPrefs,
  GridColumn,
  GridRangeFilter,
  GridSelectFilter,
  GridMultiSelectFilter,
  GridFilter,
  GridEditField,
  GridEditMode,
  RangeVal,
  FilterState,
  WorkspaceGridProps,
  WorkspaceGridProps as AdsDataGridProps,
} from '@/design-system/patterns/workspace-grid/WorkspaceGrid'
