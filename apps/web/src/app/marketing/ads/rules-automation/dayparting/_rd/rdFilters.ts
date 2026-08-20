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
 * FB.3c — the shape a SCHEDULES-grain grid row must have for the schedule filters to read it.
 * Structural on purpose: the row type lives in `tabs/RankGoalsList.tsx` (outside this directory)
 * and importing it here would invert the dependency; any row carrying these four members filters
 * correctly, and TypeScript checks the fit at the grid's call site.
 */
export interface RdGoalsFilterRow { enabled: boolean; health: { tone: string }; baselineKey: string; windows: number }

/** One builder for the Baseline options, so the bar and the grid cannot list different sets. */
export function rdBaselineOptions(
  groups: Array<{ defaultTargetKey: string }>,
  targetName: (key: string) => string,
): Array<{ value: string; label: string }> {
  return [...new Set(groups.map((g) => g.defaultTargetKey).filter(Boolean))]
    .sort()
    .map((k) => ({ value: k, label: targetName(k) }))
}

/**
 * FB.3c — one flattener for a bar change → URL patch, exported because it was already copied once
 * (client + campaigns grid) and the schedules grid would have been the third copy.
 */
export function rdFlattenBarChange(next: Record<string, unknown>): Record<string, string> {
  const flat: Record<string, string> = {}
  for (const [k, v] of Object.entries(next)) flat[k] = Array.isArray(v) ? v.join(',') : typeof v === 'string' ? v : ''
  return flat
}

/**
 * The whole bar. At schedules grain the scope grains apply plus the schedule row's own facets
 * (Status · Health · Baseline · Windows); at campaigns grain the runtime facets. A facet appears
 * here only if the grid renders the fact it filters — a filter over an invisible fact is a control
 * whose result cannot be checked.
 */
export function rdFilters({ options, url, campaigns, tileCounts, baselineOptions = [] }: {
  options: ScopeOptionsPayload | null
  url: RdUrlState
  campaigns: RdCampaignRow[]
  /** what each tile currently matches, from the band's own predicate */
  tileCounts: Record<string, number>
  /** from `rdBaselineOptions` — only the schedules grain reads it */
  baselineOptions?: Array<{ value: string; label: string }>
}): GridFilter[] {
  const scope = buildScopeFilters({
    options,
    market: url.market,
    value: { line: url.product, portfolio: url.portfolio, campaign: url.campaign },
    // This page resolves most-specific-wins itself (`boundBy` in `_rd/scope.ts`), and the market is
    // a grain here, so a bound market leaves all three of these narrowing nothing.
    boundBy: url.campaign ? 'campaign' : url.product ? 'line' : url.portfolio ? 'portfolio' : null,
  })

  if (url.grain !== 'campaigns') {
    return [
      ...scope,
      {
        key: '__status', label: 'Status', kind: 'select', placeholder: 'Any status',
        options: [{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }],
        value: (r) => ((r as RdGoalsFilterRow).enabled ? 'active' : 'paused'),
      },
      // RDX/A3 — "show me only the schedules that are actually broken" is the first question this
      // page should answer, so health is filterable, not just visible.
      {
        key: '__health', label: 'Health', kind: 'multiselect', placeholder: 'Any health',
        options: [
          { value: 'bad', label: 'Writes failing' }, { value: 'warn', label: 'Needs attention' },
          { value: 'ok', label: 'OK' }, { value: 'muted', label: 'Idle' },
        ],
        value: (r) => (r as RdGoalsFilterRow).health.tone,
      },
      {
        key: '__baseline', label: 'Baseline', kind: 'multiselect', placeholder: 'Any baseline', wide: true,
        options: baselineOptions,
        value: (r) => (r as RdGoalsFilterRow).baselineKey,
      },
      // FB.3c — a schedule with no windows can NEVER act; that operational fact was a footnote in
      // a cell and is now a question the bar can answer directly.
      {
        key: '__windows', label: 'Windows', kind: 'select', placeholder: 'Any',
        options: [
          { value: 'with', label: 'Has windows' },
          { value: 'none', label: 'No windows', title: 'This schedule names no time windows, so it can never change anything.' },
        ],
        value: (r) => ((r as RdGoalsFilterRow).windows > 0 ? 'with' : 'none'),
      },
    ]
  }

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
    // FB.3c — the Signal column renders freshness (fresh · stale · never · none) and nothing could
    // filter on it; "show me the campaigns steering on stale data" is a one-click question now.
    {
      key: '__fresh', label: 'Signal freshness', kind: 'multiselect', placeholder: 'Any freshness',
      options: kinds((r) => r.runtime.signal?.freshness).map((k) => ({ value: k, label: words(k) })),
      value: (r) => (r as RdCampaignRow).runtime.signal?.freshness ?? '',
    },
    // FB.3c — the Ceiling column's three real states, filterable. `base-alone` (the base bid alone
    // is at or over the cap — the campaign cannot move at all) was previously reachable only by
    // SORTING the Ceiling column, which is what the retired ceilings section told you to do.
    {
      key: '__ceiling', label: 'Ceiling', kind: 'select', placeholder: 'Any',
      options: [
        { value: 'base-alone', label: 'Base at cap', title: 'The base bid alone is at or over the CPC ceiling — no window can push this campaign anywhere.' },
        { value: 'binding', label: 'Cap binding', title: 'The ceiling is currently clipping what a window asks for.' },
        { value: 'under', label: 'Under cap', title: 'A ceiling exists and is not in the way right now.' },
        { value: 'none', label: 'No ceiling' },
      ],
      value: (r) => {
        const c = (r as RdCampaignRow).runtime.ceiling
        if (!c) return 'none'
        return c.baseAlone ? 'base-alone' : c.binding ? 'binding' : 'under'
      },
    },
    // FB.3c — `Campaign.status` was fetched, typed, and never used by anything on the page.
    {
      key: '__cstatus', label: 'Campaign status', kind: 'select', placeholder: 'Any status',
      options: kinds((r) => r.status ?? undefined).map((k) => ({ value: k, label: k.charAt(0) + k.slice(1).toLowerCase() })),
      value: (r) => (r as RdCampaignRow).status ?? '',
    },
    // FB.3c — the Schedule column names the parent group; this filters by it. Searchable: the
    // account holds 16 schedules today and the list grows.
    {
      key: '__schedule', label: 'Schedule', kind: 'select', placeholder: 'Any schedule', wide: true, searchable: true,
      options: [...new Map(campaigns.filter((r) => r.groupId).map((r) => [r.groupId as string, r.groupName ?? r.groupId as string])).entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([value, label]) => ({ value, label })),
      value: (r) => (r as RdCampaignRow).groupId ?? '',
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
    __status: url.status,
    __health: list(url.health),
    __baseline: list(url.baseline),
    __windows: url.windows,
    __fresh: list(url.fresh),
    __ceiling: url.ceiling,
    __cstatus: url.cstatus,
    __schedule: url.schedule,
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
    status: next.__status ?? '',
    health: next.__health ?? '',
    baseline: next.__baseline ?? '',
    windows: next.__windows ?? '',
    fresh: next.__fresh ?? '',
    ceiling: next.__ceiling ?? '',
    cstatus: next.__cstatus ?? '',
    schedule: next.__schedule ?? '',
  }
}
