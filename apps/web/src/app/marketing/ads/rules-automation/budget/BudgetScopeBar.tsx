'use client'

/**
 * BUD.1 — the scope bar: Product line · Portfolio · Campaign.
 *
 * 🔴 Market is deliberately NOT here. `AdsPageHeader` renders a market picker on every ads page and
 * `showMarket` does not exist (re-verified 2026-08-12: zero hits repo-wide — it was reverted along
 * with the scope bar on 2026-08-10). The page owns one market state and passes it into the header;
 * this bar reads that same state and never renders a second control for it. Two controls for one
 * fact is precisely what sank the bar that was built, shipped and reverted.
 *
 * ── The FIFTH copy of this component, and it is recorded rather than defended ────────────────────
 *
 * `KeywordScopeBar` (KT.1), `NegativeScopeBar` (NEG.1), `BidScopeBar` (BID.S0) and RD.P0's are the
 * others. The brief asked me to reuse `automations/ScopeForm.tsx`; it cannot be reused, because it
 * is not a filter bar — it is the rule-scope **binding editor**, it holds `scope*Id` fields and it
 * ends in a button that writes to a rule. Extracting a shared bar would mean editing four other
 * sessions' page directories, which the parallel-session protocol forbids, and RD.P0 has already
 * argued the case for four honest forks over one abstraction chosen blind.
 *
 * The precondition nobody has cleared is the CSS: an extracted bar still has to put its selectors
 * in `rules-automation.css`, the one stylesheet nine pages share, so the extraction does not reduce
 * contention until the component has a stylesheet of its own. Recorded in locks §4.
 *
 * What this copy does differently, deliberately, and shares only with Bid: the **options** come
 * from `/advertising/scope-options`, but the **resolution** is the server's `resolveScopeReach` —
 * the function the rule evaluator enforces with. On a page about which rule is allowed to change
 * which budget, "the campaigns this view shows" and "the campaigns a rule scoped this way reaches"
 * had better be one set, so this bar reports what the server applied rather than asserting its own
 * precedence rule.
 */

import { useMemo } from 'react'
import { AlertTriangle, Info, X } from 'lucide-react'
import { H10Select } from '../../campaigns/FilterDropdown'

export interface ScopeOptionsPayload {
  campaigns: Array<{ id: string; name: string; marketplace: string | null; portfolioId: string | null }>
  portfolios: Array<{ externalPortfolioId: string; name: string }>
  productLines: Array<{ id: string; sku: string; name: string; variations: number; campaigns: string[] }>
}

export interface BudScopeValue {
  product: string
  portfolio: string
  campaign: string
}

export function BudgetScopeBar({
  options, market, scope, onChange, applied, notes, contradiction,
}: {
  options: ScopeOptionsPayload | null
  market: string
  scope: BudScopeValue
  onChange: (next: BudScopeValue) => void
  /** which dimensions the SERVER said it applied, in the order they narrowed */
  applied: string[]
  /** non-fatal facts about the grain — e.g. the portfolio blind spot */
  notes: string[]
  /** set when the combination can never resolve; the server writes the sentence */
  contradiction: string | null
}) {
  // 'all' is a real market value on this page, so the pickers must not filter to a marketplace that
  // does not exist. Every campaign is in scope when no market is chosen.
  const inMarket = useMemo(
    () => (options?.campaigns ?? []).filter((c) => market === 'all' || c.marketplace === market),
    [options, market],
  )

  // A line is offered only where it has a campaign in THIS market. Offering one that resolves to
  // zero rows would look like missing data rather than an empty scope.
  const productOpts = useMemo(() => {
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
    const lineCampaigns = scope.product
      ? new Set((options?.productLines ?? []).find((l) => l.id === scope.product)?.campaigns ?? [])
      : null
    return [{ value: '', label: 'All campaigns' }].concat(
      inMarket
        .filter((c) => (scope.portfolio ? c.portfolioId === scope.portfolio : true))
        .filter((c) => (lineCampaigns ? lineCampaigns.has(c.id) : true))
        .map((c) => ({ value: c.id, label: c.name })),
    )
  }, [inMarket, options, scope.product, scope.portfolio])

  const set = (patch: Partial<BudScopeValue>) => onChange({ ...scope, ...patch })
  const any = scope.product || scope.portfolio || scope.campaign

  return (
    <div className="h10-bud-scope">
      <div className="h10-bud-scoperow">
        <span className="h10-bud-lbl">Scope</span>

        <span className="h10-bud-field">
          <span className="cap">Product line</span>
          <H10Select options={productOpts} value={scope.product} onChange={(v) => set({ product: v, campaign: '' })} ariaLabel="Product line" width={210} />
        </span>

        <span className="h10-bud-field">
          <span className="cap">Portfolio</span>
          {/* Picking a portfolio clears the campaign, because the two are mutually exclusive and the
              campaign is the one that wins. Clearing it here means the operator never sees the
              server silently drop a grain they thought they had set. */}
          <H10Select options={pfOpts} value={scope.portfolio} onChange={(v) => set({ portfolio: v, campaign: '' })} ariaLabel="Portfolio" width={210} />
        </span>

        <span className="h10-bud-field">
          <span className="cap">Campaign</span>
          <H10Select options={campOpts} value={scope.campaign} onChange={(v) => set({ campaign: v, portfolio: '' })} ariaLabel="Campaign" width={260} searchable />
        </span>

        {any && (
          <button type="button" className="h10-bud-clear" onClick={() => onChange({ product: '', portfolio: '', campaign: '' })}>
            <X size={12} /> Clear scope
          </button>
        )}
      </div>

      {/* 🔴 The server's own sentence, displayed rather than paraphrased. `resolveScopeReach`
          refuses a combination that can never resolve and writes the reason; rewording it here
          would give the operator two explanations for one refusal. */}
      {contradiction && (
        <p className="h10-bud-note bad">
          <AlertTriangle size={12} />
          <span><b>Nothing can match this scope.</b> {contradiction}</span>
        </p>
      )}

      {/* The grains AND together, because that is what the evaluator does. Stated only when more
          than one is in play, since one grain cannot intersect with anything. */}
      {!contradiction && applied.length > 1 && (
        <p className="h10-bud-note">
          <Info size={12} />
          <span>
            <b>{applied.join(' + ')}</b>{' '}
            narrow these rows together — the same intersection a rule scoped this way would reach.
          </span>
        </p>
      )}

      {notes.map((n) => (
        <p className="h10-bud-note" key={n}>
          <Info size={12} />
          <span>{n.charAt(0).toUpperCase()}{n.slice(1)}.</span>
        </p>
      ))}
    </div>
  )
}
