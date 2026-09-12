/**
 * WG.3e (2026-08-25) — the grid moved into the design system as
 * `@/design-system/patterns/workspace-grid`, making the #13 decision real: the ads console's grid
 * IS the platform's workspace grid, and the DS `DataGrid` is the one being retired.
 *
 * AGW (2026-09-05) — the engine under it is AG Grid Enterprise: `@/design-system/grid/workspace`, the
 * IDENTICAL `WorkspaceGridProps`. The legacy grid was measured in a browser on 17 console pages before
 * this flip (the programme's baseline; every record stamped `engine: 'legacy'`), and its hand-rolled
 * body is frozen under `app/design/grid-lab/legacy/LegacyWorkspaceGrid.stories.tsx` for the parity lab only.
 * Rollback is these two exports pointing back at that copy — nothing else in the console changes.
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
