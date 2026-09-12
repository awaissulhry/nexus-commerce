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
/**
 * 🔴 ONE Customise dialog. This barrel used to export a 416-line Tailwind FORK of the DS
 * `PreferencesModal` (0 `--nds-*` tokens) under these exact names, so `PreferencesValue` was two
 * different types with one name and which one a file got depended on which barrel it reached for.
 * Six pages rendered the fork and no DS change — token, component or fix — could reach them: the
 * #293 column filter landed in the DS and none of them saw it. Re-pointed at the DS pattern and the
 * copy deleted (hub #309; the Owner's standing decision is one Customise dialog).
 *
 * The APIs were already compatible: `open` / `onClose` / `value` / `onConfirm` / `allColumns` /
 * `defaultVisible` / `sortFieldOptions` / `pageSizeChoices` / `title` / `workspaceSlot` match by
 * name and shape, and `PREFERENCES_DEFAULTS` was byte-identical. The DS type's extra fields are all
 * optional, so every existing call site type-checks unchanged.
 *
 * ONE difference, deliberately not carried over: the fork resolved a `labelKey` through the app's
 * i18n shim. The DS pattern is app-independent and must not import `@/lib/i18n`. Measured before
 * dropping it — of the six consumers only `/fulfillment/purchase-orders` sets `labelKey`, and in
 * English 10 of its 12 keys resolve to exactly the `label` beside them; the two that differ are
 * `select` and `actions`, whose `label` is empty and which now fall back to the column key in the
 * DS pattern. Italian chrome on these six is the real loss, and it is inert for this team
 * (operators read English, the locale defaults to `en`). Filed to the hub rather than buried.
 */
export { PreferencesModal, PREFERENCES_DEFAULTS } from '@/design-system/patterns'
export type { PreferencesModalProps, PreferencesValue, PreferencesColumnSpec } from '@/design-system/patterns'
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
export { default as MatrixSortPanel, type MatrixSortLevel, type MatrixSortField } from './MatrixSortPanel'
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
