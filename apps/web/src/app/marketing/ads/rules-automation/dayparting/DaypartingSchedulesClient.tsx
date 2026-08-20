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
import { RdFleetBand } from './RdFleetBand'
import { useAdsSync } from '../_shared/adsBus'
import { AdsFilterBar } from '../../campaigns/_grid/AdsFilterBar'
import { rdFilters, rdFilterState, rdUrlPatch, rdFlattenBarChange, rdBaselineOptions } from './_rd/rdFilters'
import { campaignMatchesScope } from './_rd/scope'
import { RD_TILE_KEYS, tileMatch } from './_rd/tiles'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import './rank-dayparting.css'
import { useCursorBaseline, useCursorPoll } from '../_shared/useCursorPoll'
import { StaleBanner } from '../_shared/StaleBanner'
import { getBackendUrl } from '@/lib/backend-url'

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
  const { groups, campaigns, markets, scopeOptions, refresh, targets } = useRdData()

  // RT.1 — your own writes, from any tab, applied silently. Schedules and placement multipliers are
  // the two subjects this page renders; a plan edited on Placement moves rows here. An ENGINE's
  // 15-minute tick arrives on the other rail (the cursor poll) and offers a banner instead.
  useAdsSync(['ads.schedule.changed', 'ads.placement.changed'], refresh)
  // RD.P0 — the header's market switch writes `?market=`, and the URL is the only state.
  //
  // FB.3 — and the other three grains finally have controls. `?portfolio=`, `?line=` and
  // `?campaign=` were parsed and honoured from P0 and rendered NO picker, so the only way to
  // narrow this page by portfolio was to type the URL by hand. P0 declined to write a fourth copy
  // of the RA scope bar; the answer turned out to be not writing one at all — the grains are
  // selects in the shared filter bar, like the other ten pages.
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

  // RT.2 — the cursor. It carries the resolved PLAN and what the engine has APPLIED, never the
  // clock: the page's mode/capped values are hour-derived, so a cursor over the hour would fire
  // 24x a day. `applied` fires instead when the engine acts on the new hour — the moment the
  // stored data actually changes.
  const dpCursorParams = useMemo(() => {
    const p: Record<string, string> = { market: url.market }
    if (url.portfolio) p.portfolio = url.portfolio
    if (url.campaign) p.campaign = url.campaign
    return p
  }, [url.market, url.portfolio, url.campaign])
  const dpCursorUrl = `${getBackendUrl()}/api/advertising/dayparting/cursor`
  const dpBaseline = useCursorBaseline<Record<string, unknown>>(dpCursorUrl, dpCursorParams, groups.length)
  const dpRefresh = useCursorPoll<Record<string, unknown>>({ url: dpCursorUrl, params: dpCursorParams, baseline: dpBaseline })

  const subtitle = useMemo(() => rulesTabByKey('dayparting')?.subtitle ?? '', [])

  // FB.3 — the bar's definitions, from the same module the grid filters with. The tile counts are
  // the band's own predicate over the rows the scope leaves, so an option's number is what it
  // delivers. At schedules grain `rdFilters` returns the scope grains alone: the other three read
  // campaign runtime, and a schedule is a roll-up of many campaigns with no single mode of its own.
  const inScope = useMemo(() => campaigns.filter((r) => campaignMatchesScope(r, url)), [campaigns, url])
  const tileCounts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const k of RD_TILE_KEYS) out[k] = inScope.filter((r) => tileMatch(r, k)).length
    return out
  }, [inScope])
  const filters = useMemo(
    () => rdFilters({
      options: scopeOptions, url, campaigns, tileCounts,
      // FB.3c — the schedules grain's Baseline options, from the same builder the grid uses.
      baselineOptions: rdBaselineOptions(groups, (k) => targets[k]?.name ?? k),
    }),
    [scopeOptions, url, campaigns, tileCounts, groups, targets],
  )

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
      <StaleBanner stale={dpRefresh.stale} subject="A schedule, a rank target or the engine's applied state" onRefresh={refresh} />

      {/* FB.3c (2026-08-20) — the hourly evidence LEADS the page again, on the operator's explicit
          instruction: "the hourly performance has to be on the top of the page, above filters."
          This overrules P0's below-the-grid placement (which had answered a different complaint —
          the schedules starting below the fold). The card obeys the header's market switch and
          keeps its whole-weeks window in the URL, so what it shows is always what the address says. */}
      <RdSection id="hourly">
        <HourlyPerformance scopes={scopes} schedules={allSchedules} market={market} onScheduleChanged={refresh} />
      </RdSection>

      {/* FB.3 — ONE bar: controls, then the numbers they produce, then the rows. It holds the three
          scope grains always, plus the showing grain's own filters — Status / Health / Baseline /
          Windows at schedules grain (FB.3c: they lived in a SECOND "Filters" panel inside the grid,
          the duplicate the operator reported), and Fleet state / Mode / Signal / Convergence /
          Signal freshness / Ceiling / Campaign status / Schedule at campaigns grain. The fleet
          tiles below write the same `?tile=` this bar's Fleet state select does — one store, two
          affordances, so a tile and the select can no longer disagree about what is filtered. */}
      <AdsFilterBar
        filters={filters}
        value={rdFilterState(url)}
        onChange={(next) => setUrl(rdUrlPatch(rdFlattenBarChange(next)))}
        defaultOpen
      />

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

      {/* P5 · Guardrails — RETIRED as a section (FB.3c, operator: "there is no need for it").
          `RdCeilings` wrote nothing and duplicated facts the grid already carries; its unique
          reading — the base-bid-at-cap campaigns — is now the campaigns grain's Ceiling filter
          ("Base at cap"), where it is scoped, sortable and one click from the rows themselves.
          Spend ceilings keep their one owner: Automations → Limits. */}

      {/* P6 · Evidence — what no schedule covers. The hourly grid moved to the TOP of the page
          (operator instruction, FB.3c); the coverage gap stays down here beside the rows it
          describes. RDX/D2 — `allSchedules` (not `scopes`): hours can be added to a plan holding
          no campaigns. */}
      <RdSection id="p6">
        <CoveragePanel market={market} schedules={allSchedules} onChanged={refresh} />
      </RdSection>

      {/* P7 · Governance — events, versions, change log. */}
    </div>
  )
}
