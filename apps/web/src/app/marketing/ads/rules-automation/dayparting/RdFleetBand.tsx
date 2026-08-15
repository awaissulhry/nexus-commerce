'use client'

/**
 * RD.P1 — the fleet-state band: five tiles, each a filter onto the campaign grid.
 *
 * Counts and filters share ONE predicate (`_rd/tiles.ts`), so a tile always delivers exactly its
 * own number — the chip-count-vs-result divergence the bid facets paid for cannot start here.
 * Tiles overlap by design — the band reports STATES, not a partition, and the trailing note says
 * so. Clicking a tile switches to the campaign grain (the states are campaign facts) and filters;
 * clicking it again clears. Counts are CLOCK READINGS (min-bid and capped vary by hour) — they
 * inherit the page's database clock, same as the grid cells they summarise.
 *
 * There is deliberately NO "unscheduled" tile: those campaigns are not grid rows, so no grid
 * filter can deliver them, and the Coverage panel below already owns that number (spend-ranked,
 * server-computed). A second client-side count under the same word would be a second denominator
 * — the band links down instead.
 */
import { useMemo } from 'react'
import { useRdData } from './_rd/RdData'
import { useRdUrlState } from './_rd/useRdUrlState'
import { campaignMatchesScope } from './_rd/scope'
import { RD_TILE_KEYS, tileMatch, type RdTileKey } from './_rd/tiles'
import { RdSection } from './_rd/RdSection'

const TILE_LABEL: Record<RdTileKey, string> = {
  holding: 'Holding', chasing: 'Chasing', capped: 'Capped', blind: 'Blind', 'min-bid': 'At min bid now',
}
const TILE_TITLE: Record<RdTileKey, string> = {
  holding: 'Snap-and-hold: the multiplier is parked on its window value and no goal is being pursued.',
  chasing: 'A real closed loop — the engine is moving the multiplier toward a goal (all-out counts: its 900 ceiling still chases).',
  capped: 'The CPC ceiling, not the target, is deciding the placement right now.',
  blind: 'The controller reads a signal that is not there — no rank data, or these ASINs never appeared in Brand Analytics. Open-loop-by-design is NOT counted here.',
  'min-bid': 'Bids are floored at this hour while the campaign stays live. A clock reading — it changes when the window does.',
}

export function RdFleetBand() {
  const { campaigns, loading } = useRdData()
  const { state, set } = useRdUrlState()

  const inScope = useMemo(() => campaigns.filter((r) => campaignMatchesScope(r, state)), [campaigns, state])
  const counts = useMemo(
    () => Object.fromEntries(RD_TILE_KEYS.map((k) => [k, inScope.filter((r) => tileMatch(r, k)).length])) as Record<RdTileKey, number>,
    [inScope],
  )

  if (loading && inScope.length === 0) return null

  const click = (k: RdTileKey) => {
    const next = state.tile === k ? '' : k
    // The states are campaign facts, so a tile filters the CAMPAIGN grain; row selection clears
    // because a group id at one grain is not a campaign id at the other.
    set({ tile: next, grain: 'campaigns', row: '', drawer: '' })
  }

  return (
    <RdSection id="p1">
      <div className="rd-band" role="group" aria-label="Fleet state">
        {RD_TILE_KEYS.map((k) => (
          <button
            key={k}
            type="button"
            className={`rd-band-tile${state.tile === k ? ' on' : ''}${counts[k] === 0 ? ' zero' : ''}`}
            aria-pressed={state.tile === k}
            title={TILE_TITLE[k]}
            onClick={() => click(k)}
          >
            <b>{counts[k]}</b> {TILE_LABEL[k]}
          </button>
        ))}
        <span className="rd-band-note">
          states, not a partition — a campaign can sit in several · what no schedule covers is counted under{' '}
          <a href="#rd-p6">Coverage</a>
        </span>
      </div>
    </RdSection>
  )
}
