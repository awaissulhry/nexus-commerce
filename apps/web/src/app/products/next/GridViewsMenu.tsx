/**
 * Moved into the design system (`design-system/grid/toolbars/GridViewsMenu`) by PES.2, where every
 * rebuilt surface can reach it — it was always generic over `GridStateApi` and never page-shaped,
 * so a second copy per lane was a fork waiting to happen.
 *
 * This re-export keeps `ProductsNextClient`'s import path and this page's behaviour unchanged; the
 * DS component adds an optional `presets` section that this page does not pass.
 */
export { GridViewsMenu, type GridViewsMenuProps } from '@/design-system/grid'
