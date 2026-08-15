/**
 * RD.P1 — the fleet-state tiles, as ONE predicate shared by the band (which counts) and the
 * campaigns grid (which filters). Two copies of a tile's meaning is how a chip's count and its
 * result learn to disagree — the defect class the bid facets paid for.
 *
 * Tiles OVERLAP by design (a campaign can be Capped AND Blind); the band reports states, not a
 * partition. `unscheduled` is deliberately NOT here: those campaigns are not grid rows, so no
 * grid filter can deliver them — the Coverage panel (P6) owns that number and the band links down.
 */
import type { RdCampaignRow } from './types'

export type RdTileKey = 'holding' | 'chasing' | 'capped' | 'blind' | 'min-bid'

export const RD_TILE_KEYS: readonly RdTileKey[] = ['holding', 'chasing', 'capped', 'blind', 'min-bid']

/** URL guard: `?tile=` is free text; an unknown value must filter nothing, not blank the grid. */
export function isTileKey(v: string): v is RdTileKey {
  return (RD_TILE_KEYS as readonly string[]).includes(v)
}

export function tileMatch(r: RdCampaignRow, tile: RdTileKey): boolean {
  switch (tile) {
    case 'holding': return r.runtime.mode?.kind === 'holding'
    // all-out CAN chase (ceiling 900 against floor 300 — PLC.1's correction: 33 of 33, not 29),
    // so it counts as chasing here rather than hiding behind its own word.
    case 'chasing': return r.runtime.mode?.kind === 'chasing' || r.runtime.mode?.kind === 'all-out'
    case 'capped': return r.runtime.ceiling?.binding === true
    // Blind = the controller reads a signal that is not there. `signal == null` would also sweep
    // in rows whose runtime never resolved, and `none-by-design` is a deliberate open loop — both
    // are different claims than blindness, so only the engine's own two blind kinds count.
    case 'blind': return r.runtime.signal?.kind === 'no-signal' || r.runtime.signal?.kind === 'no-coverage'
    case 'min-bid': return r.runtime.mode?.kind === 'min-bid'
  }
}
