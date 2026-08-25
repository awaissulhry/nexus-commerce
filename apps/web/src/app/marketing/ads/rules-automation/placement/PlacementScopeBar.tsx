'use client'

/**
 * ⛔ PARKED 2026-08-17 (U2) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: this page's own scope bar (Product line · Portfolio · Campaign · Lane) — one of the seven page-local forks of the scope spine.
 * Why it left: the Placement tab is now Helium 10's shape — one rules grid and nothing else
 *   (`PlacementRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.8, §7.3).
 * Candidate home: travels with PlacementClient; the shared `AdsFilterBar` + `buildScopeFilters` supersede it wherever it lands.
 *
 * Nothing here was changed and no endpoint was retired — the PLC.3 multiplier write path is still
 * served. The file stays at this path on purpose: re-mounting it is one import.
 * Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * PLC.0 — the Placement page's scope bar: Product line · Portfolio · Campaign · Lane.
 *
 * 🔴 Market is deliberately NOT here. `AdsPageHeader` already renders a market picker on every ads
 * page, and `showMarket` does not exist (verified again 2026-08-12, zero hits repo-wide). The page
 * owns one market state and passes it into the header; this bar reads the same state and never
 * renders a second control for it. That duplicate is precisely what sank the reverted scope bar
 * (RA plan §3.0): two controls for one fact, disagreeing.
 *
 * Options come from `/advertising/scope-options` — the read Automations, Keyword Tracker and
 * Negative Targeting already use — so the pickers here cannot offer a line or portfolio the server
 * would resolve differently. The server resolves the selection through `resolveScopeReach`, the
 * same resolver the rule evaluator enforces with.
 *
 * The four grains **AND** together and the most specific one wins. The bar SAYS so rather than
 * demonstrating it: picking a campaign does not clear the portfolio you also picked — it just
 * stops mattering, and a bar that silently dropped the selection would be lying about the state
 * of the URL you are about to share.
 *
 * ── The lane is different from the other three, and is placed apart because of it ─────────────
 *
 * Line, portfolio and campaign narrow WHICH CAMPAIGNS you are looking at. The lane narrows which
 * of each campaign's three rows you are looking at. Mixing it into the same funnel would suggest
 * it drops campaigns, which it does not: `lane=top` still shows all 220 campaigns, one row each.
 */

import { useMemo } from 'react'
import { Info, X } from 'lucide-react'
import { Listbox } from '@/design-system/components'

export interface ScopeOptionsPayload {
  campaigns: Array<{ id: string; name: string; marketplace: string | null; portfolioId: string | null }>
  portfolios: Array<{ externalPortfolioId: string; name: string }>
  productLines: Array<{ id: string; sku: string; name: string; variations: number; campaigns: string[] }>
  totalCampaigns?: number
  campaignsWithoutPortfolio?: number
}

export type PlcLaneKey = 'top' | 'rest' | 'product'

export interface PlcScope {
  line: string
  portfolio: string
  campaign: string
}

/** The lane vocabulary, in the order Amazon's own console lists the placements. */
export const LANE_OPTIONS: Array<{ value: PlcLaneKey | 'all'; label: string; tip: string }> = [
  { value: 'all', label: 'All lanes', tip: 'All three rows for every campaign — the default, and the only view in which a lane carrying nothing is visible beside the lane carrying everything' },
  { value: 'top', label: 'Top of search', tip: 'PLACEMENT_TOP. The only lane Amazon publishes an impression share for.' },
  { value: 'rest', label: 'Rest of search', tip: 'PLACEMENT_REST_OF_SEARCH — Amazon reports it as "Other on-Amazon".' },
  { value: 'product', label: 'Product pages', tip: 'PLACEMENT_PRODUCT_PAGE — Amazon reports it as "Detail Page on-Amazon".' },
]

export function PlacementScopeBar({
  options, market, scope, lane, onChange, onLaneChange, boundBy, reach,
}: {
  options: ScopeOptionsPayload | null
  market: string
  scope: PlcScope
  lane: PlcLaneKey | 'all'
  onChange: (next: PlcScope) => void
  onLaneChange: (next: PlcLaneKey | 'all') => void
  /** which grain the server said actually bound the last read */
  boundBy: string | null
  /** what the server said it applied, and how far it reached */
  reach: { campaigns: number; total: number } | null
}) {
  // 'all' is renderable on this page, unlike on the Keyword Tracker: a campaign belongs to exactly
  // one market and all four bill in EUR, so a merged view sums nothing dishonestly.
  const inMarket = useMemo(
    () => (options?.campaigns ?? []).filter((c) => market === 'all' || c.marketplace === market),
    [options, market],
  )

  // A line is offered only where it has a campaign in THIS market. Offering a line that resolves
  // to zero rows in the selected market would look like missing data rather than an empty scope.
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

  // The campaign list narrows to whatever coarser grain is already picked, so the three controls
  // read as one funnel instead of three unrelated filters.
  const campOpts = useMemo(() => {
    const lineCampaigns = scope.line
      ? new Set((options?.productLines ?? []).find((l) => l.id === scope.line)?.campaigns ?? [])
      : null
    return [{ value: '', label: 'All campaigns' }].concat(
      inMarket
        .filter((c) => (scope.portfolio ? c.portfolioId === scope.portfolio : true))
        .filter((c) => (lineCampaigns ? lineCampaigns.has(c.id) : true))
        .map((c) => ({ value: c.id, label: market === 'all' && c.marketplace ? `${c.name} · ${c.marketplace}` : c.name })),
    )
  }, [inMarket, options, scope.line, scope.portfolio, market])

  const set = (patch: Partial<PlcScope>) => onChange({ ...scope, ...patch })
  const any = scope.line || scope.portfolio || scope.campaign

  // Most-specific-wins, said out loud. Only shown when a coarser grain is genuinely inert.
  const overridden: string[] = []
  if (boundBy === 'campaign') {
    if (scope.portfolio) overridden.push('portfolio')
    if (scope.line) overridden.push('product line')
  } else if (boundBy === 'portfolio' && scope.line) {
    overridden.push('product line')
  }

  // 🔴 The portfolio grain has a hole in it and a portfolio picker must not look complete: the
  // reach the server reports is the honest denominator, so it is stated on the control itself.
  const orphans = options?.campaignsWithoutPortfolio ?? 0
  const total = options?.totalCampaigns ?? reach?.total ?? 0

  return (
    <div className="h10-plc-scope">
      <div className="h10-plc-scoperow">
        <span className="h10-plc-lbl">Scope</span>

        <span className="h10-plc-field">
          <span className="cap">Product line</span>
          <Listbox options={lineOpts} value={scope.line} onChange={(v) => set({ line: v, campaign: '' })} ariaLabel="Product line" width={210} />
        </span>

        <span className="h10-plc-field">
          <span className="cap">Portfolio</span>
          <Listbox options={pfOpts} value={scope.portfolio} onChange={(v) => set({ portfolio: v, campaign: '' })} ariaLabel="Portfolio" width={210} />
        </span>

        <span className="h10-plc-field">
          <span className="cap">Campaign</span>
          <Listbox options={campOpts} value={scope.campaign} onChange={(v) => set({ campaign: v })} ariaLabel="Campaign" width={280} searchable />
        </span>

        <span className="h10-plc-sep" aria-hidden="true" />

        {/* The lane is Placement's own grain and narrows ROWS, not campaigns — hence the rule
            before it rather than a fourth pill in the funnel. */}
        <span className="h10-plc-field">
          <span className="cap">Lane</span>
          <Listbox
            options={LANE_OPTIONS.map((l) => ({ value: l.value, label: l.label }))}
            value={lane}
            onChange={(v) => onLaneChange(v as PlcLaneKey | 'all')}
            ariaLabel="Placement lane"
            width={170}
          />
        </span>

        {(any || lane !== 'all') && (
          <button
            type="button"
            className="h10-plc-clear"
            onClick={() => { onChange({ line: '', portfolio: '', campaign: '' }); onLaneChange('all') }}
          >
            <X size={12} /> Clear scope
          </button>
        )}
      </div>

      {overridden.length > 0 && (
        <p className="h10-plc-note">
          <Info size={12} />
          <span>
            The <b>{boundBy}</b> is the narrowest thing you picked, so it decides these rows on its own — the{' '}
            {overridden.join(' and ')} you also picked {overridden.length > 1 ? 'are' : 'is'} not narrowing them further.
          </span>
        </p>
      )}

      {scope.portfolio && orphans > 0 && total > 0 && (
        <p className="h10-plc-note">
          <Info size={12} />
          <span>
            A portfolio-scoped view cannot reach <b>{orphans.toLocaleString('en-IE')} of the {total.toLocaleString('en-IE')}</b>{' '}
            campaigns in this account — they carry no portfolio id at all, so no portfolio binding
            reaches them and their multipliers are not on this screen.
          </span>
        </p>
      )}
    </div>
  )
}
