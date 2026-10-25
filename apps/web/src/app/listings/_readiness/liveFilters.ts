/**
 * Listings — the live tiles and the live filters (step 3 of docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md).
 *
 * A second group of tiles after the readiness ones: Live · Errors · Suppressed · Out of sync. They count LISTINGS ON
 * THE CHANNEL (the API's `liveStats`: `ChannelListing` rows, the menu badge's unit), not the readiness listings (one
 * product on one destination), so each tile's hint says its unit. A click toggles the page's live filter, as a
 * readiness tile toggles `state`: Live → `live=active`; Errors, Suppressed and Out of sync → `flags=<flag>`, one at a
 * time (Stock's `lowStock` stays).
 *
 * The Filters panel adds Channel state (the design system's selling words: Active · Inactive · Not listed · Ended ·
 * Unknown; Not listed takes drafts too, as the product sheet says them) and Stock (Low stock).
 *
 * Pure — no React — so every tile ⇄ filter mapping is a test.
 */
import {
  READINESS_LIVE_FLAGS,
  READINESS_LIVE_STATES,
  type ReadinessLiveCounts,
  type ReadinessLiveFlag,
  type ReadinessLiveState,
} from '@nexus/shared/listing-readiness'
import { SELLING_STATE_WORD } from '@/design-system/grid/renderers/sellingStatus'

import { SUPPRESSED_WORD } from './liveMarks'
import { knownValues, type ReadinessPageQuery } from './readinessQuery'

/* ── The tiles ────────────────────────────────────────────────────────────────────────────────────────────────────── */

export type LiveTileKey = 'live' | 'error' | 'suppressed' | 'outOfSync'
export const LIVE_TILES: readonly LiveTileKey[] = ['live', 'error', 'suppressed', 'outOfSync']

/** The flags the tiles own; one at a time. */
const TILE_FLAGS: readonly ReadinessLiveFlag[] = ['error', 'suppressed', 'outOfSync']

type LiveFilters = Pick<ReadinessPageQuery, 'live' | 'flags'>

export function liveTileLabel(tile: LiveTileKey): string {
  switch (tile) {
    case 'live': return 'Live'
    case 'error': return 'Errors'
    case 'suppressed': return SUPPRESSED_WORD
    case 'outOfSync': return 'Out of sync'
  }
}

/** The unit every live tile counts: listings on the channel, not readiness listings. */
export const LIVE_TILE_HINT = 'listings on the channel'

export function liveTileCount(stats: ReadinessLiveCounts, tile: LiveTileKey): number {
  switch (tile) {
    case 'live': return stats.active
    case 'error': return stats.error
    case 'suppressed': return stats.suppressed
    case 'outOfSync': return stats.outOfSync
  }
}

/** Live is lit while the page shows Active listings only; a flag tile while its flag filters. */
export function liveTileIsLit(filters: LiveFilters, tile: LiveTileKey): boolean {
  if (tile === 'live') return filters.live.length === 1 && filters.live[0] === 'active'
  return filters.flags.includes(tile)
}

/** A click: the lit tile turns off; another turns on (a flag tile replaces the other tile flag). Back to page 1. */
export function withLiveTile(query: ReadinessPageQuery, tile: LiveTileKey): ReadinessPageQuery {
  const lit = liveTileIsLit(query, tile)
  if (tile === 'live') return { ...query, live: lit ? [] : ['active'], page: 1 }
  const others = query.flags.filter((flag) => !TILE_FLAGS.includes(flag))
  return { ...query, flags: knownValues(lit ? others : [...others, tile], READINESS_LIVE_FLAGS), page: 1 }
}

const ACCENT: Record<LiveTileKey, string> = {
  live: 'var(--nds-success)',
  error: 'var(--nds-danger)',
  suppressed: 'var(--nds-danger)',
  outOfSync: 'var(--nds-warning)',
}
export const liveTileAccent = (tile: LiveTileKey): string => ACCENT[tile]

/* ── Filters › Channel state ──────────────────────────────────────────────────────────────────────────────────────── */

/** One choice, the design system's word, and the live states it stands for. */
export interface ChannelStateOption { value: string; label: string; states: readonly ReadinessLiveState[] }

export const CHANNEL_STATE_OPTIONS: readonly ChannelStateOption[] = [
  { value: 'active', label: SELLING_STATE_WORD.active, states: ['active'] },
  { value: 'paused', label: SELLING_STATE_WORD.paused, states: ['paused'] },
  // A draft (never sent) reads Not listed, as on the product sheet: one choice for both.
  { value: 'not_listed', label: SELLING_STATE_WORD.not_listed, states: ['draft', 'not_listed'] },
  { value: 'ended', label: SELLING_STATE_WORD.ended, states: ['ended'] },
  { value: 'unknown', label: SELLING_STATE_WORD.unknown, states: ['unknown'] },
]

/** The choices the page's `live` lights: a choice is ticked when any of its states filters. */
export function channelStatesOf(filters: LiveFilters): string[] {
  return CHANNEL_STATE_OPTIONS.filter((option) => option.states.some((state) => filters.live.includes(state))).map((option) => option.value)
}

/** The ticked choices → the page's `live`, in the API's order. Back to page 1. */
export function withChannelStates(query: ReadinessPageQuery, values: readonly string[]): ReadinessPageQuery {
  const states = CHANNEL_STATE_OPTIONS.filter((option) => values.includes(option.value)).flatMap((option) => option.states)
  return { ...query, live: knownValues(states, READINESS_LIVE_STATES), page: 1 }
}

/* ── Filters › Stock ──────────────────────────────────────────────────────────────────────────────────────────────── */

export const STOCK_OPTIONS: ReadonlyArray<{ value: '' | 'lowStock'; label: string }> = [
  { value: '', label: 'All stock' },
  { value: 'lowStock', label: 'Low stock' },
]

export const stockOf = (filters: LiveFilters): '' | 'lowStock' => (filters.flags.includes('lowStock') ? 'lowStock' : '')

/** Stock › Low stock adds the `lowStock` flag; All stock takes it away. The tiles' flag stays. Back to page 1. */
export function withStock(query: ReadinessPageQuery, value: string): ReadinessPageQuery {
  const others = query.flags.filter((flag) => flag !== 'lowStock')
  return { ...query, flags: knownValues(value === 'lowStock' ? [...others, 'lowStock'] : others, READINESS_LIVE_FLAGS), page: 1 }
}
