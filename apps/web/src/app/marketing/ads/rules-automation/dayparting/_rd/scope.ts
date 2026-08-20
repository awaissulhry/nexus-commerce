/**
 * RD.P0 — the scope contract.
 *
 *     market  ⊃  portfolio  ⊃  product line  ⊃  campaign
 *        IT       IT GALE JACKET    GALE         GALE | IT | Exact | Brand
 *
 * Four grains, most specific wins — the same precedence the engine already uses for
 * `targetOverrides`. Everything on the page obeys one scope and the scope lives in the URL.
 *
 * 🔴 **Scope is derived, never read off a stored column.** Measured on prod 2026-08-12
 * (`_rd-page-scope.mts`): `RankScheduleGroup.marketplace` is null on 9 of 16 groups, including two
 * that resolve to DE — so filtering on it would hide DE groups from a DE filter. Every grain here
 * matches against the derived sets on `RdGroupRow.scope`.
 *
 * **Most-specific-wins and AND agree here, and that is deliberate.** `resolveScopeReach()` on the
 * server ANDs the four dimensions; this module returns rows matching only the narrowest grain the
 * operator picked. The two give the same row set whenever the pickers cascade (a campaign chosen
 * inside a portfolio is already in that portfolio), and staying consistent with the resolver the
 * rule evaluator enforces with means this page cannot answer a different question from the gate.
 *
 * P0 ships this contract and the URL that carries it. It ships **no control** beyond the market
 * switch the header already renders — see `docs/2026-08-10-ra-session-locks.md` §4 for why the
 * fourth copy of the RA scope bar was not written here.
 */
import type { RdCampaignRow, RdGroupScope } from './types'

/** Which grain the operator picked, coarsest → narrowest. `market` is the header's switch. */
export interface RdScope {
  /** A marketplace code (`IT`), or '' / 'all' for every market. */
  market: string
  /** An EXTERNAL portfolio id, as carried by `Campaign.portfolioId` and `RankScheduleGroup.portfolioId`. */
  portfolio: string
  /** A `Product.id` — a parent is the whole line, a child is one variation. */
  product: string
  /** A local `Campaign.id`. */
  campaign: string
}

export const EMPTY_SCOPE: RdScope = { market: 'all', portfolio: '', product: '', campaign: '' }

/** Narrowest → coarsest. The first one set is the one that decides. */
const PRECEDENCE = ['campaign', 'product', 'portfolio', 'market'] as const
export type RdGrainKey = (typeof PRECEDENCE)[number]

/** True when a market value means "do not narrow". The header uses 'all'; a URL may omit it. */
export const isAllMarkets = (m: string): boolean => !m || m === 'all'

/**
 * The grain that actually binds — the narrowest one the operator picked.
 *
 * Named so the page can SAY it. A coarser pick left in place is not cleared (that would silently
 * rewrite the URL you are about to share); it just stops mattering, and the page owes the operator
 * that sentence rather than an unexplained row count.
 */
export function boundBy(scope: RdScope): RdGrainKey | null {
  for (const g of PRECEDENCE) {
    if (g === 'market' ? !isAllMarkets(scope.market) : scope[g]) return g
  }
  return null
}

/** The coarser grains the operator also picked that are no longer narrowing anything. */
export function overriddenGrains(scope: RdScope): RdGrainKey[] {
  const bound = boundBy(scope)
  if (!bound) return []
  const from = PRECEDENCE.indexOf(bound)
  return PRECEDENCE.slice(from + 1).filter((g) => (g === 'market' ? !isAllMarkets(scope.market) : !!scope[g]))
}

/** Human words for a grain, for the "this is what is deciding" note. */
export const GRAIN_LABEL: Record<RdGrainKey, string> = {
  campaign: 'campaign',
  product: 'product line',
  portfolio: 'portfolio',
  market: 'market',
}

// ── URL ────────────────────────────────────────────────────────────────────────────────────────
//
// One reader, one writer. Absent params mean "not narrowed", so a bare /dayparting is the whole
// account and every param below is optional — the page must never depend on a param existing.

export interface RdUrlState extends RdScope {
  /** Which grain the GRID is showing. P2 owns the control; P0 carries the value. */
  grain: 'schedules' | 'campaigns'
  /** The row the inspector is open on — a group id at schedules grain, a campaign id at campaigns. */
  row: string
  /** Which inspector tab. P3 owns the panel; the existing drawer already has these four tabs. */
  drawer: string
  /** Which fleet-state tile is filtering the grid. P1 owns the band; P0 carries the value. */
  tile: string
  /**
   * FB.3 — the campaigns grid's three filters, lifted into the URL.
   *
   * They were `AdsDataGrid`'s private state, in a panel below the census, while scope had no
   * control at all and the fleet tiles wrote `?tile=` from the band above it. That is three
   * control surfaces for one grid and two of them unlinkable. One bar now holds all of it, which
   * means one store, which means the URL. Comma-joined; `converge` is single-valued.
   */
  mode: string
  signal: string
  converge: string
  /**
   * FB.3c (2026-08-20) — the SCHEDULES grid's filters, lifted into the URL exactly as the campaigns
   * trio above was. They had stayed `AdsDataGrid` private state in a second "Filters" panel below
   * the fleet band — the duplicate bar the operator reported — because `tabs/RankGoalsList.tsx`
   * sits outside `dayparting/` and the FB.3 conversion never reached it. Comma-joined multiselects;
   * `status`/`windows` are single-valued.
   */
  status: string
  health: string
  baseline: string
  windows: string
  /** FB.3c — campaigns-grain additions: every one filters a fact the grid already renders. */
  fresh: string
  ceiling: string
  cstatus: string
  schedule: string
  /**
   * FB.3d (2026-08-21) — the page's date range, from the SHARED header picker (the Ad Manager's
   * dual-calendar + presets control), as local `YYYY-MM-DD` inclusive bounds. Supersedes the
   * short-lived `?weeks=` param (shipped the previous evening; no links carried it). Absent =
   * the default window (56 complete days ending yesterday — the old 8-week heatmap default).
   */
  from: string
  to: string
}

export const EMPTY_URL_STATE: RdUrlState = { ...EMPTY_SCOPE, grain: 'schedules', row: '', drawer: '', tile: '', mode: '', signal: '', converge: '', status: '', health: '', baseline: '', windows: '', fresh: '', ceiling: '', cstatus: '', schedule: '', from: '', to: '' }

const GRAINS = new Set(['schedules', 'campaigns'])

/**
 * FB.3 — where a state key and its URL param disagree.
 *
 * `product` is honest INSIDE this module (the value is a `Product.id`), but this was the only page
 * left spelling the grain `?product=` in the address bar while the other ten said `?line=`, so a
 * link could not be carried between them. The param moved; the field did not. `parseUrlState`
 * still READS the old spelling, so links already out there keep working, and `applyUrlState`
 * deletes it the first time anything moves — one grain, one param.
 */
const PARAM_OF: Partial<Record<keyof RdUrlState, string>> = { product: 'line' }
const paramFor = (k: keyof RdUrlState): string => PARAM_OF[k] ?? k

/** Read the whole page state out of the URL. Unknown values fall back rather than throwing. */
export function parseUrlState(sp: URLSearchParams | null): RdUrlState {
  const get = (k: string) => sp?.get(k)?.trim() ?? ''
  const grain = get('grain')
  return {
    market: get('market') || 'all',
    portfolio: get('portfolio'),
    product: get('line') || get('product'),
    campaign: get('campaign'),
    grain: GRAINS.has(grain) ? (grain as RdUrlState['grain']) : 'schedules',
    row: get('row'),
    drawer: get('drawer'),
    tile: get('tile'),
    mode: get('mode'),
    signal: get('signal'),
    converge: get('converge'),
    status: get('status'),
    health: get('health'),
    baseline: get('baseline'),
    windows: get('windows'),
    fresh: get('fresh'),
    ceiling: get('ceiling'),
    cstatus: get('cstatus'),
    schedule: get('schedule'),
    from: get('from'),
    to: get('to'),
  }
}

/** True when this key/value pair is the default and should be absent from the URL. */
function isDefault(key: keyof RdUrlState, value: string): boolean {
  if (key === 'market') return isAllMarkets(value)
  if (key === 'grain') return value === 'schedules'
  return !value
}

/**
 * Apply a patch to the current query string.
 *
 * Two rules, both of which matter more than they look:
 *
 * · **Defaults are deleted, not written.** `?market=all&grain=schedules` says nothing that a bare
 *   URL does not, and a link that carries them is harder to read and harder to trust. It also stops
 *   the history filling with states that never differed.
 * · **Unknown params survive.** This patches the params that are actually there rather than
 *   rebuilding from `RdUrlState`, so a param this module has never heard of — another section's,
 *   an analytics tag, something a later P-section adds — is not silently dropped by a filter click.
 */
export function applyUrlState(current: URLSearchParams, patch: Partial<RdUrlState>): string {
  const next = new URLSearchParams(current.toString())
  for (const [k, v] of Object.entries(patch) as Array<[keyof RdUrlState, string]>) {
    const param = paramFor(k)
    if (isDefault(k, v)) next.delete(param)
    else next.set(param, v)
    // The superseded spelling never survives a write, or the two would drift apart silently.
    if (param !== k) next.delete(k)
  }
  return next.toString()
}

/** Build a fresh query string for a link — a deep link into this page from somewhere else. */
export function urlStateToQuery(state: Partial<RdUrlState>): string {
  return applyUrlState(new URLSearchParams(), state)
}

// ── Matching ───────────────────────────────────────────────────────────────────────────────────

/**
 * Does this SCHEDULE belong in the current scope?
 *
 * Matches against the derived sets, so a group answers "yes" to a market, portfolio or line that
 * any of its member campaigns sits in. That is the only truthful answer for a row that aggregates
 * many campaigns: a schedule holding one DE campaign IS in DE, whatever its stored column says.
 */
export function groupMatchesScope(row: { scope: RdGroupScope }, scope: RdScope): boolean {
  switch (boundBy(scope)) {
    case 'campaign': return row.scope.campaignIds.includes(scope.campaign)
    case 'product': return row.scope.productLineIds.includes(scope.product)
    case 'portfolio': return row.scope.portfolioIds.includes(scope.portfolio)
    case 'market': return row.scope.marketplaces.includes(scope.market)
    default: return true
  }
}

/** Does this CAMPAIGN belong in the current scope? Scalars here — a campaign has one of each. */
export function campaignMatchesScope(row: RdCampaignRow, scope: RdScope): boolean {
  switch (boundBy(scope)) {
    case 'campaign': return row.campaignId === scope.campaign
    case 'product': return row.productLineIds.includes(scope.product)
    case 'portfolio': return row.portfolioId === scope.portfolio
    case 'market': return row.marketplace === scope.market
    default: return true
  }
}
