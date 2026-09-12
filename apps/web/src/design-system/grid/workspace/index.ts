/**
 * AGW — the ads console's workspace grid on AG Grid Enterprise, behind the props contract the
 * console has always spoken. `import { WorkspaceGrid } from '@/design-system/grid/workspace'`.
 * The filter bar and the pure pipeline modules stay in `patterns/workspace-grid/`, re-exported here
 * so a consumer needs one import path.
 */
export { WorkspaceGrid } from './WorkspaceGrid'
export { AdsFilterBar, stripServerKeys, isServerKey } from '@/design-system/patterns/workspace-grid/AdsFilterBar'
export { enabledRank } from '@/design-system/patterns/workspace-grid/enabledRank'
export { adsWorkspaceTheme } from './theme'
export type {
  GridPrefs, GridColumn, GridHierarchy, GridRangeFilter, GridSelectFilter, GridMultiSelectFilter, GridFilter,
  GridEditField, GridEditMode, RangeVal, FilterState, WorkspaceGridProps,
} from './types'
