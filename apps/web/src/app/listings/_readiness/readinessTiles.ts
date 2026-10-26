/**
 * Listing readiness — the tiles above the grid (All · Blocked · Warnings · Ready · Not set up · Not computed).
 *
 * A tile counts LISTINGS (one product on one destination; its languages fold into one verdict). The numbers are the
 * API's `stats`, taken as they come: nothing here decides a verdict. Clicking a tile toggles the page's `state`.
 * Every word is the design system's (`readinessMeta(state, 'scope')`): one state, one name, as on the chips and in
 * the Fix window. Since 2026-10-26 the page shows one row (`rowReadinessTiles`); the other states are Filters › Readiness.
 *
 * Pure — no React — so the tile ⇄ state mapping is a test.
 */
import type { ReadinessStateCounts, ReadinessStateFilter } from '@nexus/shared/listing-readiness'
import { readinessMeta, type ReadinessTone } from '@/design-system/grid/renderers/readiness'

export type ReadinessTileKey = 'all' | 'blocked' | 'warn' | 'ready' | 'absent' | 'notComputed'
export const READINESS_TILES: readonly ReadinessTileKey[] = ['all', 'blocked', 'warn', 'ready', 'absent', 'notComputed']

export type ReadinessStats = ReadinessStateCounts & { all: number }

/** The tile a state lights. An older link's `notChecked` (both grey states at once) lights both grey tiles. */
export function tileIsLit(state: ReadinessStateFilter | '', tile: ReadinessTileKey): boolean {
  if (state === 'notChecked') return tile === 'absent' || tile === 'notComputed'
  return (state || 'all') === tile
}

/** A click: the lit tile turns off (back to All); any other tile turns on. */
export function stateForTile(current: ReadinessStateFilter | '', tile: ReadinessTileKey): ReadinessStateFilter | '' {
  if (tile === 'all' || tileIsLit(current, tile)) return ''
  return tile
}

export function tileCount(stats: ReadinessStats, tile: ReadinessTileKey): number {
  switch (tile) {
    case 'all': return stats.all
    case 'blocked': return stats.blocked
    case 'warn': return stats.warn
    case 'ready': return stats.ready
    case 'absent': return stats.absent
    case 'notComputed': return stats.notComputed
  }
}

/** The listings the grid shows under the current state — the toolbar's "… · 1,240 listings". */
export function listingsInView(stats: ReadinessStats, state: ReadinessStateFilter | ''): number {
  if (state === 'notChecked') return stats.absent + stats.notComputed
  return tileCount(stats, state || 'all')
}

export function tileLabel(tile: ReadinessTileKey): string {
  if (tile === 'all') return 'All'
  return readinessMeta(tile, 'scope').label
}

export function tileHint(tile: ReadinessTileKey): string {
  switch (tile) {
    case 'all': return 'listings'
    case 'blocked': return 'cannot publish'
    case 'warn': return 'may be rejected'
    case 'ready': return 'nothing blocking'
    case 'absent': return 'nothing set up yet'
    case 'notComputed': return 'checked within minutes'
  }
}

/** The tile's status dot: the readiness tone, and the brand colour for All (as the Products page's Total). */
export function tileTone(tile: ReadinessTileKey): ReadinessTone | 'primary' {
  if (tile === 'all') return 'primary'
  return readinessMeta(tile, 'scope').tone
}

const TONE_ACCENT: Record<ReadinessTone | 'primary', string> = {
  primary: 'var(--nds-primary)',
  danger: 'var(--nds-danger)',
  warning: 'var(--nds-warning)',
  success: 'var(--nds-success)',
  info: 'var(--nds-info)',
  neutral: 'var(--nds-text-3)',
}
export const tileAccent = (tile: ReadinessTileKey): string => TONE_ACCENT[tileTone(tile)]

/* ── One tile row (2026-10-26): the readiness tiles that stay in the row, and the Readiness filter ─────────────────── */

/**
 * The readiness tiles in the page's one row. With live data the row is All · Blocked · Warnings, then Live · Errors
 * (`ROW_LIVE_TILES`); without it (an older API, or a person without `listings.view`) the row keeps Ready and Not set up
 * instead. Every other state is the Filters bar's Readiness filter (`READINESS_FILTER_OPTIONS`).
 */
export function rowReadinessTiles(liveShown: boolean): ReadinessTileKey[] {
  return liveShown ? ['all', 'blocked', 'warn'] : ['all', 'blocked', 'warn', 'ready', 'absent']
}

/** Filters › Readiness: every state, in the design system's words; the same key (`state`) the tiles set. */
export function readinessFilterOptions(current: ReadinessStateFilter | ''): Array<{ value: string; label: string }> {
  const options = [
    { value: '', label: 'All' },
    ...(['blocked', 'warn', 'ready', 'absent', 'notComputed'] as const).map((state) => ({ value: state, label: readinessMeta(state, 'scope').label })),
  ]
  // An older link's `notChecked` (both grey states at once) stays readable until it is changed.
  return current === 'notChecked' ? [...options, { value: 'notChecked', label: 'Not set up or not computed' }] : options
}
