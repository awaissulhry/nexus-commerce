/**
 * WG.3e (2026-08-25) — the grid moved into the design system as
 * `@/design-system/patterns/workspace-grid`, making the #13 decision real: the ads console's grid
 * IS the platform's workspace grid, and the DS `DataGrid` is the one being retired.
 *
 * AGW (2026-09-05) — the engine under it is AG Grid Enterprise: `@/design-system/grid/workspace`, the
 * IDENTICAL `WorkspaceGridProps`. The legacy grid was measured in a browser on 17 console pages before
 * this flip (the programme's baseline; every record stamped `engine: 'legacy'`). Its frozen copy and the
 * grid lab's parity tabs went in grid audit wave 4 (2026-10-13): the AG engine is the only one.
 */
export {
  WorkspaceGrid,
  WorkspaceGrid as AdsDataGrid,
  AdsFilterBar,
  stripServerKeys,
  isServerKey,
  enabledRank,
} from '@/design-system/grid/workspace'
export type {
  GridPrefs,
  GridColumn,
  GridHierarchy,
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
} from '@/design-system/grid/workspace'
