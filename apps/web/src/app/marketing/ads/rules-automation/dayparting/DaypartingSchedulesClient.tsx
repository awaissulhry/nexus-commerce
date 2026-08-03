'use client'

/**
 * DPS.3 — "Rank & Dayparting Schedules" as its own page.
 *
 * Was tab #6 of a `useState` tab bar with no URL of its own. It is now a real route
 * (/marketing/ads/rules-automation/dayparting): deep-linkable, refresh-safe, back-button-correct.
 *
 * Chrome is deliberately identical to the index — same AdsPageHeader, same shared RulesTabs row —
 * so navigating between tabs reads as one section rather than a jump to a different kind of page.
 * The body is the existing RankGoalsList, moved across unchanged.
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { RankGoalsList } from '../tabs/RankGoalsList'
import { HourlyPerformance, type ScopeOption } from './HourlyPerformance'
import { CoveragePanel, type ScheduleOption } from './CoveragePanel'
import { getBackendUrl } from '@/lib/backend-url'

export function DaypartingSchedulesClient() {
  // The header's market switch is fed by the campaigns the account actually has, matching the index.
  const [markets, setMarkets] = useState<string[]>([])
  const [market, setMarket] = useState('all')
  // DPS.4 — the heatmap can be narrowed to one schedule, so it needs the schedule names. Only
  // groups that actually hold campaigns can produce a heatmap, so empty ones are left out.
  const [scopes, setScopes] = useState<ScopeOption[]>([])
  // RDX/C1 — the coverage panel can add a campaign to ANY schedule, including one that currently
  // holds none, so it needs the unfiltered list (unlike the heatmap scope above).
  const [allSchedules, setAllSchedules] = useState<ScheduleOption[]>([])
  // Adding campaigns changes member counts in the list below, so the panel nudges it to reload
  // rather than leaving a stale count on screen.
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let alive = true
    void fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return
        const items = (Array.isArray(d?.items) ? d.items : []) as Array<{ marketplace?: string | null }>
        setMarkets(Array.from(new Set(items.map((c) => c.marketplace).filter(Boolean))) as string[])
      })
      .catch(() => {})
    void fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return
        const items = (Array.isArray(d?.items) ? d.items : []) as Array<{ id?: string; name?: string; campaignCount?: number }>
        setScopes(items
          .filter((g) => g.id && Number(g.campaignCount ?? 0) > 0)
          .map((g) => ({ value: String(g.id), label: String(g.name ?? g.id) })))
        setAllSchedules(items
          .filter((g) => g.id)
          .map((g) => ({ value: String(g.id), label: String(g.name ?? g.id) })))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const subtitle = useMemo(() => rulesTabByKey('dayparting')?.subtitle ?? '', [])

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Rules & Automation"
        subtitle={subtitle}
        markets={markets}
        market={market}
        onMarketChange={setMarket}
        // The rank schedules are the origin of almost every recorded change, so this is the page
        // where the account log is worth one click away.
        showChangeLog
        showLearn={false}
        showDataSync={false}
        showDateRange={false}
        // Without an explicit primary the header falls back to an "Action ▾" dropdown, which on this
        // page would open EMPTY (no `actions` to put in it). The section's one creation verb is
        // making a schedule, so name it — same slot the index uses for "+ Rule".
        primaryAction={{ label: 'Rank Schedule', icon: <Plus size={15} />, href: '/marketing/ads/rules-automation/builder/dayparting-schedule' }}
      />
      <RulesTabs active="dayparting" />
      {/* Look first, author second — the grid sits above the list of schedules it justifies.
          RDX/B1 — both now receive `market`. Until B1 the header's market switch was a dead
          control: it held state, rendered, accepted clicks, and nothing consumed it. */}
      {/* RDX/D2 — `allSchedules` (not `scopes`): hours can be added to a plan holding no campaigns. */}
      <HourlyPerformance scopes={scopes} schedules={allSchedules} market={market} onScheduleChanged={() => setReload((n) => n + 1)} />
      {/* RDX/C1 — the gap, stated between the evidence and the schedules that act on it. */}
      <CoveragePanel market={market} schedules={allSchedules} onChanged={() => setReload((n) => n + 1)} />
      <RankGoalsList market={market} reloadSignal={reload} />
    </div>
  )
}
