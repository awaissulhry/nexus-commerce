'use client'

/**
 * BSP.0 — the scope spine: Portfolio · Campaign · Product line · Window.
 *
 * 🔴 Market is deliberately NOT here, and this is the fifth time a session has had to write that
 * sentence. `AdsPageHeader` renders a market picker on every ads page and `showMarket` does not
 * exist — re-verified 2026-08-12, six hits repo-wide and every one of them is a comment by a
 * session refusing this same instruction. The page owns one market state, passes it into the
 * header, and renders no second control for it. Two controls for one fact is what sank the scope
 * bar that was built, shipped and reverted on 2026-08-10.
 *
 * What the pinned pacing band does instead: its four market chips ARE a market control. Clicking a
 * chip sets `?market=`, clicking the selected one clears back to `all`. So market is always on
 * screen and always changeable while you scroll, which is what the sticky spine was for — without
 * a second dropdown.
 *
 * ── This is the FIFTH fork of this bar ─────────────────────────────────────────────────────────
 *
 * `KeywordScopeBar` (KT.1), `NegativeScopeBar` (NEG.1), `HarvestScopeBar` (HV.1) and `BidScopeBar`
 * (BID.S0) are the others. The brief asked for `automations/ScopeForm.tsx` to be promoted to
 * `_shared/` with a `mode: 'filter'` prop instead. It cannot be, for two reasons — the second of
 * which the brief missed:
 *
 *   1. `ScopeForm` is the rule-scope BINDING EDITOR. Its value type is `{scope*Id}` and it ends in
 *      a "Bind this scope" button that writes to a rule. A mode prop would not convert it into a
 *      filter; it would leave a binding editor wearing a filter's clothes.
 *   2. Its component consumer is `automations/RuleDetail.tsx:167`, not `AutomationsClient` — which
 *      imports only its types. Moving it is two edits inside another page's directory, which the
 *      parallel-session protocol reserves to that page's session.
 *
 * Recorded in session-locks §4 so the twelfth pass extracts one bar rather than finding a sixth.
 *
 * ── Reach is computed HERE ─────────────────────────────────────────────────────────────────────
 *
 * From `/advertising/scope-options`, using the same intersection `ruleMatchesScope` ANDs on the
 * server — so the count cannot disagree with what a rule scoped this way would reach, and there is
 * no round-trip per dropdown twiddle. The server still recomputes and refuses on write; this is the
 * honest preview, not the authority.
 */

import { useMemo } from 'react'
import { AlertTriangle, Info, X } from 'lucide-react'
import { H10Select } from '../../campaigns/FilterDropdown'
import { MAX_WEEKS, MIN_WEEKS } from './urlState'
import type { ResolvedScope, ScopeOptionsPayload } from './slot-contract'

export interface BspScopeValue {
  portfolio: string
  campaign: string
  line: string
}

/**
 * The AND of every grain in play, in one place, so the spine's count and every section's data read
 * the same set. Exported because the client hands the result to all six sections through the slot
 * contract rather than each of them re-deriving it.
 */
export function resolveScope(
  options: ScopeOptionsPayload | null,
  market: string,
  scope: BspScopeValue,
): ResolvedScope {
  const all = options?.campaigns ?? []
  const applied: string[] = []

  let ids = all
  if (market !== 'all') { ids = ids.filter((c) => c.marketplace === market); applied.push('Market') }
  if (scope.portfolio) { ids = ids.filter((c) => c.portfolioId === scope.portfolio); applied.push('Portfolio') }
  if (scope.campaign) { ids = ids.filter((c) => c.id === scope.campaign); applied.push('Campaign') }
  if (scope.line) {
    const line = (options?.productLines ?? []).find((l) => l.id === scope.line)
    const set = new Set(line?.campaigns ?? [])
    ids = ids.filter((c) => set.has(c.id))
    applied.push('Product line')
  }

  // A contradiction is stated only once the options have actually loaded. Before that, zero
  // campaigns means "not known yet", and calling that a contradiction would accuse the operator of
  // an impossible scope every time the page mounts.
  const contradiction = options && applied.length > 1 && ids.length === 0
    ? `No campaign satisfies ${applied.join(' + ')} at the same time. Each of them matches something on its own; together they match nothing.`
    : null

  return { campaignIds: ids.map((c) => c.id), applied, contradiction }
}

const WEEK_OPTIONS = [1, 2, 4, 8, 12, 26]
  .filter((w) => w >= MIN_WEEKS && w <= MAX_WEEKS)
  .map((w) => ({ value: String(w), label: w === 1 ? '1 week' : `${w} weeks` }))

export function BudgetScopeBar({
  options, market, scope, weeks, reach, onChange, onWeeks,
}: {
  options: ScopeOptionsPayload | null
  market: string
  scope: BspScopeValue
  weeks: number
  reach: ResolvedScope
  onChange: (next: BspScopeValue) => void
  onWeeks: (weeks: number) => void
}) {
  // 'all' is a real market value on this page, so the pickers must not narrow to a marketplace that
  // does not exist. Every campaign is in scope when no market is chosen.
  const inMarket = useMemo(
    () => (options?.campaigns ?? []).filter((c) => market === 'all' || c.marketplace === market),
    [options, market],
  )

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

  // A line is offered only where it has a campaign in THIS market. Offering one that resolves to
  // zero rows would read as missing data rather than as an empty scope.
  const lineOpts = useMemo(() => {
    const idsInMarket = new Set(inMarket.map((c) => c.id))
    return [{ value: '', label: 'All product lines' }].concat(
      (options?.productLines ?? [])
        .filter((l) => l.campaigns.some((c) => idsInMarket.has(c)))
        .map((l) => ({ value: l.id, label: `${l.sku} · ${l.variations} variation${l.variations === 1 ? '' : 's'}` })),
    )
  }, [options, inMarket])

  const set = (patch: Partial<BspScopeValue>) => onChange({ ...scope, ...patch })
  const narrowed = !!(scope.portfolio || scope.campaign || scope.line)
  const n = reach.campaignIds.length

  return (
    <div className="h10-bsp-spine">
      <span className="h10-bsp-lbl">Scope</span>

      <span className="h10-bsp-field">
        <span className="cap">Portfolio</span>
        {/* Choosing a portfolio clears the campaign: they are mutually exclusive under AND, and
            leaving a stale campaign selected would silently win over the portfolio just chosen. */}
        <H10Select options={pfOpts} value={scope.portfolio} onChange={(v) => set({ portfolio: v, campaign: '' })} ariaLabel="Portfolio" width={168} />
      </span>

      <span className="h10-bsp-field">
        <span className="cap">Campaign</span>
        <H10Select options={campOpts} value={scope.campaign} onChange={(v) => set({ campaign: v, portfolio: v ? '' : scope.portfolio })} ariaLabel="Campaign" width={200} searchable />
      </span>

      <span className="h10-bsp-field">
        <span className="cap">Product line</span>
        <H10Select options={lineOpts} value={scope.line} onChange={(v) => set({ line: v, campaign: '' })} ariaLabel="Product line" width={168} />
      </span>

      <span className="h10-bsp-field">
        <span className="cap">Window</span>
        {/* Weeks, because `/advertising/dayparting/heatmap` counts whole weeks so every weekday
            carries equal samples. A rolling day count would reintroduce the bias it avoids. */}
        <H10Select options={WEEK_OPTIONS} value={String(weeks)} onChange={(v) => onWeeks(Number(v))} ariaLabel="Time window" width={96} />
      </span>

      {narrowed && (
        <button type="button" className="h10-bsp-clear" onClick={() => onChange({ portfolio: '', campaign: '', line: '' })}>
          <X size={12} /> Clear
        </button>
      )}

      <span className="h10-bsp-reach">
        {options === null
          ? <span className="dim">resolving scope…</span>
          : <><b>{n.toLocaleString('en-IE')}</b> {n === 1 ? 'campaign' : 'campaigns'}</>}
      </span>
    </div>
  )
}

/**
 * The spine's explanation, rendered BELOW the sticky block rather than inside it.
 *
 * Inside, it would change the sticky element's height whenever a note appeared, and the whole
 * chrome budget for this page is 120px. Out here it scrolls with the content, which is right: a
 * sentence you read once does not need to follow you down the page.
 */
export function ScopeNote({ reach, market, scope }: { reach: ResolvedScope; market: string; scope: BspScopeValue }) {
  const narrowed = !!(scope.portfolio || scope.campaign || scope.line) || market !== 'all'
  if (reach.contradiction) {
    return (
      <p className="h10-bsp-note bad">
        <AlertTriangle size={12} />
        <span><b>Nothing can match this scope.</b> {reach.contradiction}</span>
      </p>
    )
  }
  if (!narrowed || reach.applied.length < 2) return null
  return (
    <p className="h10-bsp-note">
      <Info size={12} />
      <span>
        <b>{reach.applied.join(' + ')}</b> narrow these sections together — the same intersection a
        rule scoped this way would reach.
      </span>
    </p>
  )
}
