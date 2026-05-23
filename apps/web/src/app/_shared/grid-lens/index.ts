/**
 * G.0 — grid-lens shared barrel.
 *
 * All public exports from the shared grid infrastructure.
 * Consumers: /products (and future pages).
 */

export { VirtualizedGrid, SearchContext, RiskFlaggedContext, DensityContext, ColumnResizeHandle } from './VirtualizedGrid'
export { SavedViewsButton } from './SavedViewsButton'
export { GridFooter } from './GridFooter'
export { ProductIdentityCell } from './ProductIdentityCell'
export { Thumbnail } from './Thumbnail'
export type { ThumbnailProps } from './Thumbnail'
export { PreferencesModal, PREFERENCES_DEFAULTS } from './PreferencesModal'
export type { PreferencesModalProps, PreferencesValue, PreferencesColumnSpec } from './PreferencesModal'
export { ActionCluster } from './ActionCluster'
export type {
  ActionClusterProps,
  ActionClusterVariant,
  ActionDef,
  ActionIcon,
  MenuItemDef,
} from './ActionCluster'
export { StockSplit } from './StockSplit'
export { DensityToggle } from './DensityToggle'
export { AutoRefreshSelect } from './AutoRefreshSelect'
export { KpiStrip } from './KpiStrip'
export { ColumnPicker as SharedColumnPicker } from './ColumnPicker'
export { BulkActionShell } from './BulkActionShell'
export { SortStack } from './SortStack'
export { KeyboardShortcutsModal, KeyboardShortcutsButton } from './KeyboardShortcutsModal'
export { LensTabs as SharedLensTabs } from './LensTabs'
export { FilterPopover } from './FilterPopover'
export { GridToolbar } from './GridToolbar'
export { AnchoredPopover } from './AnchoredPopover'
export type { GridLensColumn, GridLensRow } from './types'
export type { VirtualizedGridProps } from './VirtualizedGrid'
export type { SavedView } from './SavedViewsButton'
export type { ProductIdentityCellProps } from './ProductIdentityCell'
export type { StockSplitProps } from './StockSplit'
export type { Density, DensityToggleProps } from './DensityToggle'
export type { AutoRefreshInterval, AutoRefreshSelectProps } from './AutoRefreshSelect'
export type { KpiStripProps, KpiTileSpec, KpiTone } from './KpiStrip'
export type { ColumnPickerProps, ColumnSpec } from './ColumnPicker'
export type { BulkActionShellProps, BulkAction, BulkActionTone } from './BulkActionShell'
export type { SortStackProps, SortFieldOption } from './SortStack'
export type { KeyboardShortcutsModalProps, ShortcutGroup, ShortcutRow } from './KeyboardShortcutsModal'
export type { LensTabsProps, LensTab } from './LensTabs'
export type { FilterPopoverProps, FilterDimension, FilterOption } from './FilterPopover'
export type { GridToolbarProps } from './GridToolbar'
export type { AnchoredPopoverProps } from './AnchoredPopover'
