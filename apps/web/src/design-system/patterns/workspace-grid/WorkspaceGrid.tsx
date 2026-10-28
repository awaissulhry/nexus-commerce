'use client'

/**
 * AGW (2026-09-05) — the WorkspaceGrid is the AG Grid engine now: `design-system/grid/workspace`.
 *
 * This file is the seam the ads console has always imported through (`AdsDataGrid` re-exports it,
 * and so does the patterns barrel). It keeps that import path alive and points it at the engine;
 * the props contract, the filter bar, the pure pipeline modules (`filterRows`, `editDrafts`,
 * `rowInteraction`, `enabledRank`) and the preset library are unchanged and still live beside it.
 * The hand-rolled `<table>` implementation is gone (grid audit wave 4: the lab's parity harness retired with it).
 */
export { WorkspaceGrid, AdsFilterBar, stripServerKeys, isServerKey, enabledRank } from '../../grid/workspace'
export type {
  GridPrefs, GridColumn, GridHierarchy, GridRangeFilter, GridSelectFilter, GridMultiSelectFilter, GridFilter,
  GridEditField, GridEditMode, RangeVal, FilterState, WorkspaceGridProps,
} from '../../grid/workspace'
