'use client'

/**
 * U8 — the Budget Schedules tab, reduced to Helium 10's shape: page header · tab bar · ONE card in
 * two parts.
 *
 * Study `docs/2026-08-16-ra-h10-reference-study.md` §3.7 and §7.9. H10's Budget Schedules tab is:
 *   1. "Hourly Campaign Performance" — two metric pickers over an hourly chart
 *   2. the schedules grid — "Showing N Schedules" · 🔍 · 👁 · [+ Rule], columns Budget Schedule
 *      Name · Type · Days · Auto Refill · Start Date ⇅ · End Date ⇅ · Exclude Start · Exclude End
 * and nothing else. `SchedulesSection` renders both, and U8 made its chart real (see
 * `HourlyPerformanceCard.tsx` — it was a hard-coded "not available" sentence).
 *
 * ⚠ **This tab is NOT a rules grid**, so it does not mount `_shared/RulesGrid`: a budget schedule
 * is a `BudgetSchedule` row read from `/advertising/budget-schedules`, not an `AutomationRule`.
 * That is also why `RULE_TAB_ACTION_TYPES` still has no `budget-schedules` entry and this tab shows
 * no count badge — a rule count would be counting the wrong objects. U3/U4 added entries because
 * those tabs really do list rules; this one does not.
 *
 * ✅ **D5 is answered by the code, not by a build.** The schedule builder already offers both types
 * H10 has — "Campaign Budget — Set up an hourly schedule to adjust your campaign's budget" and
 * "Budget Multiplier — Set up a daily schedule to adjust your campaign's budget multiplier"
 * (`_schedule/scheduleConfig.ts`) — so U8 needed no builder work. Auto-Refill remains the one piece
 * of H10's budget-schedule feature we do not have; it is a builder/executor build, not a column,
 * and the grid's Auto Refill column shows what a schedule stores.
 *
 * The pacing band, the six section cards, the inspector rail and the plan editor are PARKED
 * (`docs/2026-08-16-ra-parked-sections.md`), headed for Budget Manager and Control Room.
 */
import { useRouter, useSearchParams } from 'next/navigation'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs } from '../_shared/tabs'
import { SchedulesSection } from './SchedulesSection'

const MARKETS = ['IT', 'DE', 'ES', 'FR']

export function BudgetSchedulesTabClient() {
  const router = useRouter()
  const params = useSearchParams()
  const market = params.get('market') || 'all'

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Budget Pacing & Schedules"
        subtitle="When budgets change through the day, and the schedules that change them"
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
      <RulesTabs active="budget-schedules" />
      {/* BSP-P2 — the market the header is showing now reaches the section. It did not before: the
          picker wrote `?market=` and nothing read it, so the grid and the hourly chart stayed
          account-wide under a header that said "Germany". */}
      <SchedulesSection market={market} />
    </div>
  )
}
