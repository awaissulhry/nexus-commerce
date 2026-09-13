/**
 * Moved to `design-system/lib/density` so the DS's own components can reach it without depending on
 * the grid — see that file for why (`components/Thumbnail` imported this path, and `apps/factory`
 * has no `grid/` folder, so factory's Thumbnail never compiled).
 *
 * This re-export keeps the grid barrel and every existing importer unchanged.
 */
export { GridDensityProvider, useGridDensity, useGridDensityTier, DEFAULT_GRID_DENSITY } from '../../lib/density';
