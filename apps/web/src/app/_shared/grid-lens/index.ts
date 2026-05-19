/**
 * G.0 — grid-lens shared barrel.
 *
 * All public exports from the shared grid infrastructure.
 * Consumers: /products (and future pages).
 */

export { VirtualizedGrid, SearchContext, RiskFlaggedContext, ColumnResizeHandle } from './VirtualizedGrid'
export { SavedViewsButton } from './SavedViewsButton'
export { GridFooter } from './GridFooter'
export { ProductIdentityCell } from './ProductIdentityCell'
export type { GridLensColumn, GridLensRow } from './types'
export type { VirtualizedGridProps } from './VirtualizedGrid'
export type { SavedView } from './SavedViewsButton'
export type { ProductIdentityCellProps } from './ProductIdentityCell'
