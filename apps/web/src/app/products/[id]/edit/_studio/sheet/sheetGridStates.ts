import { GridLoadingOverlay, GridNoRowsOverlay } from '@/design-system/grid/renderers/overlays'

/** Both information grids use the same Nexus overlays and product-row geometry. */
export const SHEET_STATE_OVERLAYS = {
  loadingOverlayComponent: GridLoadingOverlay,
  loadingOverlayComponentParams: { rowKind: 'media-line' },
  noRowsOverlayComponent: GridNoRowsOverlay,
} as const

export function sheetEmptyState(total: number, onClear: () => void, onReload: () => void) {
  return total > 0 ? {
    title: 'No matching products',
    message: 'Try a different search or clear the filters to show all products.',
    action: { label: 'Clear filters', onClick: onClear },
  } : {
    title: 'No products to show',
    message: 'This product group has no rows available in this scope.',
    action: { label: 'Reload', onClick: onReload },
  }
}
