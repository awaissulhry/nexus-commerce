/**
 * Listing readiness — the tiles above the grid (All · Blocked · Warnings · Ready · Not checked).
 *
 * A tile counts LISTINGS (one product on one destination; its languages fold into one verdict). The numbers are the
 * API's `stats`, taken as they come: nothing here decides a verdict. Clicking a tile toggles the page's `state`.
 * The words for Blocked, Warnings and Ready are the design system's (`readinessMeta(state, 'scope')`).
 *
 * Pure — no React — so the tile ⇄ state mapping is a test.
 */
import type { ReadinessStateCounts, ReadinessStateFilter } from '@nexus/shared/listing-readiness'
import { readinessMeta, type ReadinessTone } from '@/design-system/grid/renderers/readiness'

export type ReadinessTileKey = 'all' | 'blocked' | 'warn' | 'ready' | 'notChecked'
export const READINESS_TILES: readonly ReadinessTileKey[] = ['all', 'blocked', 'warn', 'ready', 'notChecked']

export type ReadinessStats = ReadinessStateCounts & { all: number }

/** The tile a state lights. An older link's `absent` or `notComputed` sits under Not checked. */
export function tileOfState(state: ReadinessStateFilter | ''): ReadinessTileKey {
  switch (state) {
    case '': return 'all'
    case 'blocked': return 'blocked'
    case 'warn': return 'warn'
    case 'ready': return 'ready'
    case 'notChecked':
    case 'absent':
    case 'notComputed': return 'notChecked'
  }
}

/** A click: the lit tile turns off (back to All); any other tile turns on. */
export function stateForTile(current: ReadinessStateFilter | '', tile: ReadinessTileKey): ReadinessStateFilter | '' {
  if (tile === 'all' || tileOfState(current) === tile) return ''
  return tile
}

export function tileCount(stats: ReadinessStats, tile: ReadinessTileKey): number {
  switch (tile) {
    case 'all': return stats.all
    case 'blocked': return stats.blocked
    case 'warn': return stats.warn
    case 'ready': return stats.ready
    case 'notChecked': return stats.absent + stats.notComputed
  }
}

/** The listings the grid shows under the current state — the toolbar's "… · 1,240 listings". */
export function listingsInView(stats: ReadinessStats, state: ReadinessStateFilter | ''): number {
  if (state === 'absent') return stats.absent
  if (state === 'notComputed') return stats.notComputed
  return tileCount(stats, tileOfState(state))
}

export function tileLabel(tile: ReadinessTileKey): string {
  if (tile === 'all') return 'All'
  if (tile === 'notChecked') return 'Not checked'
  return readinessMeta(tile, 'scope').label
}

export function tileHint(tile: ReadinessTileKey): string {
  switch (tile) {
    case 'all': return 'listings'
    case 'blocked': return 'cannot publish'
    case 'warn': return 'may be rejected'
    case 'ready': return 'nothing blocking'
    case 'notChecked': return 'not set up or not computed'
  }
}

/** The tile's status dot: the readiness tone, and the brand colour for All (as the Products page's Total). */
export function tileTone(tile: ReadinessTileKey): ReadinessTone | 'primary' {
  if (tile === 'all') return 'primary'
  if (tile === 'notChecked') return readinessMeta('notComputed', 'scope').tone
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
