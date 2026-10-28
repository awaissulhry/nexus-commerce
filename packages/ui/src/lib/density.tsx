'use client'

/**
 * DS — the page's density, as a context.
 *
 * ONE vocabulary (compact / cozy / spacious — `tokens/grid.ts`) shared by the grid, the DS
 * `Thumbnail` and anything else that sizes itself to the row. A modal grid FOLLOWS its page: the
 * inventory editor opened from a Spacious products grid is Spacious, because it reads the same
 * context the page set. Nothing passes a density down by hand.
 *
 * The default is Spacious — the Owner's stated default for the products grid (2026-08-28) and
 * therefore the platform's. A page that wants Cozy or Compact says so on its provider.
 *
 * ## Why it lives in `lib/` and not in `grid/`
 *
 * 🔴 It used to be `grid/hooks/useGridDensity`, and `components/Thumbnail` imported it from there —
 * a COMPONENTS → GRID dependency, which is backwards and had a consequence nobody could see:
 * `apps/factory` mirrors `components/` but has no `grid/` folder at all, so factory's `Thumbnail`
 * imported a path that does not exist and **has never compiled**. The fork-drift guard could not
 * see it either, because the two files were byte-identical — they were identically broken.
 *
 * `lib/` is the layer both sides already reach (PES.7 put `cdn-image.ts` here for the same reason),
 * so the dependency inverts by moving one file rather than by threading a prop through every
 * consumer — which would have cost `Thumbnail` the "a modal's thumbs follow the page with nothing
 * passed" behaviour its own documentation calls a feature.
 *
 * `grid/hooks/useGridDensity` re-exports this, so every existing importer and the grid barrel are
 * unchanged.
 *
 * ## The page density: standard / comfortable / floor (2026-10-28)
 *
 * A SECOND axis, kept apart from the grid's on purpose: the grid density is an operator's preference for a grid's ROWS;
 * the page density is how big a whole screen's controls, type and touch targets are, chosen by who uses the screen —
 * `standard` (the office console, the default), `comfortable` (portal and link pages, phone first) and `floor` (gloved
 * hands on a tablet). Values and reasons: `tokens/density.ts`.
 *
 * `DensityProvider` switches a subtree: it renders `data-density` on a `display: contents` wrapper (the CSS tokens
 * `--nds-density-*` follow it) and puts the name in a context (`useDensity`, `useDensityTokens` give TypeScript the
 * tier's px numbers, e.g. an icon's `size`). The two can never disagree inside the provider. A portal renders into
 * `<body>`, outside the wrapper: a screen that is all one tier also spreads `densityAttrs(tier)` on its root element.
 * Outside any provider the density is `standard`, and every token holds the console's sizes.
 */
import { createContext, useContext, type ReactNode } from 'react'

import { DEFAULT_DENSITY, densityAttrs, densityTokens, type DensityName } from '../tokens/density'
import { gridDensity, type GridDensityName } from '../tokens/grid'

export const DEFAULT_GRID_DENSITY: GridDensityName = 'spacious'

const GridDensityContext = createContext<GridDensityName>(DEFAULT_GRID_DENSITY)

export function GridDensityProvider({ value, children }: { value: GridDensityName; children: ReactNode }) {
  return <GridDensityContext.Provider value={value}>{children}</GridDensityContext.Provider>
}

/** The density in force here. */
export function useGridDensity(): GridDensityName {
  return useContext(GridDensityContext)
}

/** The density in force here, and its numbers. */
export function useGridDensityTier() {
  const density = useGridDensity()
  return { density, ...gridDensity[density] }
}

// The plain helpers live in `tokens/density.ts` (no 'use client'), so a SERVER component — a layout putting
// `densityAttrs('floor')` on `<html>` — imports them from there; re-exported here for client code.
export { DEFAULT_DENSITY, DENSITIES, densityAttrs, isDensityName, type DensityName } from '../tokens/density'

const DensityContext = createContext<DensityName>(DEFAULT_DENSITY)

const CONTENTS = { display: 'contents' } as const

/** Switches its children to a tier: the CSS tokens (`data-density`) and the context, together. */
export function DensityProvider({ value, children }: { value: DensityName; children: ReactNode }) {
  return (
    <DensityContext.Provider value={value}>
      <div {...densityAttrs(value)} style={CONTENTS}>
        {children}
      </div>
    </DensityContext.Provider>
  )
}

/** The page density in force here (`standard` outside any provider). */
export function useDensity(): DensityName {
  return useContext(DensityContext)
}

/** The page density in force here, and its numbers in px (`tokens/density.ts`). */
export function useDensityTokens() {
  const density = useDensity()
  return { density, ...densityTokens[density] }
}
