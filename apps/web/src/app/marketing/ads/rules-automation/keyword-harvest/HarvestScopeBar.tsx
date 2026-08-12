'use client'

/**
 * HV.1 — the scope bar: Product line · Portfolio · Campaign · Ad group.
 *
 * 🔴 Market is deliberately NOT here. `AdsPageHeader` already renders a market picker on every ads
 * page, and `showMarket` does not exist — verified again 2026-08-12, and the only two hits
 * repo-wide are the comments in KT.1's and NEG.1's scope bars saying so. (The locks-doc note that
 * once claimed the header had gained the prop is stale; the prop went with the revert, `7db1a4ed6`.)
 * The page owns one market state and passes it into the header; this bar reads that same state and
 * never renders a second control for it. Two controls for one fact is exactly what sank the scope
 * bar that was built, shipped and reverted on 2026-08-10, and the law from that revert governs this
 * whole page: **a control earns its place only if some pixel changes when you move it.**
 *
 * 🔴 Ad group is a fifth grain and it is HV-specific — it is the grain a harvest candidate actually
 * HAS. `AmazonAdsSearchTerm.adGroupId` holds an `externalAdGroupId`, and a candidate's whole
 * identity on this page is (term × campaign × ad group). The picker appears once a campaign is
 * chosen, and its options come from the same read that fills the grid, so it can never offer an ad
 * group that holds no search term.
 *
 * The other four options come from `/advertising/scope-options`, the read Automations and Keyword
 * Tracker already use, so the pickers here cannot offer a line or portfolio the server would
 * resolve differently.
 *
 * The grains cascade, most specific wins (the server enforces it; this bar SAYS it). Picking a
 * campaign does not clear the portfolio you also picked — it just stops mattering, and a bar that
 * silently dropped the selection would be lying about the state of the URL you are about to share.
 *
 * ⚠ Rule scope is single-valued (`scopeCampaignId`, `scopePortfolioId` — AUTO §11 C4). That is
 * about RULES. This is a read filter and has no such constraint; the two must not be confused.
 */

import { useMemo } from 'react'
import { Info, X } from 'lucide-react'
import { H10Select } from '../../campaigns/FilterDropdown'

export interface ScopeOptionsPayload {
  campaigns: Array<{ id: string; name: string; marketplace: string | null; portfolioId: string | null }>
  portfolios: Array<{ externalPortfolioId: string; name: string }>
  productLines: Array<{ id: string; sku: string; name: string; variations: number; campaigns: string[] }>
}

export interface HvScope {
  line: string
  portfolio: string
  campaign: string
  adGroup: string
}

export function HarvestScopeBar({
  options, market, scope, onChange, boundBy, adGroupOptions,
}: {
  options: ScopeOptionsPayload | null
  market: string
  scope: HvScope
  onChange: (next: HvScope) => void
  /** which grain the server said actually bound the last read */
  boundBy: string | null
  /** ad groups holding at least one search term inside the resolved scope, with their counts */
  adGroupOptions: Array<{ id: string; name: string; campaignName: string; terms: number }>
}) {
  // `market` is the header's state. 'all' means every production market, matching the server's
  // HV_MARKET_ALL — not an empty string, and never a stored preference.
  const inMarket = useMemo(
    () => (options?.campaigns ?? []).filter((c) => (market === 'all' ? true : c.marketplace === market)),
    [options, market],
  )

  // A line is offered only where it has a campaign in THIS market. Offering a line that resolves to
  // zero rows in the selected market would look like missing data rather than an empty scope.
  const lineOpts = useMemo(() => {
    const idsInMarket = new Set(inMarket.map((c) => c.id))
    return [{ value: '', label: 'All product lines' }].concat(
      (options?.productLines ?? [])
        .filter((l) => l.campaigns.some((c) => idsInMarket.has(c)))
        .map((l) => ({ value: l.id, label: `${l.sku} · ${l.variations} variation${l.variations === 1 ? '' : 's'}` })),
    )
  }, [options, inMarket])

  const pfOpts = useMemo(() => {
    const live = new Set(inMarket.map((c) => c.portfolioId).filter((x): x is string => !!x))
    return [{ value: '', label: 'All portfolios' }].concat(
      (options?.portfolios ?? [])
        .filter((p) => live.has(p.externalPortfolioId))
        .map((p) => ({
          value: p.externalPortfolioId,
          label: `${p.name} · ${inMarket.filter((c) => c.portfolioId === p.externalPortfolioId).length} campaigns`,
        })),
    )
  }, [options, inMarket])

  // The campaign list narrows to whatever coarser grain is already picked, so the controls read as
  // one funnel instead of four unrelated filters.
  const campOpts = useMemo(() => {
    const lineCampaigns = scope.line
      ? new Set((options?.productLines ?? []).find((l) => l.id === scope.line)?.campaigns ?? [])
      : null
    return [{ value: '', label: 'All campaigns' }].concat(
      inMarket
        .filter((c) => (scope.portfolio ? c.portfolioId === scope.portfolio : true))
        .filter((c) => (lineCampaigns ? lineCampaigns.has(c.id) : true))
        .map((c) => ({ value: c.id, label: c.name })),
    )
  }, [inMarket, options, scope.line, scope.portfolio])

  const agOpts = useMemo(
    () => [{ value: '', label: 'All ad groups' }].concat(
      adGroupOptions.map((g) => ({ value: g.id, label: `${g.name} · ${g.terms} term${g.terms === 1 ? '' : 's'}` })),
    ),
    [adGroupOptions],
  )

  const set = (patch: Partial<HvScope>) => onChange({ ...scope, ...patch })
  const any = scope.line || scope.portfolio || scope.campaign || scope.adGroup

  // Most-specific-wins, said out loud. Only shown when a coarser grain is genuinely inert.
  const overridden: string[] = []
  if (boundBy === 'adGroup') {
    if (scope.campaign) overridden.push('campaign')
    if (scope.portfolio) overridden.push('portfolio')
    if (scope.line) overridden.push('product line')
  } else if (boundBy === 'campaign') {
    if (scope.portfolio) overridden.push('portfolio')
    if (scope.line) overridden.push('product line')
  } else if (boundBy === 'portfolio' && scope.line) {
    overridden.push('product line')
  }

  return (
    <div className="h10-hv-scope">
      <div className="h10-hv-scoperow">
        <span className="h10-hv-lbl">Scope</span>

        <span className="h10-hv-field">
          <span className="cap">Product line</span>
          <H10Select options={lineOpts} value={scope.line} onChange={(v) => set({ line: v, campaign: '', adGroup: '' })} ariaLabel="Product line" width={210} />
        </span>

        <span className="h10-hv-field">
          <span className="cap">Portfolio</span>
          <H10Select options={pfOpts} value={scope.portfolio} onChange={(v) => set({ portfolio: v, campaign: '', adGroup: '' })} ariaLabel="Portfolio" width={210} />
        </span>

        <span className="h10-hv-field">
          <span className="cap">Campaign</span>
          <H10Select options={campOpts} value={scope.campaign} onChange={(v) => set({ campaign: v, adGroup: '' })} ariaLabel="Campaign" width={260} searchable />
        </span>

        {/* The fifth grain appears only once a campaign is chosen: a picker over every ad group
            that holds a search term would be a list, not a control. */}
        {scope.campaign && (
          <span className="h10-hv-field">
            <span className="cap">Ad group</span>
            <H10Select options={agOpts} value={scope.adGroup} onChange={(v) => set({ adGroup: v })} ariaLabel="Ad group" width={240} searchable />
          </span>
        )}

        {any && (
          <button type="button" className="h10-hv-clear" onClick={() => onChange({ line: '', portfolio: '', campaign: '', adGroup: '' })}>
            <X size={12} /> Clear scope
          </button>
        )}
      </div>

      {overridden.length > 0 && (
        <p className="h10-hv-note">
          <Info size={12} />
          <span>
            The <b>{boundBy === 'adGroup' ? 'ad group' : boundBy}</b> is the narrowest thing you picked, so it decides these rows on its own — the{' '}
            {overridden.join(' and ')} you also picked {overridden.length > 1 ? 'are' : 'is'} not narrowing them further.
          </span>
        </p>
      )}
    </div>
  )
}
