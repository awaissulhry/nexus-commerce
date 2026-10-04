/**
 * RD.P1 — the fleet-state tiles, as ONE predicate shared by the band (which counts) and the
 * campaigns grid (which filters). Two copies of a tile's meaning is how a chip's count and its
 * result learn to disagree — the defect class the bid facets paid for.
 *
 * Tiles OVERLAP by design (a campaign can be Capped AND Holding); the band reports states, not a
 * partition. `unscheduled` is deliberately NOT here: those campaigns are not grid rows, so no
 * grid filter can deliver them — the Coverage panel (P6) owns that number and the band links down.
 * 2e (Owner D1 = A) — `chasing` and `blind` are gone: nothing chases a goal and no signal is read.
 */
import type { RdCampaignRow } from './types'

export type RdTileKey = 'holding' | 'capped' | 'min-bid'

export const RD_TILE_KEYS: readonly RdTileKey[] = ['holding', 'capped', 'min-bid']

/** URL guard: `?tile=` is free text; an unknown value must filter nothing, not blank the grid. */
export function isTileKey(v: string): v is RdTileKey {
  return (RD_TILE_KEYS as readonly string[]).includes(v)
}

export function tileMatch(r: RdCampaignRow, tile: RdTileKey): boolean {
  switch (tile) {
    case 'holding': return r.runtime.mode?.kind === 'holding'
    case 'capped': return r.runtime.ceiling?.binding === true
    case 'min-bid': return r.runtime.mode?.kind === 'min-bid'
  }
}
