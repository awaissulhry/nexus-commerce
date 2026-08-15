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
import { useMemo } from 'react'
import { Plus } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { RankGrid } from './RankGrid'
import { HourlyPerformance, type ScopeOption } from './HourlyPerformance'
import { CoveragePanel, type ScheduleOption } from './CoveragePanel'
import { RdDataProvider, useRdData } from './_rd/RdData'
import { useRdUrlState } from './_rd/useRdUrlState'
import { RdSection } from './_rd/RdSection'
import { RdCeilings } from './RdCeilings'
import { RdFleetBand } from './RdFleetBand'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import './rank-dayparting.css'

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
  // RD.P0 — the header's market switch writes `?market=`, and the URL is the only state. It is the
  // one scope control the page ships: `?portfolio=`, `?product=` and `?grain=` are parsed and
  // honoured, but their pickers wait for P2 rather than becoming a fourth copy of a scope bar three
  // other sessions are already forking (locks §4).
  const { state: url, set: setUrl } = useRdUrlState()
  const market = url.market

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
        onMarketChange={(m) => setUrl({ market: m })}
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

      {/* ── The section map, structure doc §3, top to bottom ──────────────────────────────────
          Unbuilt sections are NOT MOUNTED. An empty placeholder card is dead space, and the
          standard for this foundation is that the page must look no worse than it did before. */}

      {/* P1 · Fleet state band — fleet grain. Five tiles, each a filter onto the grid;
          "unscheduled" stays with Coverage (P6), which owns that number. */}
      <RdFleetBand />

      {/* P2 · The grid — group ⇄ campaign. The section that fixes the page's structural flaw:
          the list is group-grained and every defect the study measured is campaign-grained.
          (P3's row inspector and P4's signal columns land inside this section.) */}
      <RdSection id="p2">
        <RankGrid />
      </RdSection>

      {/* P5 · Guardrails & scope ceilings — the CPC ceiling's refusals made visible; spend
          ceilings live on Automations → Limits (one owner) and the section says so. */}
      <RdCeilings />

      {/* P6 · Evidence — the hourly grid and what no schedule covers.
          It sits BELOW the grid now, which is the one visible change P0 makes: the page's own
          subject used to start at y=739 on a 793px viewport, i.e. entirely below the fold, while
          the evidence for it occupied the top 411px.
          RDX/D2 — `allSchedules` (not `scopes`): hours can be added to a plan holding no campaigns.
          RDX/C1 — the coverage gap, stated next to the evidence rather than above the schedules. */}
      <RdSection id="p6">
        <HourlyPerformance scopes={scopes} schedules={allSchedules} market={market} onScheduleChanged={refresh} />
        <CoveragePanel market={market} schedules={allSchedules} onChanged={refresh} />
      </RdSection>

      {/* P7 · Governance — events, versions, change log. */}
    </div>
  )
}
