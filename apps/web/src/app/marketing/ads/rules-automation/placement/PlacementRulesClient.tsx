'use client'

/**
 * U2 — the Placement tab, reduced to Helium 10's shape: page header · tab bar · ONE rules card.
 *
 * Study `docs/2026-08-16-ra-h10-reference-study.md` §3.8 and §7.3. In H10 the Placement tab is a
 * single grid — "Showing 0 Placement Rules" · 🔍 · [+ Rule], columns ☐ · Placement Rule ⇅ ·
 * Automation · Criteria · Frequency, empty state "Create a Placement Rule to generate suggestions
 * for a campaign!" — and nothing else. That is what this renders.
 *
 * 🔴 This tab GAINS a rules grid rather than trading one: PLC.0 removed the old
 * `RuleListTab liveType="placement"` and never replaced it, so since then the eight placement rules
 * have had no home on their own tab (they were reachable only via Automations). The grid is back,
 * and it is the shared one.
 *
 * The lane grid, the census cells, the lane split, "the hour", the inspector rail and the bulk
 * panel are PARKED in place (unmounted, PARKED headers, register
 * `docs/2026-08-16-ra-parked-sections.md`). Nothing was deleted and no endpoint retired — including
 * the PLC.3 write path (`PATCH /placements/:id/lane`), which is untouched and still served; this
 * page simply does not write multipliers, which is H10's shape too.
 */
import { useRouter, useSearchParams } from 'next/navigation'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs } from '../_shared/tabs'
import { RulesGrid } from '../_shared/RulesGrid'

const MARKETS = ['IT', 'DE', 'ES', 'FR']

export function PlacementRulesClient() {
  const router = useRouter()
  const params = useSearchParams()
  const market = params.get('market') || 'all'

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Placement"
        /* The tab's stored subtitle describes the lane grid that is now parked ("which lane your
           ads show in, what each one is worth"). This page is the rule list, so it says that. */
        subtitle="Rules that change placement modifiers — what each one does, and whether it acts on its own"
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => {
          const next = new URLSearchParams(params.toString())
          if (m && m !== 'all') next.set('market', m); else next.delete('market')
          const q = next.toString()
          router.replace(q ? `?${q}` : '?', { scroll: false })
        }}
        showDataSync={false}
        /* No date control: a rule list carries no windowed metric. The parked lane grid owned the
           date range, and it went with it. */
        showDateRange={false}
        showChangeLog
      />
      <RulesTabs active="placement" />
      <RulesGrid
        tabKey="placement"
        noun="Placement Rule"
        builderHref="/marketing/ads/rules-automation/builder/placement"
        emptyLine="Create a Placement Rule to generate suggestions for a campaign!"
      />
    </div>
  )
}
