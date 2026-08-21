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
import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs } from '../_shared/tabs'
import { RulesGrid } from '../_shared/RulesGrid'
import { getBackendUrl } from '@/lib/backend-url'

interface BudgetStrip {
  enabledCampaigns: number; atFloor: number; reachable: number
  baselines: number; windowDays: number; pacerWrites7d: number; ruleWrites7d: number
}

const MARKETS = ['IT', 'DE', 'FR', 'ES']

export function BudgetRulesClient() {
  const router = useRouter()
  const params = useSearchParams()
  const market = params.get('market') || 'all'
  /**
   * BUD-P4 — the strip. Server-censused (never recomposed from the grid's rows), and ABSENT on a
   * failed read rather than fabricated: a zero here would read as "nothing is at the floor" and
   * "no rule ever fires", which are the two claims this line exists to disprove.
   */
  const [strip, setStrip] = useState<BudgetStrip | null>(null)
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/budget-rules/strip`, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
        if (alive && j && typeof j.enabledCampaigns === 'number') setStrip(j)
      } catch { /* absent, not fabricated */ }
    })()
    return () => { alive = false }
  }, [])

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
      {strip && (
        <p className="h10-hv-cohortline">
          <b>{strip.enabledCampaigns.toLocaleString('en-IE')}</b> enabled campaigns · <b>{strip.reachable.toLocaleString('en-IE')}</b> with spend in the last {strip.windowDays} settled days, the most a budget rule can reach
          {strip.atFloor > 0 && <> · <b>{strip.atFloor.toLocaleString('en-IE')}</b> already at the €1 floor, where a cut does nothing</>}
          {strip.baselines > 0 && <> · <b>{strip.baselines.toLocaleString('en-IE')}</b> baselines captured</>}
          {strip.pacerWrites7d > 0 && (
            <> · budgets moved <b>{strip.pacerWrites7d.toLocaleString('en-IE')}×</b> in 7 days by{' '}
              <a className="h10-nt-open" href="/marketing/ads/budget-manager">Budget Manager pacing</a>
              {strip.ruleWrites7d === 0 ? ', not by any rule' : <> and <b>{strip.ruleWrites7d.toLocaleString('en-IE')}×</b> by rules</>}</>
          )}
          {' '}· rule output queues on <a className="h10-nt-open" href="/marketing/ads/suggestions">Suggestions</a>
        </p>
      )}
      <RulesGrid
        tabKey="budget"
        noun="Budget Rule"
        builderHref="/marketing/ads/rules-automation/builder/budget"
        emptyLine="Create a Budget Rule to generate suggestions for a campaign!"
      />
    </div>
  )
}
