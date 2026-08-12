/**
 * BSP.0 — the URL contract for Budget Pacing & Schedules, as a pure module.
 *
 * Every view on this page must be linkable, and an absent param must mean the default rather than
 * a stored preference — so a link renders the same view for whoever opens it. That much matches
 * the four sibling pages.
 *
 * What is different here, and why this is a module rather than ten `params.get()` calls inline:
 * this page's URL carries a **normalisation rule**, not just defaults. `portfolio` and `campaign`
 * are mutually exclusive, `weeks` is a bounded integer, and `open` is a typed pair. A malformed
 * value must render the default view rather than throw, and the address bar must be rewritten to
 * the form the page actually used — otherwise a shared link and the view it produces disagree, and
 * the operator has no way to tell which one is lying.
 *
 * Pure and React-free on purpose: every rule below is a case in `urlState.vitest.test.ts`. The
 * edge cases the brief asks for (`?weeks=abc`, `?weeks=999`, `?market=ZZ`, `?open=garbage`) are
 * cheaper to pin as assertions than to re-click on production after every later section lands.
 */

/** The four production Amazon Ads markets. `all` is the account-wide view and the default. */
export const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const
export const DEFAULT_MARKET = 'all'
export const DEFAULT_WEEKS = 8
export const MIN_WEEKS = 1
export const MAX_WEEKS = 26
export const DEFAULT_METRIC = 'spend'

/**
 * 🔴 Weeks, not days, and not a date range.
 *
 * `GET /advertising/dayparting/heatmap` speaks whole weeks so that every weekday carries an equal
 * number of samples, and it excludes the in-progress day. A `days` param would have to be
 * converted at the boundary and would quietly reintroduce the uneven-weekday bias the endpoint
 * exists to avoid. The sibling pages carry `?window=30d` for a rolling day count; this page
 * deliberately does not, because its window means something else.
 */
export type BspMetric = 'spend' | 'clicks' | 'impressions' | 'orders'
const METRICS: readonly BspMetric[] = ['spend', 'clicks', 'impressions', 'orders']

export type BspSection = 'binding' | 'hours' | 'schedules' | 'events' | 'ceilings' | 'log'
export const SECTIONS: readonly BspSection[] = ['binding', 'hours', 'schedules', 'events', 'ceilings', 'log']

export type BspOpenKind = 'plan' | 'schedule' | 'event' | 'campaign'
const OPEN_KINDS: readonly BspOpenKind[] = ['plan', 'schedule', 'event', 'campaign']

export interface BspOpen {
  kind: BspOpenKind
  id: string
}

export interface BspUrlState {
  market: string
  /** `''` means "not narrowed". Never the string `'all'` — that sentinel belongs to market alone. */
  portfolio: string
  campaign: string
  line: string
  weeks: number
  metric: BspMetric
  /** null when absent or unrecognised; a jump target, not persisted accordion state. */
  section: BspSection | null
  open: BspOpen | null
}

/** A grain value that is absent, empty or the `all` sentinel is "not narrowed". */
const grain = (v: string | null): string => (!v || v === 'all' ? '' : v)

/**
 * Parse and normalise, in one pass, never throwing.
 *
 * Ordering matters in exactly one place: `campaign` is resolved before `portfolio` is dropped, so
 * the mutual-exclusion rule can see both. Everything else is independent.
 */
export function parseUrlState(params: URLSearchParams): BspUrlState {
  const rawMarket = params.get('market')
  const market = rawMarket && (MARKETS as readonly string[]).includes(rawMarket) ? rawMarket : DEFAULT_MARKET

  const campaign = grain(params.get('campaign'))
  const portfolioRaw = grain(params.get('portfolio'))
  // 🔴 Mutually exclusive, and campaign wins. Under AND — which is what `ruleMatchesScope` does and
  // therefore what the reach count must mean — holding both is either redundant (the campaign is in
  // that portfolio, so the portfolio adds nothing) or contradictory (it is not, and nothing can
  // match). Campaign is the more specific of the two, so it is the one that survives.
  const portfolio = campaign ? '' : portfolioRaw

  // Number('') is 0 and Number('abc') is NaN, so both the empty and the malformed case fall to the
  // default through the same guard. Non-integers ('8.5') are rejected rather than floored: the
  // endpoint counts whole weeks and a fractional one has no meaning to round toward.
  const weeksRaw = Number(params.get('weeks'))
  const weeks = Number.isInteger(weeksRaw) && weeksRaw >= MIN_WEEKS && weeksRaw <= MAX_WEEKS ? weeksRaw : DEFAULT_WEEKS

  const metricRaw = params.get('metric') as BspMetric | null
  const metric = metricRaw && METRICS.includes(metricRaw) ? metricRaw : DEFAULT_METRIC

  const sectionRaw = params.get('section') as BspSection | null
  const section = sectionRaw && SECTIONS.includes(sectionRaw) ? sectionRaw : null

  return {
    market,
    portfolio,
    campaign,
    line: grain(params.get('line')),
    weeks,
    metric,
    section,
    open: parseOpen(params.get('open')),
  }
}

/**
 * `?open=<kind>:<id>` — a typed pair, because the rail shows four different kinds of thing and a
 * bare `?row=<id>` could not say which. Anything that is not `kind:non-empty-id` is dropped and the
 * rail stays closed; a malformed value must never render a rail titled after nothing.
 *
 * The id keeps every character after the FIRST colon, so an id containing one survives round-trip.
 */
export function parseOpen(raw: string | null): BspOpen | null {
  if (!raw) return null
  const at = raw.indexOf(':')
  if (at <= 0) return null
  const kind = raw.slice(0, at) as BspOpenKind
  const id = raw.slice(at + 1)
  if (!id || !OPEN_KINDS.includes(kind)) return null
  // A `plan:` rail is addressed by marketplace, so its id has to BE one — `plan:ZZ` would open a
  // rail for a market this account does not sell in.
  if (kind === 'plan' && !(MARKETS as readonly string[]).includes(id)) return null
  return { kind, id }
}

export const serialiseOpen = (o: BspOpen | null): string => (o ? `${o.kind}:${o.id}` : '')

/**
 * Serialise a normalised state back to a query string.
 *
 * Only non-defaults are written, so the canonical URL for the default view is the bare path. This
 * is what makes "absent = the default" hold in both directions: parse(serialise(x)) === x, and a
 * param that equals its default never appears to have been chosen.
 */
export function serialiseUrlState(s: BspUrlState): string {
  const p = new URLSearchParams()
  if (s.market !== DEFAULT_MARKET) p.set('market', s.market)
  if (s.portfolio) p.set('portfolio', s.portfolio)
  if (s.campaign) p.set('campaign', s.campaign)
  if (s.line) p.set('line', s.line)
  if (s.weeks !== DEFAULT_WEEKS) p.set('weeks', String(s.weeks))
  if (s.metric !== DEFAULT_METRIC) p.set('metric', s.metric)
  if (s.section) p.set('section', s.section)
  if (s.open) p.set('open', serialiseOpen(s.open))
  return p.toString()
}

/**
 * Apply a patch of raw string values to the current query string and return the normalised result.
 *
 * This is the single writer: every control on the page routes through it, so no control can put a
 * value into the URL that `parseUrlState` would then reject. Passing `''` clears a param.
 *
 * It returns the query string rather than navigating, so the caller owns the choice of
 * `push` vs `replace` and this stays testable without a router.
 *
 * 🔴 A note for BSP.1–.7: this re-serialises from the normalised state, so a param that is not in
 * `BspUrlState` is DROPPED the first time the operator touches any control. That is deliberate —
 * one module is the contract, and a param nobody declared cannot be one — but it means adding a
 * param to this page is two edits here (parse + serialise), not one `params.get()` in a section.
 */
export function patchUrlState(current: URLSearchParams, patch: Record<string, string>): string {
  const next = new URLSearchParams(current.toString())
  for (const [k, v] of Object.entries(patch)) {
    if (!v) next.delete(k)
    else next.set(k, v)
  }
  // Round-trip through the parser so the address bar shows the form the page actually used. A
  // contradictory pair the operator typed by hand is normalised the moment they touch any control.
  return serialiseUrlState(parseUrlState(next))
}

/**
 * True when the raw query string is not already in its canonical form.
 *
 * The page uses this to rewrite a hand-typed or stale URL once on mount. Compared as sorted
 * key/value pairs rather than as strings, so a merely reordered query — which is semantically
 * identical — does not trigger a navigation on every load.
 */
export function needsNormalising(current: URLSearchParams): boolean {
  const known = new Set(['market', 'portfolio', 'campaign', 'line', 'weeks', 'metric', 'section', 'open'])
  const mine = [...current.entries()].filter(([k]) => known.has(k))
  const canonical = [...new URLSearchParams(serialiseUrlState(parseUrlState(current))).entries()]
  const norm = (xs: Array<[string, string]>) => xs.map(([k, v]) => `${k}=${v}`).sort().join('&')
  return norm(mine) !== norm(canonical)
}
