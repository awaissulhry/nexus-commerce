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
 *
 * ── 🔴 RA.SPINE, 2026-08-12 — the SPINE moved out; this page's own params stayed ─────────────────
 *
 * `market` · `portfolio` · `campaign` · `line` and every rule about them (the `'all'` sentinel, the
 * mutual exclusion, "absent means the documented default", the round trip, the canonical rewrite)
 * now live in `_shared/adsScope.ts` — because eleven pages were each carrying their own copy, and
 * this file's copy was the one the shared module was generalised FROM.
 *
 * **Nothing about this page's behaviour changed**, which is the whole point: `urlState.vitest.test.ts`
 * is unmodified and still passes, and it is the proof rather than the intention. What is left here
 * is what is genuinely this page's — `weeks`, `month`, `metric`, `section`, `open` — and the two
 * hooks (`writeOwn` / `OWN_KEYS`) that carry them through a spine edit.
 *
 * ⚠ Those two hooks are not optional. A param the spine does not know about and the page does not
 * declare survives a page load and then vanishes the first time any control moves — the symptom
 * appears one interaction after the cause. Pinned in `adsScope.vitest.test.ts`.
 */

import {
  ALL_MARKETS, MARKETS as SPINE_MARKETS, MARKET_ANY,
  adsScopeNeedsNormalising, parseAdsScope, patchAdsScope, writeAdsScope,
  type AdsScopePolicy,
} from '../_shared/adsScope'

/** The four production Amazon Ads markets. `all` is the account-wide view and the default. */
export const MARKETS = SPINE_MARKETS
export const DEFAULT_MARKET = ALL_MARKETS

/**
 * What this page's URL carries, declared once.
 *
 * `date`, `sort`, `search`, `paged`, `row` and `drawers` are all absent, and that is deliberate:
 * every spine param past the four grains is opt-in, so adopting the shared module cannot give this
 * page a `?q=` or a `?sort=` it never had. Budget Pacing speaks whole WEEKS, not a date range —
 * see `DEFAULT_WEEKS` — so it takes no date policy at all.
 */
const POLICY: AdsScopePolicy = { market: MARKET_ANY }

/** This page's own params. The spine's normalisation check must count these too, or it loops. */
const OWN_KEYS = ['weeks', 'month', 'metric', 'section', 'open'] as const
/**
 * 🔴 Weeks, not days, and not a date range.
 *
 * `GET /advertising/dayparting/heatmap` speaks whole weeks so that every weekday carries an equal
 * number of samples, and it excludes the in-progress day. A `days` param would have to be
 * converted at the boundary and would quietly reintroduce the uneven-weekday bias the endpoint
 * exists to avoid. The sibling pages carry `?window=30d` for a rolling day count; this page
 * deliberately does not, because its window means something else.
 */
export const DEFAULT_WEEKS = 8
export const MIN_WEEKS = 1
export const MAX_WEEKS = 26
export const DEFAULT_METRIC = 'spend'

/**
 * 🔴 The MONEY window, and it is computed in UTC on purpose.
 *
 * This page has two windows and they are not the same thing: `weeks` is the PERFORMANCE window the
 * hourly cube speaks, and `month` is the MONEY window an `AdBudgetPlan` is keyed by. `weeks` lives
 * in the scope spine; `month` lives in the pinned band, because the band is the monthly-money
 * surface and already prints `day 12/31`.
 *
 * The default must be the month the SERVER thinks it is, not the month Rome thinks it is.
 * `ads-budget-manager.service.ts` derives everything from UTC — `currentMonth()` at :74 is
 * `getUTCFullYear()/getUTCMonth()`, and `dayOfMonth` at :70 is `now.getUTCDate()`. Between 00:00
 * and 02:00 Rome in summer, UTC is still the previous day, and on the 1st of a month that is a
 * different MONTH. A Rome-based default would ask for a month the server has no plan rows for and
 * render an empty band for two hours a night.
 *
 * Verified 2026-08-12 11:58 Rome = 09:58 UTC — same calendar day, so no divergence right now. The
 * window is narrow, not absent, and this is the cheap side to be correct on.
 */
export const currentMonthUTC = (): string => {
  const n = new Date()
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}`
}

/** `YYYY-MM`, months 01–12 only. `2026-13`, `2026-00`, `26-08` and `2026-8` are all rejected. */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** Step a `YYYY-MM` by whole months, without ever constructing a local-time date. */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number)
  const idx = y * 12 + (m - 1) + by
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
}

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
  /** `YYYY-MM`. Defaults to the CURRENT month in UTC — see `currentMonthUTC`. */
  month: string
  metric: BspMetric
  /** null when absent or unrecognised; a jump target, not persisted accordion state. */
  section: BspSection | null
  open: BspOpen | null
}

/**
 * Parse and normalise, in one pass, never throwing.
 *
 * The four grains — and the `'all'` sentinel, and the campaign-beats-portfolio rule that used to
 * sit here — come from `parseAdsScope`. What follows is this page's own vocabulary.
 */
export function parseUrlState(params: URLSearchParams): BspUrlState {
  const { market, portfolio, campaign, line } = parseAdsScope(params, POLICY)

  // Number('') is 0 and Number('abc') is NaN, so both the empty and the malformed case fall to the
  // default through the same guard. Non-integers ('8.5') are rejected rather than floored: the
  // endpoint counts whole weeks and a fractional one has no meaning to round toward.
  const weeksRaw = Number(params.get('weeks'))
  const weeks = Number.isInteger(weeksRaw) && weeksRaw >= MIN_WEEKS && weeksRaw <= MAX_WEEKS ? weeksRaw : DEFAULT_WEEKS

  // A malformed month falls back to the current one rather than throwing or rendering an empty
  // band. `?month=2026-13` is not a month; it is a typo, and the default view is the honest answer.
  const monthRaw = params.get('month')
  const month = monthRaw && MONTH_RE.test(monthRaw) ? monthRaw : currentMonthUTC()

  const metricRaw = params.get('metric') as BspMetric | null
  const metric = metricRaw && METRICS.includes(metricRaw) ? metricRaw : DEFAULT_METRIC

  const sectionRaw = params.get('section') as BspSection | null
  const section = sectionRaw && SECTIONS.includes(sectionRaw) ? sectionRaw : null

  return {
    market,
    portfolio,
    campaign,
    line,
    weeks,
    month,
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
  writeAdsScope(p, { ...s, preset: '', start: '', end: '', q: '', sort: '', dir: 'desc', page: 1, row: '', drawer: '' }, POLICY)
  writeOwn(p, s)
  return p.toString()
}

/**
 * This page's own params, written after the spine's so the key order is what it always was.
 *
 * Split out because it is needed twice — once from a parsed state (`serialiseUrlState`) and once
 * from raw params mid-patch (`writeOwnRaw`) — and two copies of "which of these is a default" is
 * exactly the drift this whole session exists to remove.
 */
function writeOwn(p: URLSearchParams, s: BspUrlState): void {
  if (s.weeks !== DEFAULT_WEEKS) p.set('weeks', String(s.weeks))
  if (s.month !== currentMonthUTC()) p.set('month', s.month)
  if (s.metric !== DEFAULT_METRIC) p.set('metric', s.metric)
  if (s.section) p.set('section', s.section)
  if (s.open) p.set('open', serialiseOpen(s.open))
}

/** The hook `patchAdsScope` and `adsScopeNeedsNormalising` call, so a spine edit keeps these five. */
const writeOwnRaw = (raw: URLSearchParams, out: URLSearchParams): void => writeOwn(out, parseUrlState(raw))

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
  // Round-trips through the parser so the address bar shows the form the page actually used. A
  // contradictory pair the operator typed by hand is normalised the moment they touch any control.
  return patchAdsScope(current, patch, POLICY, writeOwnRaw)
}

/**
 * True when the raw query string is not already in its canonical form.
 *
 * The page uses this to rewrite a hand-typed or stale URL once on mount. Compared as sorted
 * key/value pairs rather than as strings, so a merely reordered query — which is semantically
 * identical — does not trigger a navigation on every load.
 */
export function needsNormalising(current: URLSearchParams): boolean {
  return adsScopeNeedsNormalising(current, POLICY, OWN_KEYS, writeOwnRaw)
}
