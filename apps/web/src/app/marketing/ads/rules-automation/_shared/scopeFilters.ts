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
 * ── The one cascade, and why it is the only one ────────────────────────────────────────────────
 *
 * `adsScope.ts` rule 4: portfolio and campaign are mutually exclusive and campaign wins, because a
 * campaign has at most one portfolio, so holding both is redundant or contradictory. Line ANDs with
 * everything and stays live.
 *
 * The operator decision for this merge was that an overridden grain stays VISIBLE and inert rather
 * than vanishing — a bar that silently dropped a selection would lie about the URL you are about to
 * share. What it shows while inert is the campaign's OWN portfolio, which is a fact rather than a
 * stale selection, so nothing is dropped and nothing is invented. It rides in as the placeholder
 * because a disabled select with an empty value renders its placeholder.
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
  options, market, value, adGroups,
}: {
  options: ScopeOptionsPayload | null
  /** `'all'` is legal on nine of the eleven pages; the two share pages never pass it. */
  market: string
  value: ScopeValue
  /** Pass to add the ad-group grain. Omit and the page has three grains, not four. */
  adGroups?: Array<{ id: string; name: string; campaignId: string | null }> | null
}): GridFilter[] {
  // 'all' is a real market value on most of these pages, so the pickers must not filter to a
  // marketplace that does not exist. Every campaign is in scope when no market is chosen.
  const inMarket = (options?.campaigns ?? []).filter((c) => market === 'all' || c.marketplace === market)
  const idsInMarket = new Set(inMarket.map((c) => c.id))

  // A line is offered only where it has a campaign in THIS market. Offering a line that resolves to
  // zero rows in the selected market would look like missing data rather than an empty scope.
  const lines = (options?.productLines ?? []).filter((l) => l.campaigns.some((c) => idsInMarket.has(c)))
  const lineOpts = [{ value: '', label: 'All product lines' }].concat(
    lines.map((l) => ({ value: l.id, label: `${l.sku} · ${plural(l.variations, 'variation')}` })),
  )

  const livePfs = new Set(inMarket.map((c) => c.portfolioId).filter((x): x is string => !!x))
  const portfolios = (options?.portfolios ?? []).filter((p) => livePfs.has(p.externalPortfolioId))
  const pfOpts = [{ value: '', label: 'All portfolios' }].concat(
    portfolios.map((p) => ({
      value: p.externalPortfolioId,
      label: `${p.name} · ${plural(inMarket.filter((c) => c.portfolioId === p.externalPortfolioId).length, 'campaign')}`,
    })),
  )

  // The campaign list narrows to whatever coarser grain is already picked, so the controls read as
  // one funnel instead of three unrelated selects.
  const lineCampaigns = value.line
    ? new Set((options?.productLines ?? []).find((l) => l.id === value.line)?.campaigns ?? [])
    : null
  const campaignsInScope = inMarket
    .filter((c) => (value.portfolio ? c.portfolioId === value.portfolio : true))
    .filter((c) => (lineCampaigns ? lineCampaigns.has(c.id) : true))
  const campOpts = [{ value: '', label: 'All campaigns' }].concat(
    campaignsInScope.map((c) => ({ value: c.id, label: c.name })),
  )

  // The chosen campaign's own portfolio — a fact, shown where the operator's overridden selection
  // used to sit. `undefined` when the campaign is not in the loaded options yet (a deep link that
  // arrived before the fetch): the select then says so rather than claiming "no portfolio".
  const chosen = value.campaign ? inMarket.find((c) => c.id === value.campaign) : undefined
  const chosenPf = chosen?.portfolioId
    ? (options?.portfolios ?? []).find((p) => p.externalPortfolioId === chosen.portfolioId)?.name ?? chosen.portfolioId
    : chosen ? 'No portfolio' : undefined

  const loading = options == null

  const line: GridSelectFilter = {
    key: SCOPE_KEYS.line, label: 'Product line', kind: 'select', wide: true, options: lineOpts,
    placeholder: 'All product lines',
    searchable: lineOpts.length > 7,
    disabled: loading || lines.length === 0,
    note: loading ? undefined
      : lines.length === 0 ? 'No advertised campaign resolves to a product line in this market.' : undefined,
  }

  const portfolio: GridSelectFilter = value.campaign
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

  const campaign: GridSelectFilter = {
    key: SCOPE_KEYS.campaign, label: 'Campaign', kind: 'select', wide: true, options: campOpts, searchable: true,
    placeholder: 'All campaigns',
    disabled: loading || campaignsInScope.length === 0,
    note: loading || campaignsInScope.length > 0 ? undefined
      : 'No campaign matches the grains above, so nothing can be chosen here.',
  }

  const out: GridFilter[] = [line, portfolio, campaign]

  if (adGroups) {
    // Ad groups belong to a campaign, so this grain only means something once one is chosen. It is
    // shown either way, for the same reason the overridden portfolio is: a control that appears and
    // disappears makes the bar a different shape on every click.
    const inCampaign = value.campaign ? adGroups.filter((g) => g.campaignId === value.campaign) : []
    out.push({
      key: SCOPE_KEYS.adGroup, label: 'Ad group', kind: 'select', wide: true, searchable: true,
      options: [{ value: '', label: 'All ad groups' }].concat(inCampaign.map((g) => ({ value: g.id, label: g.name }))),
      placeholder: 'All ad groups',
      disabled: !value.campaign || inCampaign.length === 0,
      note: !value.campaign ? 'Choose a campaign first — an ad group belongs to one.'
        : inCampaign.length === 0 ? 'This campaign has no ad groups in the loaded options.' : undefined,
    })
  }

  return out
}
