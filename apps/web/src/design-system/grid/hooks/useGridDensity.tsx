'use client'

/**
 * GDS — the page's density, as a context.
 *
 * ONE vocabulary (compact / cozy / spacious — `tokens/grid.ts`) shared by the grid, the DS
 * `Thumbnail` and anything else that sizes itself to the row. A modal grid FOLLOWS its page: the
 * inventory editor opened from a Spacious products grid is Spacious, because it reads the same
 * context the page set. Nothing passes a density down by hand.
 *
 * The default is Spacious — the Owner's stated default for the products grid (2026-08-28) and
 * therefore the platform's. A page that wants Cozy or Compact says so on its provider.
 */
import { createContext, useContext, type ReactNode } from 'react'

import { gridDensity, type GridDensityName } from '../../tokens/grid'

export const DEFAULT_GRID_DENSITY: GridDensityName = 'spacious'

const GridDensityContext = createContext<GridDensityName>(DEFAULT_GRID_DENSITY)

export function GridDensityProvider({ value, children }: { value: GridDensityName; children: ReactNode }) {
  return <GridDensityContext.Provider value={value}>{children}</GridDensityContext.Provider>
}

/** The density in force here, and its numbers. */
export function useGridDensity(): GridDensityName {
  return useContext(GridDensityContext)
}

export function useGridDensityTier() {
  const density = useGridDensity()
  return { density, ...gridDensity[density] }
}
