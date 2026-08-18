'use client'

/**
 * U4 — the Keyword Tracker tab, reduced to Helium 10's shape: page header · tab bar · ONE rules card.
 *
 * Study `docs/2026-08-16-ra-h10-reference-study.md` §3.10 and §7.5. In H10 the Keyword Tracker tab
 * is a single grid — "Showing 0 Keyword Tracker rules" · 🔍 · [+ Rule], columns ☐ · Keyword Tracker
 * Rule ⇅ · Automation · Criteria · Frequency, empty state "Create a Keyword Tracker Rule to
 * generate campaign suggestions" — and nothing else. That is what this renders.
 *
 * 🔴 Same mandatory fix as U3: `RULE_TAB_ACTION_TYPES` now HAS a `keyword-tracker` entry. Without
 * one `ruleBelongsToTab` returns false for every rule, so the grid and the badge would be empty by
 * construction and a rule created in `/builder/keyword-tracker` could never appear on the tab it
 * was created from.
 *
 * The rank report — the one-market gate, feed-health line, watchlist panel, the term grid and the
 * per-term drawer (chart · our ASINs · campaigns bidding it · bid action · change log) — is PARKED
 * in place (`docs/2026-08-16-ra-parked-sections.md`), headed for Analytics › Coverage, with the
 * watchlist itself belonging in the builder's Setup step (H10 puts "+ Create New Keyword Tracker"
 * exactly there). No endpoint retired.
 *
 * ⚠ The header keeps the market picker but drops this page's old one-market GATE. The gate existed
 * because every number on the rank report is a per-marketplace quantity with no honest sum; a rule
 * list has no such number, and refusing to show rules until a market is picked would be a ceremony
 * with nothing behind it.
 */
import { useRouter, useSearchParams } from 'next/navigation'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs } from '../_shared/tabs'
import { RulesGrid } from '../_shared/RulesGrid'

const MARKETS = ['IT', 'DE', 'ES', 'FR']

export function KeywordTrackerRulesClient() {
  const router = useRouter()
  const params = useSearchParams()
  const market = params.get('market') || 'all'

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Keyword Tracker"
        subtitle="Rules that bid on organic and paid rank — what each one does, and whether it acts on its own"
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => {
          const next = new URLSearchParams(params.toString())
          if (m && m !== 'all') next.set('market', m); else next.delete('market')
          const q = next.toString()
          router.replace(q ? `?${q}` : '?', { scroll: false })
        }}
        showLearn={false}
        showDataSync={false}
        showDateRange={false}
        showChangeLog
      />
      <RulesTabs active="keyword-tracker" />
      <RulesGrid
        tabKey="keyword-tracker"
        noun="Keyword Tracker Rule"
        builderHref="/marketing/ads/rules-automation/builder/keyword-tracker"
        /* H10's KT empty state, verbatim — "campaign suggestions", not "suggestions for a campaign". */
        emptyLine="Create a Keyword Tracker Rule to generate campaign suggestions"
      />
    </div>
  )
}
