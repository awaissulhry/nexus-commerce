/**
 * The page's density vocabulary — the DS grid's own (`tokens/grid.ts`): Compact / Cozy / Spacious
 * mean the same row, header and thumbnail on the products grid, in the inventory editor and in
 * every other grid on the platform. The page keeps only the control's options and its default.
 */
import type { GridDensityName } from '@/design-system/tokens/grid'

export type DensityMode = GridDensityName

/**
 * The default density is SPACIOUS (85px rows, 56px thumbnail) — the Owner's call, stated
 * 2026-08-28 after Cozy was proposed on the strength of the reference products' 56–68px rows.
 * Cozy and Compact stay one click away, and a saved view remembers the choice.
 */
export const DEFAULT_DENSITY: DensityMode = 'spacious'
