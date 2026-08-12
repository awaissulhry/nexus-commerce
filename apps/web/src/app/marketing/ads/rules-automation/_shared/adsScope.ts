/**
 * RA.SPINE S1 — the ONE URL/scope contract for the eleven Rules & Automation pages.
 *
 * This is an EXTRACTION, not a new design. Every rule below already existed on at least one page;
 * what did not exist was one copy of it. Measured on this tree, 2026-08-12:
 *
 *   · **nine `DEFAULT_MARKET` declarations across eight files**, plus `AutomationsClient.tsx:61`
 *     and `RulesAutomationClient.tsx:100` holding market in `useState` with no URL backing at all.
 *     Eleven declarations, ten files, three of them not linkable.
 *   · **four client-side copies of the reach intersection** (`automations/ScopeForm.tsx:93`,
 *     `bid/BidScopeBar.tsx`, `budget/BudgetScopeBar.tsx`, `placement/PlacementScopeBar.tsx`)
 *     against one server `resolveScopeReach`.
 *   · **one page** — `placement/PlacementClient.tsx` — with the date discipline right.
 *
 * The shape is taken wholesale from `budget-schedules/urlState.ts`, which is the most developed
 * URL model in the section: **pure and React-free on purpose**, so every rule is a case in
 * `adsScope.vitest.test.ts` rather than a click on production. `useAdsScope.ts` is the thin hook
 * on top; it holds no rules of its own.
 *
 * ── 🔴 The one thing this module does NOT do ────────────────────────────────────────────────────
 *
 * **It does not own the market default.** Seven pages default to `'all'` and two — Keyword Tracker
 * and Share of Voice — default to `'IT'`, and *the two `'IT'` pages are right*. Share of Voice's own
 * header says why: an account-wide share number is meaningless, so a market has to exist before the
 * page has a subject. Flattening the nine into one default would break the two that are correct.
 *
 * So: **the module owns the mechanism and the URL contract; the PAGE declares its market policy.**
 * A page states whether `'all'` is meaningful for it and what an absent param means; this file
 * enforces the parse, the normalisation, the round-trip and the sentinel. See `MarketPolicy`.
 *
 * ── The rules, and where each came from ─────────────────────────────────────────────────────────
 *
 *  1. **The sentinel is the string `'all'`, and it belongs to `market` alone.** Every other grain
 *     uses `''` for "not narrowed" (`budget-schedules/urlState.ts:86`). The reverted RA scope bar
 *     used `''` for market and would have emitted `?marketplace=all`, filtering to a marketplace of
 *     that literal name: **zero rows, no error.**
 *  2. **An absent param means a documented default, never a stored preference** — a link must
 *     render the same view for whoever opens it. `market` is the one deliberate exception, and it
 *     resolves against the page's declared fallback, not against `localStorage` (see
 *     `MarketplaceContext.scopeMarket`, which a page may pass in as its fallback if it wants that).
 *  3. **A malformed value renders the default and rewrites the address bar** to the form the page
 *     actually used. `?market=ZZ`, `?dir=sideways`, `?page=-4` must never throw and must never
 *     leave a URL that disagrees with the view it produced.
 *  4. **`portfolio` and `campaign` are mutually exclusive; the other grains AND.** A campaign has
 *     at most one portfolio, so holding both is redundant or contradictory. The AND is not a choice
 *     — it is what `apps/api/src/services/automation-rule-scope.ts:ruleMatchesScope` enforces, so
 *     any other combinator would make the preview disagree with enforcement.
 *  5. **The server owns the date vocabulary.** See `PICKER_TO_SERVER` — the mismatch is worse than
 *     the spec knew.
 *
 * ── What a page composes ────────────────────────────────────────────────────────────────────────
 *
 * The spine handles the spine. A page's own params stay on the page: it calls `parseAdsScope` and
 * then reads its own, and `writeAdsScope` and then writes its own. Each spine param past the four
 * grains is **opt-in through the policy**, so adopting this module cannot add a param a page did
 * not already have — which is the whole of "extraction preserves behaviour".
 */

/** The four production Amazon Ads markets. IE/NL/PL/SE/UK are sandbox and cannot be a scope. */
export const MARKETS = ['IT', 'DE', 'ES', 'FR'] as const
export type Market = (typeof MARKETS)[number]

/**
 * 🔴 The market sentinel, and the only place in the section this string is a legal value.
 *
 * A grain uses `''`. Writing `'all'` into `?portfolio=` would ask the server for a portfolio whose
 * external id is the literal text "all" — which returns nothing and reports no error.
 */
export const ALL_MARKETS = 'all'

/**
 * What `'all'` means on THIS page, and what an absent `?market=` falls back to.
 *
 * `allowAll: false` is not a restriction the substrate imposes — it is a page telling the truth
 * about its own subject. Keyword Tracker and Share of Voice both derive a share from
 * `SearchQueryPerformance`, which is reported per marketplace; summing four markets into one
 * "share" produces a number that is not a share of anything.
 */
export interface MarketPolicy {
  allowAll: boolean
  /** Must itself satisfy `allowAll`. A page passing `{allowAll:false, fallback:'all'}` is a bug. */
  fallback: string
}

/** Seven of the nine pages. An account-wide view is a legitimate answer here. */
export const MARKET_ANY: MarketPolicy = { allowAll: true, fallback: ALL_MARKETS }
/** Keyword Tracker and Share of Voice. A market must exist before the page has a subject. */
export const marketOne = (fallback: string = 'IT'): MarketPolicy => ({ allowAll: false, fallback })

export interface SortPolicy {
  /** The only keys `?sort=` may hold. Anything else falls back to `key`. */
  keys: readonly string[]
  key: string
  dir: 'asc' | 'desc'
}

export interface DatePolicy {
  /** A server `RangePreset` key. `?preset=` absent means this. */
  preset: string
}

/**
 * Which spine params this page carries. Everything past the four grains is opt-in, so a page
 * adopting the module gains no param it did not already have.
 */
export interface AdsScopePolicy {
  market: MarketPolicy
  /** null when the page has no date control — Budget Pacing speaks whole weeks, not a range. */
  date?: DatePolicy | null
  /** null when the page's grid sort is not URL-backed. */
  sort?: SortPolicy | null
  /** `?q=` — a search term the page filters on. */
  search?: boolean
  /** `?page=` — 1-based. */
  paged?: boolean
  /** `?row=` — the inspected row. */
  row?: boolean
  /** `?drawer=` — a named side panel. The page owns the vocabulary; this only carries the string. */
  drawers?: readonly string[] | null
}

export interface AdsScope {
  /** `'all'` or a `Market`, per the page's policy. Never `''`. */
  market: string
  /** `''` means "not narrowed". Never `'all'` — that sentinel belongs to market alone. */
  portfolio: string
  campaign: string
  /** A `Product.id`: a parent (the line, 13 of them) or a child (one variation). */
  line: string
  /** A server `RangePreset` key, or `'custom'` with `start`/`end`. `''` when the page has no dates. */
  preset: string
  start: string
  end: string
  q: string
  sort: string
  dir: 'asc' | 'desc'
  /** 1-based. 1 is the default and is never written. */
  page: number
  row: string
  drawer: string
}

/** A grain value that is absent, empty, or carrying market's sentinel by mistake, is "not narrowed". */
const grain = (v: string | null): string => (!v || v === ALL_MARKETS ? '' : v)

const YMD_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/**
 * Parse and normalise the spine, in one pass, never throwing.
 *
 * Ordering matters in exactly one place: `campaign` is resolved before `portfolio` is dropped, so
 * the mutual-exclusion rule can see both. Everything else is independent.
 */
export function parseAdsScope(params: URLSearchParams, policy: AdsScopePolicy): AdsScope {
  const rawMarket = params.get('market')
  const marketOk =
    rawMarket != null
    && ((policy.market.allowAll && rawMarket === ALL_MARKETS) || (MARKETS as readonly string[]).includes(rawMarket))
  const market = marketOk ? rawMarket! : policy.market.fallback

  const campaign = grain(params.get('campaign'))
  // 🔴 Mutually exclusive, and campaign wins. Under AND — which is what `ruleMatchesScope` does and
  // therefore what any reach count must mean — holding both is either redundant (the campaign is in
  // that portfolio, so the portfolio adds nothing) or contradictory (it is not, and nothing can
  // match). Campaign is the more specific of the two, so it is the one that survives.
  const portfolio = campaign ? '' : grain(params.get('portfolio'))

  // Dates. A custom range needs BOTH ends and both must be real dates; a half-custom range falls
  // back to the preset rather than rendering a window with one open end.
  let preset = ''
  let start = ''
  let end = ''
  if (policy.date) {
    const rawPreset = params.get('preset') ?? policy.date.preset
    const rawStart = params.get('start') ?? ''
    const rawEnd = params.get('end') ?? ''
    if (rawPreset === 'custom' && YMD_RE.test(rawStart) && YMD_RE.test(rawEnd)) {
      preset = 'custom'
      // A reversed range is a typo, not a query. Swapping is the only reading that renders anything.
      if (rawStart > rawEnd) { start = rawEnd; end = rawStart } else { start = rawStart; end = rawEnd }
    } else {
      // 🔴 Deliberately NOT validated against a preset allowlist. `RangePreset` is the SERVER's
      // vocabulary and it has thirteen members; hard-coding them here would be a second copy that
      // drifts the next time one is added. An unknown key reaches `resolveRange`'s `default:`
      // branch and returns a windowDays fallback — wrong, but the picker cannot produce one, and
      // `datePatchFromPicker` is the only thing in this section allowed to write the param.
      preset = rawPreset === 'custom' ? policy.date.preset : rawPreset
    }
  }

  let sort = ''
  let dir: 'asc' | 'desc' = 'desc'
  if (policy.sort) {
    const rawSort = params.get('sort') ?? ''
    sort = policy.sort.keys.includes(rawSort) ? rawSort : policy.sort.key
    const rawDir = params.get('dir')
    dir = rawDir === 'asc' || rawDir === 'desc' ? rawDir : policy.sort.dir
  }

  // Number('') is 0 and Number('abc') is NaN, so the empty and the malformed case fall to the
  // default through the same guard. Non-integers are rejected rather than floored — there is no
  // page 2.5 to round toward.
  let page = 1
  if (policy.paged) {
    const n = Number(params.get('page'))
    page = Number.isInteger(n) && n >= 1 ? n : 1
  }

  const rawDrawer = policy.drawers ? (params.get('drawer') ?? '') : ''
  const drawer = policy.drawers?.includes(rawDrawer) ? rawDrawer : ''

  return {
    market,
    portfolio,
    campaign,
    line: grain(params.get('line')),
    preset,
    start,
    end,
    q: policy.search ? (params.get('q') ?? '') : '',
    sort,
    dir,
    page,
    row: policy.row ? (params.get('row') ?? '') : '',
    drawer,
  }
}

/**
 * Write the spine's non-default params into `p`, leaving the page's own params to the page.
 *
 * Only non-defaults are written, so the canonical URL for the default view is the bare path. That
 * is what makes "absent = the default" hold in both directions: `parse(write(x)) === x`, and a
 * param equal to its default never appears to have been chosen.
 */
export function writeAdsScope(p: URLSearchParams, s: AdsScope, policy: AdsScopePolicy): void {
  if (s.market !== policy.market.fallback) p.set('market', s.market)
  if (s.portfolio) p.set('portfolio', s.portfolio)
  if (s.campaign) p.set('campaign', s.campaign)
  if (s.line) p.set('line', s.line)
  if (policy.date) {
    if (s.preset === 'custom' && s.start && s.end) {
      p.set('preset', 'custom'); p.set('start', s.start); p.set('end', s.end)
    } else if (s.preset !== policy.date.preset) {
      p.set('preset', s.preset)
    }
  }
  if (policy.search && s.q) p.set('q', s.q)
  if (policy.sort) {
    if (s.sort !== policy.sort.key) p.set('sort', s.sort)
    if (s.dir !== policy.sort.dir) p.set('dir', s.dir)
  }
  if (policy.paged && s.page > 1) p.set('page', String(s.page))
  if (policy.row && s.row) p.set('row', s.row)
  if (policy.drawers && s.drawer) p.set('drawer', s.drawer)
}

/** Every spine key this policy can put in the URL. A page unions this with its own. */
export function adsScopeKeys(policy: AdsScopePolicy): string[] {
  const keys = ['market', 'portfolio', 'campaign', 'line']
  if (policy.date) keys.push('preset', 'start', 'end')
  if (policy.search) keys.push('q')
  if (policy.sort) keys.push('sort', 'dir')
  if (policy.paged) keys.push('page')
  if (policy.row) keys.push('row')
  if (policy.drawers) keys.push('drawer')
  return keys
}

/**
 * Apply a patch of raw string values and return the normalised query string.
 *
 * This is the single writer: every control routes through it, so no control can put a value into
 * the URL that `parseAdsScope` would then reject. Passing `''` clears a param.
 *
 * It returns a query string rather than navigating, so the caller owns `push` vs `replace` and this
 * stays testable without a router.
 *
 * `extra` is how a page keeps its own params through a spine edit: it receives the patched raw
 * params and writes whatever else belongs in the URL. Without it, a page's params would be dropped
 * the first time the operator moved a spine control.
 */
export function patchAdsScope(
  current: URLSearchParams,
  patch: Record<string, string>,
  policy: AdsScopePolicy,
  extra?: (raw: URLSearchParams, out: URLSearchParams) => void,
): string {
  const raw = new URLSearchParams(current.toString())
  for (const [k, v] of Object.entries(patch)) {
    if (!v) raw.delete(k)
    else raw.set(k, v)
  }
  const out = new URLSearchParams()
  writeAdsScope(out, parseAdsScope(raw, policy), policy)
  extra?.(raw, out)
  return out.toString()
}

/**
 * True when the raw query string is not already in its canonical form.
 *
 * A page uses this to rewrite a hand-typed or stale URL once on mount, so the address bar can never
 * disagree with the view — the operator has no other way to tell which one is lying.
 *
 * Compared as SORTED key/value pairs rather than as strings, so a merely reordered query — which is
 * semantically identical — does not trigger a navigation on every load.
 */
export function adsScopeNeedsNormalising(
  current: URLSearchParams,
  policy: AdsScopePolicy,
  extraKeys: readonly string[] = [],
  extra?: (raw: URLSearchParams, out: URLSearchParams) => void,
): boolean {
  const known = new Set([...adsScopeKeys(policy), ...extraKeys])
  const mine = [...current.entries()].filter(([k]) => known.has(k))
  const out = new URLSearchParams()
  writeAdsScope(out, parseAdsScope(current, policy), policy)
  extra?.(current, out)
  const norm = (xs: Array<[string, string]>) => xs.map(([k, v]) => `${k}=${v}`).sort().join('&')
  return norm(mine) !== norm([...out.entries()])
}

// ── the date adapter ────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 `_shell/DateRangePicker.tsx`'s `DATE_PRESETS` and the server's `RangePreset` are DIFFERENT
 * VOCABULARIES, and forwarding a picker key is a silent wrong answer.
 *
 * `apps/api/src/services/ads-core/date-range.ts:resolveRange` has a `default:` branch that falls
 * back to `windowDays` (7). So `?preset=latest30` — a real picker key — returns **seven days under
 * a "Last 30 days" label**. Nothing errors and nothing looks wrong.
 *
 * Two further mismatches hide in names that look shared:
 *   · the picker's `thisWeek` starts **Sunday** (`s.setDate(s.getDate() - s.getDay())`); the
 *     server's `wtd` starts **Monday** (ISO). Same idea, different week.
 *   · the picker resolves in the browser's **local** time; the server anchors to **Europe/Rome**.
 *     For a Rome operator these agree, which is exactly why the divergence would ship.
 *
 * ⚠ **The spec's "the three with no equivalent" is wrong. Measured here: 7 of the 15 picker keys
 * map; EIGHT do not** — `thisWeek` (Sunday≠Monday), `lastWeek`, `last3m`, `last12m` (`last_year` is
 * the previous calendar YEAR, not a trailing twelve months), `last18m`, `last24m`, `lastQuarter`
 * and `latest60`. `null` here means "no server preset produces this window", and the honest
 * treatment is explicit dates — never the nearest-looking key.
 */
export const PICKER_TO_SERVER: Record<string, string | null> = {
  today: 'today',
  yesterday: 'yesterday',
  thisWeek: null,
  lastWeek: null,
  thisMonth: 'mtd',
  lastMonth: 'last_month',
  last3m: null,
  last12m: null,
  last18m: null,
  last24m: null,
  thisQuarter: 'qtd',
  lastQuarter: null,
  latest7: 'last7',
  latest30: 'last30',
  latest60: null,
}

/**
 * 🔴 Local date parts, never `toISOString().slice(0,10)`.
 *
 * `DateRangePicker` hands back local midnights. In Rome in August that is 22:00Z the day BEFORE, so
 * the ISO shortcut silently shifts every picked range back a day. This repo has already paid for
 * that once (the day-grouping UTC/local trap), and `placement/PlacementClient.tsx:150` carries the
 * same three lines — this is the copy that survives.
 */
export const ymdLocal = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * Turn a `DateRangePicker` interaction into a URL patch. **A picker key never leaves this file.**
 *
 * `resolveLocal` is injected rather than imported so this module stays React-free and testable in
 * node; every caller passes `presetRange` from `_shell/DateRangePicker`. A key with an exact server
 * equivalent travels as that key, so the SERVER anchors the window to Rome; everything else travels
 * as explicit dates, which is the only form that cannot mean two things.
 */
export function datePatchFromPicker(
  key: string,
  resolveLocal: (key: string) => { start: Date; end: Date },
): { preset: string; start: string; end: string } {
  const server = PICKER_TO_SERVER[key]
  if (server) return { preset: server, start: '', end: '' }
  const r = resolveLocal(key)
  return { preset: 'custom', start: ymdLocal(r.start), end: ymdLocal(r.end) }
}

/** A hand-picked calendar range is always explicit — there is no preset that means "these two days". */
export function datePatchFromDays(start: Date, end: Date): { preset: string; start: string; end: string } {
  return { preset: 'custom', start: ymdLocal(start), end: ymdLocal(end) }
}

// ── reach ───────────────────────────────────────────────────────────────────────────────────────

/** The `GET /advertising/scope-options` payload, narrowed to what reach needs. */
export interface ScopeOptions {
  totalCampaigns: number
  campaigns: Array<{ id: string; name: string; marketplace: string | null; portfolioId: string | null; status?: string }>
  portfolios: Array<{ externalPortfolioId: string; name: string }>
  campaignsWithoutPortfolio?: number
  productLines: Array<{
    id: string; sku: string; name: string; variations: number; campaigns: string[]
    children: Array<{ id: string; sku: string; name: string; campaigns: string[] }>
  }>
}

export interface ScopeReach {
  /** Campaign ids the scope resolves to. */
  ids: string[]
  resolved: number
  total: number
  /**
   * 🔴 How many of `ids` automation may actually write to — or **null when this page cannot know**.
   *
   * ⚠ The substrate spec §3.1.7 says `GET /advertising/scope-options` "already returns enough" for
   * both numbers. **It does not.** Its campaign rows are `{id, name, marketplace, portfolioId,
   * status}` — there is no write-gate field anywhere in the payload. The gate lives in
   * `GET /advertising/control-room/guardrail-grid`, which is what `apply-rules/ApplyRulesClient`
   * actually reads. Two numbers need two sources.
   *
   * `null` therefore means "not known here", and a page must render it as such. It must never be
   * shown as `0` — the whole reason for two numbers is that "reaches nothing" and "not permitted to
   * write" must not read the same, and a fabricated zero recreates exactly that collision.
   */
  writable: number | null
  /** Which dimensions narrowed, in the order they narrowed — the server's own wording. */
  applied: string[]
  /** Advertised variations, when a product LINE is the grain. Null for a single product or none. */
  variations: number | null
  /** Non-fatal facts worth showing: the portfolio blind spot, an unadvertised line. */
  notes: string[]
  /** Set when the combination can never fire. A refusal, not a failure. */
  contradiction: string | null
}

/**
 * The same intersection the server performs, so a preview cannot lie about enforcement.
 *
 * Promoted from `automations/ScopeForm.tsx:93`, which had it right, and which three sibling scope
 * bars then each re-derived. The order of narrowing matches
 * `apps/api/src/services/advertising/ads-scope-reach.ts` exactly — market, then campaign-or-
 * portfolio, then product — because `applied` is rendered as a sentence and two orders would read
 * as two different bindings.
 *
 * `writableIds` is optional and is the ONLY way `writable` becomes a number: pass the gate set when
 * the page has one, omit it when it does not, and never substitute a zero. See `ScopeReach.writable`.
 */
export function resolveScopeReach(
  options: ScopeOptions | null,
  scope: Pick<AdsScope, 'market' | 'portfolio' | 'campaign' | 'line'>,
  writableIds?: ReadonlySet<string> | null,
): ScopeReach | null {
  if (!options) return null
  const applied: string[] = []
  const notes: string[] = []

  let ids = options.campaigns.map((c) => c.id)
  if (scope.market && scope.market !== ALL_MARKETS) {
    const m = scope.market
    ids = options.campaigns.filter((c) => c.marketplace === m).map((c) => c.id)
    applied.push(`market ${m}`)
  }

  // Campaign before portfolio, and never both: `parseAdsScope` has already dropped the portfolio
  // when a campaign is set, so this branch is belt-and-braces for a caller passing a raw pair.
  if (scope.campaign) {
    ids = ids.filter((id) => id === scope.campaign)
    applied.push('one campaign')
  } else if (scope.portfolio) {
    const inPf = new Set(options.campaigns.filter((c) => c.portfolioId === scope.portfolio).map((c) => c.id))
    ids = ids.filter((id) => inPf.has(id))
    applied.push('one portfolio')
    // A fact about the ACCOUNT, not about this selection, so it is stated whenever a portfolio is
    // chosen — including when the chosen one is healthy. Measured 2026-08-11: 72 of 220 campaigns
    // (33%) carry no portfolio at all, so no portfolio binding can ever reach them.
    const orphans = options.campaignsWithoutPortfolio ?? options.campaigns.filter((c) => !c.portfolioId).length
    if (orphans > 0) {
      notes.push(`${orphans} of ${options.totalCampaigns} campaigns carry no portfolio at all, so no portfolio binding can ever reach them`)
    }
  }

  let variations: number | null = null
  if (scope.line) {
    const line = options.productLines.find((l) => l.id === scope.line)
    const child = line ? null : options.productLines.flatMap((l) => l.children).find((c) => c.id === scope.line)
    const allowed = new Set(line ? line.campaigns : child ? child.campaigns : [])
    ids = ids.filter((id) => allowed.has(id))
    // ADVERTISED variations, not catalogue children — saying "40 variations" beside a picker that
    // lists 18 would be two numbers for one thing.
    variations = line ? line.variations : null
    applied.push(line ? 'one product line' : 'one product')
    if (allowed.size === 0) {
      notes.push(line
        ? 'no variation of this product line is advertised by any campaign yet'
        : 'this product is not advertised by any campaign yet')
    }
  }

  return {
    ids,
    resolved: ids.length,
    total: options.totalCampaigns,
    writable: writableIds ? ids.filter((id) => writableIds.has(id)).length : null,
    applied,
    variations,
    notes,
    // A combination that resolves to nothing while something was applied can never fire. That is a
    // refusal — the system working — and it is named rather than rendered as an empty grid.
    contradiction: ids.length === 0 && applied.length > 0
      ? `${applied.join(' + ')} have no campaign in common, so nothing scoped this way could ever match.`
      : null,
  }
}

// ── grain availability ──────────────────────────────────────────────────────────────────────────

export type GrainKey = 'market' | 'portfolio' | 'line' | 'campaign'

export interface GrainState {
  enabled: boolean
  /** One sentence, shown on the disabled control. Null when it is enabled. */
  reason: string | null
  /** How many distinct values this grain offers. */
  options: number
}

/**
 * 🔴 A grain that cannot narrow this page renders DISABLED with one sentence saying why — never
 * silently doing nothing.
 *
 * A control that is present, movable and inert is worse than an absent one: the operator moves it,
 * nothing changes, and the only available reading is that the page is broken. This is §3.0's law
 * (a control earns its place only if some pixel changes when you move it) applied to the case where
 * the control must stay for consistency across eleven pages.
 *
 * All four grains are live on this account today (4 markets · 12 portfolios · 13 lines · 220
 * campaigns), so this is a guard rather than a current defect — which is precisely why it belongs
 * in the substrate: it is the shape that is cheap to get right once and invisible to get wrong.
 */
export function grainAvailability(options: ScopeOptions | null): Record<GrainKey, GrainState> {
  const unknown = (): GrainState => ({ enabled: false, reason: 'Still loading the scope options.', options: 0 })
  if (!options) return { market: unknown(), portfolio: unknown(), line: unknown(), campaign: unknown() }

  const markets = new Set(options.campaigns.map((c) => c.marketplace).filter(Boolean))
  const withPf = options.campaigns.filter((c) => c.portfolioId)
  const pfs = new Set(withPf.map((c) => c.portfolioId))

  return {
    market: markets.size > 1
      ? { enabled: true, reason: null, options: markets.size }
      : { enabled: false, options: markets.size, reason: markets.size === 1
        ? `Every campaign in this account runs in ${[...markets][0]}, so narrowing by market cannot change this view.`
        : 'No campaign carries a marketplace yet, so there is nothing to narrow by.' },
    portfolio: pfs.size > 1
      ? { enabled: true, reason: null, options: pfs.size }
      : { enabled: false, options: pfs.size, reason: pfs.size === 1
        ? 'Only one portfolio holds any campaign, so narrowing by portfolio cannot change this view.'
        : 'No campaign belongs to a portfolio, so no portfolio binding can reach anything.' },
    line: options.productLines.length > 1
      ? { enabled: true, reason: null, options: options.productLines.length }
      : { enabled: false, options: options.productLines.length, reason: options.productLines.length === 1
        ? 'One product line covers every advertised campaign, so narrowing by line cannot change this view.'
        : 'No advertised ad row resolves to a product yet — run the Amazon import to name them.' },
    campaign: options.campaigns.length > 1
      ? { enabled: true, reason: null, options: options.campaigns.length }
      : { enabled: false, options: options.campaigns.length, reason: 'There is at most one campaign to choose.' },
  }
}
