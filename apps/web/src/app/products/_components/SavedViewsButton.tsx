/**
 * G.0 — re-export barrel. The implementation has moved to
 * @/app/_shared/grid-lens/SavedViewsButton so all consumers can
 * share it. This file keeps all original exports so existing
 * imports (ProductsWorkspace, OrdersWorkspace, etc.) continue to
 * work without any changes.
 */
export { SavedViewsButton } from '@/app/_shared/grid-lens/SavedViewsButton'
export type { SavedView, SavedViewsButtonProps } from '@/app/_shared/grid-lens/SavedViewsButton'
