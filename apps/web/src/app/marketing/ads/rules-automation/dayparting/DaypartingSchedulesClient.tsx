'use client'

/**
 * DPS.3 — "Rank & Dayparting Schedules" as its own page.
 *
 * Was tab #6 of a `useState` tab bar with no URL of its own. It is now a real route
 * (/marketing/ads/rules-automation/dayparting): deep-linkable, refresh-safe, back-button-correct.
 *
 * Chrome is deliberately identical to the index — same AdsPageHeader, same shared RulesTabs row —
 * so navigating between tabs reads as one section rather than a jump to a different kind of page.
 *
 * RD.P0 — the route now owns three things it did not before:
 *   · one data layer (`_rd/RdData`), so no section invents its own fetch and
 *     `/rank-schedule-groups` is not requested twice per load;
 *   · the scope contract (`_rd/scope`), four grains, most specific wins;
 *   · ordered section slots matching the approved structure doc §3.
 */
import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { RankGoalsList } from '../tabs/RankGoalsList'
import { HourlyPerformance, type ScopeOption } from './HourlyPerformance'
import { CoveragePanel, type ScheduleOption } from './CoveragePanel'
import { RdDataProvider, useRdData } from './_rd/RdData'

export function DaypartingSchedulesClient() {
  return (
    <RdDataProvider>
      <DaypartingSchedulesBody />
    </RdDataProvider>
  )
}

function DaypartingSchedulesBody() {
  // RD.P0 — markets, schedule pickers and the reload signal all come from the one layer. The two
  // fetches this component used to own are gone: `/advertising/campaigns?limit=500` (markets) is
  // covered by `/scope-options`, and `/rank-schedule-groups` was being fetched here AND in the grid.
  const { groups, markets, refresh } = useRdData()
  // U3 moves this into the URL (`?market=`). It stays local state for now so the switch keeps
  // working exactly as it does today — it was a dead control until RDX/B1 and must not become one
  // again on the way past.
  const [market, setMarket] = useState('all')

  // DPS.4 — the heatmap can be narrowed to one schedule, so it needs the schedule names. Only
  // groups that actually hold campaigns can produce a heatmap, so empty ones are left out.
  const scopes = useMemo<ScopeOption[]>(
    () => groups.filter((g) => g.campaignCount > 0).map((g) => ({ value: g.id, label: g.name })),
    [groups],
  )
  // RDX/C1 — the coverage panel can add a campaign to ANY schedule, including one that currently
  // holds none, so it needs the unfiltered list (unlike the heatmap scope above).
  const allSchedules = useMemo<ScheduleOption[]>(
    () => groups.map((g) => ({ value: g.id, label: g.name })),
    [groups],
  )

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
      <HourlyPerformance scopes={scopes} schedules={allSchedules} market={market} onScheduleChanged={refresh} />
      {/* RDX/C1 — the gap, stated between the evidence and the schedules that act on it. */}
      <CoveragePanel market={market} schedules={allSchedules} onChanged={refresh} />
      <RankGoalsList market={market} />
    </div>
  )
}
