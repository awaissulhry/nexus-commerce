'use client'

/**
 * NEG.1 — the scope bar: Product line · Portfolio · Campaign · Ad group.
 *
 * 🔴 Market is deliberately NOT here. `AdsPageHeader` already renders a market picker on every ads
 * page, and `showMarket` does not exist (zero hits repo-wide). The page owns one market state and
 * passes it into the header; this bar reads that same state and never renders a second control for
 * it. Two controls for one fact is exactly what sank the scope bar that was built, shipped and
 * reverted on 2026-08-10.
 *
 * 🔴 Ad group is a fifth grain, specific to this page. 2,037 of 2,059 negatives are ad-group-scoped
 * — this page's object lives at that grain, and nothing coarser can address one. The picker appears
 * once a campaign is chosen, and its options come from the same read that fills the grid, so it can
 * never offer an ad group that holds no negative.
 *
 * The other four options come from `/advertising/scope-options`, the read Automations and Keyword
 * Tracker already use, so the pickers here cannot offer a line or portfolio the server would
 * resolve differently.
 *
 * The grains cascade, most specific wins (the server enforces it; this bar SAYS it). Picking a
 * campaign does not clear the portfolio you also picked — it just stops mattering, and a bar that
 * silently dropped the selection would be lying about the state of the URL you are about to share.
 */

import { useMemo } from 'react'
import { Info, X } from 'lucide-react'
import { H10Select } from '../../campaigns/FilterDropdown'

export interface ScopeOptionsPayload {
  campaigns: Array<{ id: string; name: string; marketplace: string | null; portfolioId: string | null }>
  portfolios: Array<{ externalPortfolioId: string; name: string }>
  productLines: Array<{ id: string; sku: string; name: string; variations: number; campaigns: string[] }>
}

export interface NegScope {
  line: string
  portfolio: string
  campaign: string
  adGroup: string
}

export function NegativeScopeBar({
  options, market, scope, onChange, boundBy, adGroupOptions,
}: {
  options: ScopeOptionsPayload | null
  market: string
  scope: NegScope
  onChange: (next: NegScope) => void
  /** which grain the server said actually bound the last read */
  boundBy: string | null
  /** ad groups holding at least one negative inside the resolved scope, with their counts */
  adGroupOptions: Array<{ id: string; name: string; negatives: number }>
}) {
  const inMarket = useMemo(
    () => (options?.campaigns ?? []).filter((c) => c.marketplace === market),
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
      adGroupOptions.map((g) => ({ value: g.id, label: `${g.name} · ${g.negatives}` })),
    ),
    [adGroupOptions],
  )

  const set = (patch: Partial<NegScope>) => onChange({ ...scope, ...patch })
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
    <div className="h10-ng-scope">
      <div className="h10-ng-scoperow">
        <span className="h10-ng-lbl">Scope</span>

        <span className="h10-ng-field">
          <span className="cap">Product line</span>
          <H10Select options={lineOpts} value={scope.line} onChange={(v) => set({ line: v, campaign: '', adGroup: '' })} ariaLabel="Product line" width={210} />
        </span>

        <span className="h10-ng-field">
          <span className="cap">Portfolio</span>
          <H10Select options={pfOpts} value={scope.portfolio} onChange={(v) => set({ portfolio: v, campaign: '', adGroup: '' })} ariaLabel="Portfolio" width={210} />
        </span>

        <span className="h10-ng-field">
          <span className="cap">Campaign</span>
          <H10Select options={campOpts} value={scope.campaign} onChange={(v) => set({ campaign: v, adGroup: '' })} ariaLabel="Campaign" width={260} searchable />
        </span>

        {/* The fifth grain appears only once a campaign is chosen: an ad-group picker over 143 ad
            groups across 118 campaigns would be a list, not a control. */}
        {scope.campaign && (
          <span className="h10-ng-field">
            <span className="cap">Ad group</span>
            <H10Select options={agOpts} value={scope.adGroup} onChange={(v) => set({ adGroup: v })} ariaLabel="Ad group" width={240} searchable />
          </span>
        )}

        {any && (
          <button type="button" className="h10-ng-clear" onClick={() => onChange({ line: '', portfolio: '', campaign: '', adGroup: '' })}>
            <X size={12} /> Clear scope
          </button>
        )}
      </div>

      {overridden.length > 0 && (
        <p className="h10-ng-note">
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
