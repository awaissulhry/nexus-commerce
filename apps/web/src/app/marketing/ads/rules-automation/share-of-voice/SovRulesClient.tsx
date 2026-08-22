'use client'

/**
 * U3 — the Share of Voice tab, reduced to Helium 10's shape: page header · tab bar · ONE rules card.
 *
 * Study `docs/2026-08-16-ra-h10-reference-study.md` §3.9 and §7.4. In H10 the SOV tab is a single
 * grid — "Showing 0 rules" · 🔍 · [+ Rule], columns ☐ · SOV Rule ⇅ · Automation · Criteria ·
 * Frequency (· SOV Reports), empty state "Create a rule to generate campaign suggestions" — and
 * nothing else. That is what this renders.
 *
 * 🔴 Like Placement, this tab GAINS a grid: SOV.0 removed `SovTrackerTab kind="sov"`, whose Rules
 * half could never render a row (`liveType="sov"` matched no key), and replaced the whole page with
 * the market-share report. Two fixes were needed to make the grid real, not just present:
 * `RULE_TAB_ACTION_TYPES` now HAS a `share-of-voice` entry (without one `ruleBelongsToTab` returns
 * false for every rule — grid and badge empty by construction), and it derives the builder slug
 * `sov`, so a rule created in `/builder/sov` appears on the tab it was created from.
 *
 * ⚖️ **D4, decided by measurement rather than left blocking (operator may overturn).** H10's grid
 * carries a sixth column, "SOV Reports", naming the SOV *report object* a rule reads — a thing you
 * create under Reporting, up to 20 per account, and a rule breaks when it is deleted. We have no
 * such object: our share is derived from the SQP feed per market, and a rule's market already lives
 * in its scope. A column that would restate the scope on every row is the decorative-column class
 * this programme exists to remove, so it is NOT rendered. If the operator wants SOV report objects
 * as a real thing, that is a build, not a column — say so and it becomes its own unit.
 *
 * The market-share report itself — the gate, freshness band, rejection reckoning, summary strip,
 * signal chips, the query grid with saved views and the row drawer — is PARKED in place
 * (`docs/2026-08-16-ra-parked-sections.md`), headed for Analytics › Coverage. No endpoint retired.
 */
import { useRouter, useSearchParams } from 'next/navigation'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs } from '../_shared/tabs'
import { RulesGrid } from '../_shared/RulesGrid'

const MARKETS = ['IT', 'DE', 'ES', 'FR']

export function SovRulesClient() {
  const router = useRouter()
  const params = useSearchParams()
  const market = params.get('market') || 'all'

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Share of Voice"
        subtitle="Rules that bid on share of voice — what each one does, and whether it acts on its own"
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => {
          const next = new URLSearchParams(params.toString())
          if (m && m !== 'all') next.set('market', m); else next.delete('market')
          const q = next.toString()
          router.replace(q ? `?${q}` : '?', { scroll: false })
        }}
        showDataSync={false}
        showDateRange={false}
        showChangeLog
      />
      <RulesTabs active="share-of-voice" />
      <RulesGrid
        tabKey="share-of-voice"
        noun="SOV Rule"
        builderHref="/marketing/ads/rules-automation/builder/sov"
        /* H10's SOV empty state differs from the other types — verbatim from the recording. */
        emptyLine="Create a rule to generate campaign suggestions"
      />
    </div>
  )
}
