'use client'

/**
 * BID.S0 — the scope bar: Product line · Portfolio · Campaign.
 *
 * 🔴 Market is deliberately NOT here. `AdsPageHeader` already renders a market picker on every ads
 * page, and `showMarket` does not exist (re-verified 2026-08-12, zero hits repo-wide — the brief
 * asked for `showMarket={false}` and there is no such prop; it was reverted along with the scope
 * bar on 2026-08-10). The page owns one market state and passes it into the header; this bar reads
 * that same state and never renders a second control for it. Two controls for one fact is precisely
 * what sank the bar that was built, shipped and reverted.
 *
 * ── 🔴 This is the THIRD copy of this component, and that is a finding, not a style ─────────────
 *
 * `KeywordScopeBar` (KT.1) and `NegativeScopeBar` (NEG.1) are the other two, and they are the same
 * component down to the comments. The brief asked me to reuse `automations/ScopeForm.tsx` instead;
 * it cannot be reused, because it is not a filter bar — it is the rule-scope **binding editor**, it
 * holds `scope*Id` fields and it ends in a "Bind this scope" button that writes to a rule.
 *
 * Extracting a shared bar would mean editing two other sessions' page directories, which the
 * parallel-session protocol forbids. So: a third fork, recorded in session-locks §4 so the twelfth
 * pass extracts one bar rather than discovering a fourth.
 *
 * What this copy does differently, and deliberately: the **options** are the shared
 * `/advertising/scope-options` read that both siblings use, but the **resolution** is the server's
 * `resolveScopeReach` — the function the rule evaluator enforces with. The siblings cascade
 * most-specific-wins in their own service. On a page whose later sections are about rules as
 * exceptions, "the campaigns this view shows" and "the campaigns a rule scoped this way reaches"
 * had better be the same set, so this bar reports what the server applied rather than asserting its
 * own precedence rule.
 */

import { useMemo } from 'react'
import { AlertTriangle, Info, X } from 'lucide-react'
import { H10Select } from '../../campaigns/FilterDropdown'

export interface ScopeOptionsPayload {
  campaigns: Array<{ id: string; name: string; marketplace: string | null; portfolioId: string | null }>
  portfolios: Array<{ externalPortfolioId: string; name: string }>
  productLines: Array<{ id: string; sku: string; name: string; variations: number; campaigns: string[] }>
}

export interface BidScopeValue {
  line: string
  portfolio: string
  campaign: string
}

export function BidScopeBar({
  options, market, scope, onChange, applied, notes, contradiction,
}: {
  options: ScopeOptionsPayload | null
  market: string
  scope: BidScopeValue
  onChange: (next: BidScopeValue) => void
  /** which dimensions the SERVER said it applied, in the order they narrowed */
  applied: string[]
  /** non-fatal facts about the grain — e.g. the portfolio blind spot */
  notes: string[]
  /** set when the combination can never resolve; the server writes the sentence */
  contradiction: string | null
}) {
  // 'all' is a real market value on this page, so the pickers must not filter to a marketplace
  // that does not exist. Every campaign is in scope when no market is chosen.
  const inMarket = useMemo(
    () => (options?.campaigns ?? []).filter((c) => market === 'all' || c.marketplace === market),
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
        .map((c) => ({ value: c.id, label: c.name })),
    )
  }, [inMarket, options, scope.line, scope.portfolio])

  const set = (patch: Partial<BidScopeValue>) => onChange({ ...scope, ...patch })
  const any = scope.line || scope.portfolio || scope.campaign

  return (
    <div className="h10-bd-scope">
      <div className="h10-bd-scoperow">
        <span className="h10-bd-lbl">Scope</span>

        <span className="h10-bd-field">
          <span className="cap">Product line</span>
          <H10Select options={lineOpts} value={scope.line} onChange={(v) => set({ line: v, campaign: '' })} ariaLabel="Product line" width={210} />
        </span>

        <span className="h10-bd-field">
          <span className="cap">Portfolio</span>
          <H10Select options={pfOpts} value={scope.portfolio} onChange={(v) => set({ portfolio: v, campaign: '' })} ariaLabel="Portfolio" width={210} />
        </span>

        <span className="h10-bd-field">
          <span className="cap">Campaign</span>
          <H10Select options={campOpts} value={scope.campaign} onChange={(v) => set({ campaign: v })} ariaLabel="Campaign" width={260} searchable />
        </span>

        {any && (
          <button type="button" className="h10-bd-clear" onClick={() => onChange({ line: '', portfolio: '', campaign: '' })}>
            <X size={12} /> Clear scope
          </button>
        )}
      </div>

      {/* 🔴 The server's own sentence, displayed rather than paraphrased. `resolveScopeReach`
          refuses a combination that can never resolve and writes the reason; rewording it here
          would give the operator two explanations for one refusal. */}
      {contradiction && (
        <p className="h10-bd-note bad">
          <AlertTriangle size={12} />
          <span><b>Nothing can match this scope.</b> {contradiction}</span>
        </p>
      )}

      {/* Most-specific-wins is what the sibling pages SAY; this page ANDs, because that is what the
          evaluator does. Stated only when more than one grain is in play, since one grain cannot
          intersect with anything. */}
      {!contradiction && applied.length > 1 && (
        <p className="h10-bd-note">
          <Info size={12} />
          <span>
            <b>{applied.join(' + ')}</b>{' '}
            narrow these rows together — the same intersection a rule scoped this way would reach.
          </span>
        </p>
      )}

      {notes.map((n) => (
        <p className="h10-bd-note" key={n}>
          <Info size={12} />
          <span>{n.charAt(0).toUpperCase()}{n.slice(1)}.</span>
        </p>
      ))}
    </div>
  )
}
