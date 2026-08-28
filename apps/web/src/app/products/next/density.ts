/**
 * The page's density tiers — ONE definition, shared by the products grid and the inventory
 * editor, so Compact / Cozy / Spacious mean the same row, header and thumbnail in both.
 */
import type { Density } from '@/app/_shared/grid-lens'
import type { SegmentedOption } from '@/design-system/primitives'

export type DensityMode = 'compact' | 'cozy' | 'spacious'

export const DENSITY_OPTIONS: SegmentedOption[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'cozy', label: 'Cozy' },
  { value: 'spacious', label: 'Spacious' },
]

/**
 * The default density is SPACIOUS (85px rows, 56px thumbnail) — the Owner's call, stated
 * 2026-08-28 after Cozy was proposed on the strength of the reference products' 56–68px rows.
 * Cozy and Compact stay one click away, and a saved view remembers the choice.
 */
export const DEFAULT_DENSITY: DensityMode = 'spacious'

/**
 * Row height per density — MEASURED off the live /products/next on 2026-08-28, density by
 * density, not derived:
 *
 *   density    live row   thumb   td padding
 *   spacious     85.0      56      14px
 *   cozy         68.0      40      11px 14px
 *   compact      51.5      32       5px 9px
 *
 * Passed as AG's own `rowHeight`, which wins over the engine's text-row tier — a page with
 * taller cells says so; the engine does not guess. Compact rounds 51.5 up: AG virtualises off an
 * integer row height. Data rows share one height per density; the family footer is the one
 * other height (48px — a data-row-tall footer read as a hole in the list), so the page uses a
 * `getRowHeight` function. AG #203 is the consequence: SSRM cannot combine a dynamic row height
 * with block purging, so `maxBlocksInCache` is deliberately NOT set — set both and AG warns on
 * mount and disables purging anyway. `maxBlocksInCache` is initial-only, so a hot-reloaded tab
 * can show #203 after an edit that removed it; a fresh load does not. Every filter change purges
 * the cache explicitly.
 */
export const DENSITY_ROW_PX: Record<DensityMode, number> = { compact: 52, cozy: 68, spacious: 85 }

/** The engine's size tier per density: header height and cell padding. */
export const GRID_SIZE: Record<DensityMode, 'xs' | 'md' | 'lg'> = { compact: 'xs', cozy: 'md', spacious: 'lg' }

/** The shared Thumbnail's size tier per density (compact 32 / comfortable 40 / spacious 56). */
export function mapDensity(d: DensityMode): Density {
  if (d === 'compact') return 'compact'
  if (d === 'spacious') return 'spacious'
  return 'comfortable' // 'cozy' → 'comfortable'
}

/** The thumbnail's pixel size per density, for a column that must make room for it. */
export const THUMB_PX: Record<DensityMode, number> = { compact: 32, cozy: 40, spacious: 56 }
