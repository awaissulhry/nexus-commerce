'use client'

/**
 * RD.P2 — the Campaigns grain, which did not exist anywhere in the product.
 *
 * This is the section's whole point. The list has always been group-grained while every defect the
 * study measured is campaign-grained: one row called "IT GALE JACKET" hides eleven campaigns with
 * four different fates, and all eleven render `Health: OK`. Here they are eleven rows, and the ones
 * the CPC ceiling has pinned say so.
 *
 * 🔴 **Manage resolves to the PARENT SCHEDULE's builder URL.** A campaign has no `groupId` of its
 * own and there is no campaign-level builder route — inventing one would be a link to nothing. A
 * campaign whose parent cannot be resolved renders no Manage link at all rather than a dead one.
 */
import { useCallback, useMemo } from 'react'
import { ExternalLink, History } from 'lucide-react'
import { AdsDataGrid, type GridColumn, type FilterState } from '../../campaigns/_grid/AdsDataGrid'
import { NoDataIllus } from '../_shared/NoDataIllus'
import { ScheduleActivityDrawer, isDrawerTab, type DrawerTab } from './ScheduleActivityDrawer'
import { relTime } from './scheduleHealth'
import { useRdData } from './_rd/RdData'
import { useRdUrlState } from './_rd/useRdUrlState'
import { campaignMatchesScope } from './_rd/scope'
import { RD_TILE_KEYS, isTileKey, tileMatch } from './_rd/tiles'
import { rdFilters, rdFilterState, rdUrlPatch, rdFlattenBarChange } from './_rd/rdFilters'
import { GrainSwitch } from './_rd/GrainSwitch'
import { CeilingCell, GoalCell, ModeCell, PlacementCell, SignalCell } from './_rd/RuntimeCells'
import type { RdCampaignRow } from './_rd/types'

const builderHref = (groupId: string) => `/marketing/ads/rules-automation/builder/dayparting-schedule?groupId=${groupId}`

export function RankCampaignsGrid({ palette }: { palette: { color: (k: string) => string | null; name: (k: string) => string } }) {
  const { campaigns, groups, loading, clock, portfolioNames, productLines, scopeOptions } = useRdData()
  const { state: url, set: setUrl } = useRdUrlState()

  // P1 — the fleet band's tile filter composes with scope, through the SAME predicate the band
  // counted with, so a tile's number and its result cannot disagree. An unknown ?tile= value
  // filters nothing rather than blanking the grid.
  const inScope = useMemo(() => campaigns.filter((r) => campaignMatchesScope(r, url)), [campaigns, url])
  const rows = useMemo(
    () => inScope.filter((r) => !isTileKey(url.tile) || tileMatch(r, url.tile)),
    [inScope, url.tile],
  )
  // Counted with the band's own predicate, over the rows the SCOPE leaves — so every option in the
  // Fleet state select delivers exactly the number it advertises.
  const tileCounts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const k of RD_TILE_KEYS) out[k] = inScope.filter((r) => tileMatch(r, k)).length
    return out
  }, [inScope])

  // The inspector is still the SCHEDULE's — a campaign has no history of its own, and its next 24
  // hours are its parent plan's. Opening it from a campaign row is a link to the parent.
  const openRow = useCallback((r: RdCampaignRow, tab: DrawerTab) => {
    if (!r.groupId) return
    setUrl({ row: r.campaignId, drawer: tab }, { history: 'push' })
  }, [setUrl])
  const closeRow = useCallback(() => setUrl({ row: '', drawer: '' }, { history: 'push' }), [setUrl])

  const activity = useMemo(() => {
    if (!url.row) return null
    const r = rows.find((x) => x.campaignId === url.row)
    if (!r?.groupId) return null
    return { id: r.groupId, name: r.groupName ?? r.campaignName, tab: (isDrawerTab(url.drawer) ? url.drawer : 'next24') as DrawerTab }
  }, [rows, url.row, url.drawer])

  const lineLabel = useMemo(() => new Map(productLines.map((l) => [l.id, l.label.split(' · ')[0]])), [productLines])

  const columns: GridColumn<RdCampaignRow>[] = useMemo(() => [
    {
      key: 'schedule', label: 'Schedule', metric: false, sortable: true, sortValue: (r) => r.groupName ?? '',
      tip: 'The rank schedule that holds this campaign. One campaign, one schedule — the database enforces it.',
      render: (r) => (r.groupName
        ? <a className="h10-nt-name rd-trunc" href={`?grain=schedules&row=${r.groupId}`} onClick={(e) => { e.stopPropagation(); e.preventDefault(); setUrl({ grain: 'schedules', row: r.groupId ?? '', drawer: '' }) }} title={r.groupName}>{r.groupName}</a>
        : <span className="rd-none">—</span>),
    },
    {
      key: 'nowHolding', label: 'Now holding', metric: false, sortable: true, sortValue: (r) => r.runtime.activeTargetKey ?? '',
      tip: 'What this campaign resolves to at this hour, in its schedule’s own timezone, on the database clock the engine uses.',
      render: (r) => {
        const k = r.runtime.activeTargetKey
        if (!k) return <span className="rd-none" title="No window is open and no baseline is set.">—</span>
        return (
          <span className="h10-rg-chip" style={palette.color(k) ? { borderColor: palette.color(k) as string } : undefined} title={r.runtime.eventName ? `Event "${r.runtime.eventName}" is overriding the weekly plan` : palette.name(k)}>
            <span className="sw" style={{ background: palette.color(k) ?? '#99a1ac' }} />
            <span className="lbl">{palette.name(k)}</span>
          </span>
        )
      },
    },
    {
      key: 'mode', label: 'Mode', metric: false, sortable: true, sortValue: (r) => r.runtime.mode?.kind ?? 'zz',
      tip: 'What the controller will actually do this hour — derived from the engine’s own biasBand() and cpcCapPct(), not from the target’s name.',
      render: (r) => <ModeCell mode={r.runtime.mode} />,
    },
    {
      key: 'placement', label: 'Live placement', metric: false, sortable: true, defaultHidden: true, sortValue: (r) => r.runtime.placement?.top ?? -1,
      tip: 'The Top / Rest / Product multipliers Amazon currently holds. The Placement page owns these — this page only reports them.',
      render: (r) => <PlacementCell p={r.runtime.placement} />,
    },
    {
      key: 'goal', label: 'Goal vs actual', metric: false, sortable: true,
      sortValue: (r) => (r.runtime.goal?.live ? 0 : r.runtime.goal?.targetPct != null ? 1 : 2),
      tip: 'A dash means the controller never reads this goal — hover it for which of the two reasons applies.',
      render: (r) => <GoalCell goal={r.runtime.goal} />,
    },
    {
      key: 'signal', label: 'Signal', metric: false, sortable: true, sortValue: (r) => r.runtime.signal?.kind ?? 'zz',
      tip: 'The feedback lane the ACTIVE target drives, and how old it is. "No signal" and "no coverage" are different problems.',
      render: (r) => <SignalCell signal={r.runtime.signal} />,
    },
    {
      key: 'ceiling', label: 'Ceiling', metric: false, sortable: true,
      sortValue: (r) => (r.runtime.ceiling?.baseAlone ? 0 : r.runtime.ceiling?.binding ? 1 : 2),
      tip: 'The CPC ceiling, and whether it is the thing deciding this placement.',
      render: (r) => <CeilingCell ceiling={r.runtime.ceiling} />,
    },
    {
      key: 'market', label: 'Market', metric: false, sortable: true, defaultHidden: true, sortValue: (r) => r.marketplace ?? '',
      render: (r) => (r.marketplace ? <span className="h10-rg-mkts"><span className="mk">{r.marketplace}</span></span> : <span className="rd-none">—</span>),
    },
    {
      key: 'portfolio', label: 'Portfolio', metric: false, sortable: true, defaultHidden: true, sortValue: (r) => r.portfolioName ?? '',
      render: (r) => (r.portfolioId ? <span className="rd-trunc" title={r.portfolioName ?? ''}>{portfolioNames[r.portfolioId] ?? r.portfolioId}</span> : <span className="rd-none" title="This campaign carries no portfolio, so no portfolio-scoped rule can reach it.">—</span>),
    },
    {
      key: 'line', label: 'Product line', metric: false, sortable: true, defaultHidden: true, sortValue: (r) => r.productLineIds.join(','),
      render: (r) => (r.productLineIds.length
        ? <span className="rd-trunc" title={r.productLineIds.map((id) => lineLabel.get(id) ?? id).join(', ')}>{r.productLineIds.map((id) => lineLabel.get(id) ?? id).join(', ')}</span>
        : <span className="rd-none">—</span>),
    },
    {
      key: 'lastRun', label: 'Last run', metric: false, sortable: true, defaultHidden: true,
      sortValue: (r) => (r.lastEvaluatedAt ? -new Date(r.lastEvaluatedAt).getTime() : Number.MAX_SAFE_INTEGER),
      render: (r) => <span title={r.lastEvaluatedAt ? new Date(r.lastEvaluatedAt).toLocaleString() : 'Never evaluated'}>{relTime(r.lastEvaluatedAt)}</span>,
    },
    {
      key: 'health', label: 'Health', metric: false, sortable: true,
      sortValue: (r) => (r.runtime.canConverge ? 1 : 0),
      tip: 'Whether this campaign can reach what it is being asked to hold. Status only says whether it is switched on.',
      render: (r) => (r.runtime.canConverge
        ? <span className="h10-pill ok" title="Nothing is stopping this campaign from holding its target.">OK</span>
        : <span className="h10-pill warn" title={r.runtime.cannotConvergeReason ?? ''}>Cannot converge</span>),
    },
    {
      key: 'status', label: 'Status', metric: false, sortable: true, sortValue: (r) => (r.scheduleEnabled ? 0 : 1),
      render: (r) => <span className={`h10-pill ${r.scheduleEnabled ? 'ok' : 'warn'}`}>{r.scheduleEnabled ? 'Active' : 'Paused'}</span>,
    },
  ], [palette, portfolioNames, lineLabel, setUrl])

  // FB.3 — the panel moved to the page's one bar, above the fleet band. The grid still does every
  // bit of the filtering, off the same definitions the bar renders, out of the same URL store.
  const filters = useMemo(
    () => rdFilters({ options: scopeOptions, url, campaigns, tileCounts }),
    [scopeOptions, url, campaigns, tileCounts],
  )
  const filterState = useMemo(() => rdFilterState(url), [url])
  // FB.3c — the flatten moved into rdFilters (rdFlattenBarChange): three call sites, one copy.
  const setFilterState = useCallback(
    (next: FilterState) => setUrl(rdUrlPatch(rdFlattenBarChange(next))),
    [setUrl],
  )

  const renderFirst = (r: RdCampaignRow) => (
    <span className="rg-namecell">
      <span className="rg-namew">
        <span className="h10-nt-name rg-name rd-campname" title={r.campaignName}>{r.campaignName}</span>
        {/* Resolves to the PARENT schedule. No groupId → no link, rather than a link to nothing. */}
        {r.groupId && (
          <a className="h10-nt-open" href={builderHref(r.groupId)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
            <ExternalLink size={11} /> Manage
          </a>
        )}
        {r.groupId && (
          <button type="button" className="h10-nt-open hist" onClick={(e) => { e.stopPropagation(); openRow(r, 'activity') }}>
            <History size={11} /> Activity
          </button>
        )}
      </span>
    </span>
  )

  return (
    <>
      <AdsDataGrid<RdCampaignRow>
        rows={rows}
        loading={loading}
        rowId={(r) => r.campaignId}
        enabledFirst={(r) => !!r.scheduleEnabled}
        noun="Campaign"
        firstColLabel="Campaign"
        renderFirst={renderFirst}
        firstSortValue={(r) => r.campaignName}
        columns={columns}
        filters={filters}
        filterState={filterState}
        onFilterStateChange={setFilterState}
        hideFilterPanel
        // FB.3c — the checkboxes are GONE, not wired: this grain passed `selectable` with no
        // `selectionActions`, so every row carried a checkbox and an "N selected" count that could
        // do nothing — a dead affordance of exactly the class the silent-disabled work removes.
        // Bulk verbs for campaigns are a real later unit; the affordance returns WITH its actions.
        // 🔴 Explicit `false`: AdsDataGrid DEFAULTS selectable to true, so merely dropping the
        // prop ships the same dead checkboxes — measured on prod before this line existed.
        selectable={false}
        customizable
        // 🔴 Its OWN key. Sharing `rank-goals-grid` would apply a saved Schedules layout to a
        // fourteen-column grain and silently hide columns that do not exist in the other.
        storageKey="rank-campaigns-grid"
        searchable
        searchPlaceholder="Search campaigns…"
        searchValue={(r) => r.campaignName}
        pagerCentered
        defaultSort={{ key: '__first', dir: 'asc' }}
        toolbarLeft={<GrainSwitch schedules={groups.length} campaigns={campaigns.length} skewMinutes={clock?.skewMinutes ?? null} />}
        emptyLabel="No campaigns under rank control in this scope."
        emptyNode={(
          <span className="h10-rr-empty">
            <NoDataIllus size={104} />
            <b>No campaigns under rank control in this scope.</b>
            <span className="sub">{campaigns.length} campaign{campaigns.length === 1 ? '' : 's'} are held by a rank schedule — widen the scope to see them.</span>
          </span>
        )}
        onRowClick={(r) => openRow(r, 'next24')}
      />
      {activity && (
        <ScheduleActivityDrawer
          group={activity}
          palette={palette}
          initialTab={activity.tab}
          onTabChange={(t) => setUrl({ drawer: t })}
          onClose={closeRow}
        />
      )}
    </>
  )
}
