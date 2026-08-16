/**
 * FB.3 — Rank & Dayparting's filter bar, defined once for the page that RENDERS it and the grid
 * that FILTERS with it.
 *
 * This page had three control surfaces for one grid and only one of them was linkable:
 *
 *   · the fleet band's five tiles, writing `?tile=` from above the grid;
 *   · `AdsDataGrid`'s own Mode / Convergence / Signal panel, in private state below the census;
 *   · the scope contract — `?portfolio=`, `?line=`, `?campaign=` — parsed, honoured, and rendering
 *     **no picker at all**, so the only way to narrow by portfolio was to type the URL by hand.
 *
 * Worse than the count: two of the three overlapped. A fleet tile reads `runtime.mode.kind`, which
 * is exactly what the Mode multiselect filters on, and `blind` reads `runtime.signal.kind`, which
 * is the Signal multiselect. Two stores for one predicate is how you get an empty grid under two
 * controls that both look live.
 *
 * One bar, one store, and the store is the URL.
 *
 * 🔴 The scope grains carry no `value` accessor — `campaignMatchesScope` applies them before the
 * grid sees a row, so an accessor would be a second, weaker copy of the page's scope contract. The
 * tile is the same: `tileMatch` is the predicate the BAND counts with, and a filter-shaped copy of
 * it would let a tile's number and its result disagree.
 */
import type { GridFilter } from '../../../campaigns/_grid/AdsDataGrid'
import type { FilterState } from '../../../campaigns/_grid/AdsDataGrid'
import { buildScopeFilters, scopeToFilterState, type ScopeOptionsPayload } from '../../_shared/scopeFilters'
import { RD_TILE_KEYS } from './tiles'
import type { RdCampaignRow } from './types'
import type { RdUrlState } from './scope'

const TILE_LABEL: Record<string, string> = {
  holding: 'Holding',
  chasing: 'Chasing',
  capped: 'Capped',
  blind: 'Blind',
  'min-bid': 'Min bid',
}

const words = (k: string) => k.replace(/-/g, ' ')

/**
 * The whole bar. At schedules grain only the scope grains apply — the other three read campaign
 * runtime, and a schedule is a roll-up of many campaigns with no single mode of its own.
 */
export function rdFilters({ options, url, campaigns, tileCounts }: {
  options: ScopeOptionsPayload | null
  url: RdUrlState
  campaigns: RdCampaignRow[]
  /** what each tile currently matches, from the band's own predicate */
  tileCounts: Record<string, number>
}): GridFilter[] {
  const scope = buildScopeFilters({
    options,
    market: url.market,
    value: { line: url.product, portfolio: url.portfolio, campaign: url.campaign },
    // This page resolves most-specific-wins itself (`boundBy` in `_rd/scope.ts`), and the market is
    // a grain here, so a bound market leaves all three of these narrowing nothing.
    boundBy: url.campaign ? 'campaign' : url.product ? 'line' : url.portfolio ? 'portfolio' : null,
  })

  if (url.grain !== 'campaigns') return scope

  const kinds = (pick: (r: RdCampaignRow) => string | undefined) =>
    [...new Set(campaigns.map(pick).filter(Boolean) as string[])].sort()

  return [
    ...scope,
    {
      key: '__tile', label: 'Fleet state', kind: 'select', wide: true, placeholder: 'Every state',
      options: RD_TILE_KEYS.map((k) => ({
        value: k, label: `${TILE_LABEL[k] ?? words(k)} (${tileCounts[k] ?? 0})`,
      })),
    },
    {
      key: '__mode', label: 'Mode', kind: 'multiselect', wide: true, placeholder: 'Any mode',
      options: kinds((r) => r.runtime.mode?.kind).map((k) => ({ value: k, label: words(k) })),
      value: (r) => (r as RdCampaignRow).runtime.mode?.kind ?? '',
    },
    {
      key: '__signal', label: 'Signal', kind: 'multiselect', wide: true, placeholder: 'Any signal',
      options: kinds((r) => r.runtime.signal?.kind).map((k) => ({ value: k, label: words(k) })),
      value: (r) => (r as RdCampaignRow).runtime.signal?.kind ?? '',
    },
    {
      key: '__converge', label: 'Convergence', kind: 'select', placeholder: 'Any',
      options: [
        { value: 'no', label: 'Cannot converge', title: 'This campaign cannot reach what it is being asked to hold.' },
        { value: 'yes', label: 'OK', title: 'Nothing is stopping this campaign from holding its target.' },
      ],
      value: (r) => ((r as RdCampaignRow).runtime.canConverge ? 'yes' : 'no'),
    },
  ]
}

/** The URL, as the bar's value. Multiselects come back as arrays, which is what `MultiSelect` needs. */
export function rdFilterState(url: RdUrlState): FilterState {
  const list = (v: string) => v.split(',').filter(Boolean)
  return {
    ...scopeToFilterState({ line: url.product, portfolio: url.portfolio, campaign: url.campaign }),
    __tile: url.tile,
    __mode: list(url.mode),
    __signal: list(url.signal),
    __converge: url.converge,
  }
}

/** The inverse: a bar change, as a patch for `useRdUrlState().set`. */
export function rdUrlPatch(next: Record<string, string>): Partial<RdUrlState> {
  return {
    product: next.__line ?? '',
    portfolio: next.__portfolio ?? '',
    campaign: next.__campaign ?? '',
    tile: next.__tile ?? '',
    mode: next.__mode ?? '',
    signal: next.__signal ?? '',
    converge: next.__converge ?? '',
  }
}
