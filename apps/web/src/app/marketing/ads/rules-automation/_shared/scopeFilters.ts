/**
 * FB.2 — the scope grains, expressed as filters.
 *
 * Seven pages in this section shipped their own `*ScopeBar.tsx`, and the option-building memos in
 * all seven were byte-identical down to the comments (recorded in `project_ads_rules_automation_ra`
 * as "the RA scope bar is forked 3+ times"; the audit for this commit found seven). They forked for
 * a reason the parallel-session protocol made unavoidable — extracting a shared bar meant editing
 * another session's page directory — and not for a design reason. This is that extraction.
 *
 * The operator asked for ONE bar per page, keeping Filters, with the scope dropdowns inside it. So
 * the grains stop being a bar of their own and become what they always were underneath: selects
 * whose state narrows the view. `AdsFilterBar` renders them; this module decides what they offer.
 *
 * ── Why these carry no `value` accessor, and must never be given one ────────────────────────────
 *
 * 🔴 A `kind:'select'` filter with no `value` accessor is inert as a ROW filter — `AdsDataGrid`
 * does `if (!acc) continue` — and exists purely as a control whose state is reported outward. That
 * is exactly right for scope: the SERVER resolved it, the rows already reflect it, and the page
 * carries it in the URL. Adding an accessor here would filter the rows a second time on the client,
 * and every row the client and the server disagreed about would silently vanish.
 *
 * ── Two precedence models, and the bar reports whichever its page has ──────────────────────────
 *
 * The section genuinely holds two, and neither is wrong:
 *
 *   · **AND** (Bid, Budget, Apply Rules) — every grain narrows, because that is what
 *     `automation-rule-scope.ts:ruleMatchesScope` does, and a preview that combined them any other
 *     way would disagree with enforcement. Here only ONE pair collides: `adsScope.ts` rule 4 —
 *     portfolio and campaign are mutually exclusive and campaign wins, since a campaign has at most
 *     one portfolio, so holding both is redundant or contradictory.
 *   · **Most-specific-wins** (Keyword Tracker, Share of Voice, Placement, Harvest, Negatives) — the
 *     server reports which grain actually bound the read as `boundBy`, and the coarser ones stop
 *     mattering entirely.
 *
 * Pass `boundBy` and you get the second; omit it and you get the first. The bar never asserts a
 * precedence of its own — it renders the verdict its page's server returned.
 *
 * ── What an overridden grain does ──────────────────────────────────────────────────────────────
 *
 * The operator decision for this merge was that it stays VISIBLE and inert rather than vanishing —
 * a bar that silently dropped a selection would lie about the URL you are about to share. Under AND
 * the inert Portfolio shows the campaign's OWN portfolio, which is a fact rather than a stale
 * selection, so nothing is dropped and nothing is invented; it rides in as the placeholder because
 * a disabled select with an empty value renders its placeholder. Under most-specific-wins the
 * selection you made stays on screen, greyed, with one sentence naming the grain that beat it.
 */
import type { GridFilter, GridSelectFilter } from '../../campaigns/_grid/AdsDataGrid'

/** The shape `/advertising/scope-options` returns. `ScopeOptions` in `adsScope.ts` is a superset. */
export interface ScopeOptionsPayload {
  campaigns: Array<{ id: string; name: string; marketplace: string | null; portfolioId: string | null }>
  portfolios: Array<{ externalPortfolioId: string; name: string }>
  productLines: Array<{ id: string; sku: string; name: string; variations: number; campaigns: string[] }>
}

/** The `__`-prefixed keys the whole section agrees on. One spelling, eleven pages. */
export const SCOPE_KEYS = {
  line: '__line',
  portfolio: '__portfolio',
  campaign: '__campaign',
  adGroup: '__adGroup',
} as const

export interface ScopeValue {
  line: string
  portfolio: string
  campaign: string
  /** Keyword Harvest and Negative Targeting narrow one grain further. */
  adGroup?: string
}

/** The URL params these grains ride in, in the spelling `adsScope.ts` fixed: `line`, never `product`. */
export const SCOPE_PARAMS = ['line', 'portfolio', 'campaign', 'adGroup'] as const

/** `{ __line: 'x', … }` — what a page seeds the filter panel with. */
export function scopeToFilterState(v: ScopeValue): Record<string, string> {
  const out: Record<string, string> = {
    [SCOPE_KEYS.line]: v.line,
    [SCOPE_KEYS.portfolio]: v.portfolio,
    [SCOPE_KEYS.campaign]: v.campaign,
  }
  if (v.adGroup !== undefined) out[SCOPE_KEYS.adGroup] = v.adGroup
  return out
}

/** The inverse, as a URL patch: `{ line: 'x', portfolio: '', … }`. */
export function scopePatchFromFilterState(s: Record<string, unknown>): Record<string, string> {
  const str = (k: string) => (typeof s[k] === 'string' ? (s[k] as string) : '')
  return {
    line: str(SCOPE_KEYS.line),
    portfolio: str(SCOPE_KEYS.portfolio),
    campaign: str(SCOPE_KEYS.campaign),
    adGroup: str(SCOPE_KEYS.adGroup),
  }
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`

export function buildScopeFilters({
  options, market, value, adGroupOptions, boundBy,
}: {
  options: ScopeOptionsPayload | null
  /** `'all'` is legal on nine of the eleven pages; the two share pages never pass it. */
  market: string
  value: ScopeValue
  /**
   * Pass to add the ad-group grain; omit and the page has three grains, not four. An EMPTY array
   * still renders the control, disabled — Harvest and Negative Targeting get this list from the
   * server (ad groups holding a term inside the resolved scope, with their counts), so an empty
   * one is a real answer about the current scope, not a missing control.
   */
  adGroupOptions?: Array<{ value: string; label: string }> | null
  /**
   * The server's `boundBy` — which grain actually bound the last read. Passing it switches the bar
   * to most-specific-wins; omitting it leaves the AND model. `null` while the page is still loading
   * is treated as "nothing has been decided yet", which is why it is separate from `undefined`.
   */
  boundBy?: 'adGroup' | 'campaign' | 'portfolio' | 'line' | null
}): GridFilter[] {
  // 'all' is a real market value on most of these pages, so the pickers must not filter to a
  // marketplace that does not exist. Every campaign is in scope when no market is chosen.
  const inMarket = (options?.campaigns ?? []).filter((c) => market === 'all' || c.marketplace === market)
  const idsInMarket = new Set(inMarket.map((c) => c.id))

  // A line is offered only where it has a campaign in THIS market. Offering a line that resolves to
  // zero rows in the selected market would look like missing data rather than an empty scope.
  const lines = (options?.productLines ?? []).filter((l) => l.campaigns.some((c) => idsInMarket.has(c)))
  // 🔴 No `{ value: '', label: 'All …' }` head. `FilterDropdown` renders the clear row itself from
  // `emptyLabel`, so injecting one produced TWO "All campaigns" rows — and worse, the injected row
  // MATCHED the empty value, so `options.find(o => o.value === value)` returned it and its label
  // won over `placeholder`. That is what hid the overridden-portfolio name behind "All portfolios".
  // The old `H10Select` bars needed the head; this component supplies it.
  const lineOpts = lines.map((l) => ({ value: l.id, label: `${l.sku} · ${plural(l.variations, 'variation')}` }))

  const livePfs = new Set(inMarket.map((c) => c.portfolioId).filter((x): x is string => !!x))
  const portfolios = (options?.portfolios ?? []).filter((p) => livePfs.has(p.externalPortfolioId))
  const pfOpts = portfolios.map((p) => ({
    value: p.externalPortfolioId,
    label: `${p.name} · ${plural(inMarket.filter((c) => c.portfolioId === p.externalPortfolioId).length, 'campaign')}`,
  }))

  // The campaign list narrows to whatever coarser grain is already picked, so the controls read as
  // one funnel instead of three unrelated selects.
  const lineCampaigns = value.line
    ? new Set((options?.productLines ?? []).find((l) => l.id === value.line)?.campaigns ?? [])
    : null
  const campaignsInScope = inMarket
    .filter((c) => (value.portfolio ? c.portfolioId === value.portfolio : true))
    .filter((c) => (lineCampaigns ? lineCampaigns.has(c.id) : true))
  const campOpts = campaignsInScope.map((c) => ({ value: c.id, label: c.name }))

  // The chosen campaign's own portfolio — a fact, shown where the operator's overridden selection
  // used to sit. `undefined` when the campaign is not in the loaded options yet (a deep link that
  // arrived before the fetch): the select then says so rather than claiming "no portfolio".
  const chosen = value.campaign ? inMarket.find((c) => c.id === value.campaign) : undefined
  const chosenPf = chosen?.portfolioId
    ? (options?.portfolios ?? []).find((p) => p.externalPortfolioId === chosen.portfolioId)?.name ?? chosen.portfolioId
    : chosen ? 'No portfolio' : undefined

  const loading = options == null

  // Most-specific-wins, when the page passes the server's verdict. Under AND this stays empty and
  // only the portfolio/campaign pair collides.
  const specific = boundBy !== undefined
  const RANK = { line: 0, portfolio: 1, campaign: 2, adGroup: 3 } as const
  /** The grain that beat this one, or null. Coarser loses to narrower; equal never beats itself. */
  const beaten = (grain: 'line' | 'portfolio' | 'campaign'): string | null => {
    if (!specific || !boundBy) return null
    return RANK[boundBy] > RANK[grain] ? (boundBy === 'adGroup' ? 'ad group' : boundBy) : null
  }
  const beatenNote = (winner: string) =>
    `The ${winner} is the narrowest grain you picked, so it decides these rows on its own.`

  const lineBeatenBy = beaten('line')
  const line: GridSelectFilter = {
    key: SCOPE_KEYS.line, label: 'Product line', kind: 'select', wide: true, options: lineOpts,
    placeholder: 'All product lines',
    searchable: lineOpts.length > 7,
    disabled: loading || lines.length === 0 || !!lineBeatenBy,
    note: lineBeatenBy ? beatenNote(lineBeatenBy)
      : loading ? undefined
      : lines.length === 0 ? 'No advertised campaign resolves to a product line in this market.' : undefined,
  }

  const pfBeatenBy = beaten('portfolio')
  const portfolio: GridSelectFilter = pfBeatenBy
    ? {
      key: SCOPE_KEYS.portfolio, label: 'Portfolio', kind: 'select', wide: true, options: pfOpts,
      placeholder: 'All portfolios', disabled: true, note: beatenNote(pfBeatenBy),
    }
    : value.campaign
    ? {
      key: SCOPE_KEYS.portfolio, label: 'Portfolio', kind: 'select', wide: true, options: pfOpts,
      // A disabled select with an empty value renders its placeholder, which is where the campaign's
      // own portfolio goes: visible, true, and inert.
      placeholder: chosenPf ?? 'Set by the campaign',
      disabled: true,
      note: 'The campaign you chose decides this — clear it to narrow by portfolio.',
    }
    : {
      key: SCOPE_KEYS.portfolio, label: 'Portfolio', kind: 'select', wide: true, options: pfOpts,
      placeholder: 'All portfolios',
      searchable: pfOpts.length > 7,
      disabled: loading || portfolios.length === 0,
      note: loading ? undefined
        : portfolios.length === 0 ? 'No campaign in this market belongs to a portfolio.' : undefined,
    }

  const campBeatenBy = beaten('campaign')
  const campaign: GridSelectFilter = {
    key: SCOPE_KEYS.campaign, label: 'Campaign', kind: 'select', wide: true, options: campOpts, searchable: true,
    placeholder: 'All campaigns',
    disabled: loading || campaignsInScope.length === 0 || !!campBeatenBy,
    note: campBeatenBy ? beatenNote(campBeatenBy)
      : loading || campaignsInScope.length > 0 ? undefined
      : 'No campaign matches the grains above, so nothing can be chosen here.',
  }

  const out: GridFilter[] = [line, portfolio, campaign]

  if (adGroupOptions) {
    // Shown whether or not it has anything to offer, for the same reason an overridden grain stays
    // visible: a control that appears and disappears makes the bar a different shape on every click.
    out.push({
      key: SCOPE_KEYS.adGroup, label: 'Ad group', kind: 'select', wide: true, searchable: true,
      options: adGroupOptions,
      placeholder: 'All ad groups',
      disabled: adGroupOptions.length === 0,
      note: adGroupOptions.length === 0
        ? 'No ad group inside this scope holds a term to narrow by.' : undefined,
    })
  }

  return out
}
