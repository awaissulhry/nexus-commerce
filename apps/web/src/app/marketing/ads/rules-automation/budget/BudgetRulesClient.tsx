'use client'

/**
 * U6 — the Budget tab, reduced to Helium 10's shape: page header · tab bar · ONE rules card.
 *
 * Study `docs/2026-08-16-ra-h10-reference-study.md` §3.5 and §7.7. In H10 the Budget tab is a single
 * grid — "Showing 0 Budget Rules" · 🔍 · [+ Rule], columns ☐ · Budget Rule ⇅ · Automation ·
 * Criteria · Frequency, empty state "Create a Budget Rule to generate suggestions for a campaign!" —
 * with no filters, no chips, no campaign grid and no baseline tool. That is what this renders.
 *
 * The tab keeps our label, "Budget Rules", until U10 applies D1's rename to "Budget": the label
 * lives in `RULES_TABS` and renaming it there is that unit's one-array edit, not this one's.
 *
 * ⚠ **What leaves this page, and what that does NOT mean.** The census, the campaign grid, the
 * Restore-to-baseline and Transfer actions and the guardrails/baseline card are parked. The €1-floor
 * ratchet warning goes with them — but it is not silenced: the same condition is stated on Budget
 * Pacing & Schedules and on Control Room › Activity, and the two AUTO rules that compound are
 * listed on THIS grid with their Automation toggle reading `auto`, which is the more actionable
 * framing of the same fact. Nothing about the budget write path changed; `ads-write-gate.ts` is
 * untouched and every endpoint is still served.
 */
import { useRouter, useSearchParams } from 'next/navigation'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs } from '../_shared/tabs'
import { RulesGrid } from '../_shared/RulesGrid'

const MARKETS = ['IT', 'DE', 'FR', 'ES']

export function BudgetRulesClient() {
  const router = useRouter()
  const params = useSearchParams()
  const market = params.get('market') || 'all'

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Budget Rules"
        subtitle="Rules that change budgets — what each one does, and whether it acts on its own"
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
      <RulesTabs active="budget" />
      <RulesGrid
        tabKey="budget"
        noun="Budget Rule"
        builderHref="/marketing/ads/rules-automation/builder/budget"
        emptyLine="Create a Budget Rule to generate suggestions for a campaign!"
      />
    </div>
  )
}
