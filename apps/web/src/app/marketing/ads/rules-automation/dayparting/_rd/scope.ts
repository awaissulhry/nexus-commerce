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
import type { RdCampaignRow, RdGroupRow } from './types'

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
}

export const EMPTY_URL_STATE: RdUrlState = { ...EMPTY_SCOPE, grain: 'schedules', row: '', drawer: '', tile: '' }

const GRAINS = new Set(['schedules', 'campaigns'])

/** Read the whole page state out of the URL. Unknown values fall back rather than throwing. */
export function parseUrlState(sp: URLSearchParams | null): RdUrlState {
  const get = (k: string) => sp?.get(k)?.trim() ?? ''
  const grain = get('grain')
  return {
    market: get('market') || 'all',
    portfolio: get('portfolio'),
    product: get('product'),
    campaign: get('campaign'),
    grain: GRAINS.has(grain) ? (grain as RdUrlState['grain']) : 'schedules',
    row: get('row'),
    drawer: get('drawer'),
    tile: get('tile'),
  }
}

/**
 * Serialise state back to a query string, dropping everything at its default.
 *
 * Dropping defaults is what keeps a shared link readable and what stops the back button from
 * walking through states that never differed. `market=all` is a default, not a value.
 */
export function urlStateToQuery(state: RdUrlState): string {
  const sp = new URLSearchParams()
  if (!isAllMarkets(state.market)) sp.set('market', state.market)
  if (state.portfolio) sp.set('portfolio', state.portfolio)
  if (state.product) sp.set('product', state.product)
  if (state.campaign) sp.set('campaign', state.campaign)
  if (state.grain !== 'schedules') sp.set('grain', state.grain)
  if (state.row) sp.set('row', state.row)
  if (state.drawer) sp.set('drawer', state.drawer)
  if (state.tile) sp.set('tile', state.tile)
  return sp.toString()
}

// ── Matching ───────────────────────────────────────────────────────────────────────────────────

/**
 * Does this SCHEDULE belong in the current scope?
 *
 * Matches against the derived sets, so a group answers "yes" to a market, portfolio or line that
 * any of its member campaigns sits in. That is the only truthful answer for a row that aggregates
 * many campaigns: a schedule holding one DE campaign IS in DE, whatever its stored column says.
 */
export function groupMatchesScope(row: RdGroupRow, scope: RdScope): boolean {
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
