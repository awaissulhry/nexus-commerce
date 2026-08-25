'use client'

/**
 * Rank Schedules list — the Dayparting Schedules tab's real content. A rank schedule is now ONE
 * NAMED GROUP (RankScheduleGroup, GET /advertising/rank-schedule-groups) that binds MANY campaigns;
 * the API materializes one AdSchedule row per member for the rank-defend cron to run (engine
 * untouched), but this list shows a single named row per group with a member count — so "test over
 * 12 campaigns" is one row, not twelve. Rendered on the shared AdsDataGrid (same grid/filters/
 * toolbar/customize/selection chrome as Apply Rules + Ads Manager): a truncating name + Manage link
 * (contained in the sticky first column), a Campaigns count, a colored Baseline chip matching the
 * builder's target palette, and persisted group-level enable/pause.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Pill } from '@/design-system/primitives'
import { Plus, ExternalLink, History } from 'lucide-react'
import { AdsDataGrid, type GridColumn, type GridFilter, type FilterState } from '../../campaigns/_grid/AdsDataGrid'
import { rdFilters, rdFilterState, rdUrlPatch, rdFlattenBarChange, rdBaselineOptions } from '../dayparting/_rd/rdFilters'
import { NoDataIllus } from '../_shared/NoDataIllus'
import { ScheduleActivityDrawer, isDrawerTab, type DrawerTab } from '../dayparting/ScheduleActivityDrawer'
import { ScheduleRowActions } from '../dayparting/ScheduleRowActions'
import { WeekShape } from '../dayparting/WeekShape'
import { TemplateLibrary } from '../dayparting/TemplateLibrary'
import { scheduleHealth, relTime, type Health } from '../dayparting/scheduleHealth'
import { useRdData } from '../dayparting/_rd/RdData'
import { GrainSwitch } from '../dayparting/_rd/GrainSwitch'
import { ModeSpreadCell, SignalCell } from '../dayparting/_rd/RuntimeCells'
import type { RdGroupRuntime } from '../dayparting/_rd/types'
import { useRdUrlState } from '../dayparting/_rd/useRdUrlState'
import { GRAIN_LABEL, boundBy, groupMatchesScope } from '../dayparting/_rd/scope'
import type { RdGroupScope } from '../dayparting/_rd/types'
import { getBackendUrl } from '@/lib/backend-url'
import { pillTone } from '../../_shared/pillTone'

interface RankRow {
  id: string; name: string; baseline: string; baselineKey: string; baselineColor: string | null
  windows: number; campaigns: number; enabled: boolean; portfolioId: string | null; portfolioName: string | null
  // RDX/A3 — runtime from the group endpoint. `active*` is what the schedule resolves to RIGHT NOW
  // (recomputed server-side each request); `baseline*` above stays the out-of-window default. The
  // two differ exactly while a window is open, which is the whole point of showing both.
  activeKey: string; activeName: string; activeColor: string | null
  lastEvaluatedAt: string | null; health: Health
  // RDX/B1 — every market this group's member campaigns sit in. A SET, not a scalar: a
  // portfolio-scoped group can legitimately span IT + DE, and the stored column can't say so.
  marketplaces: string[]
  // RDX/B2 — the raw window array, kept so "Save as template" can persist the real shape rather
  // than the count the Windows column renders.
  windowsRaw: unknown[]
  // RDX/B4 — 30-day totals across the member campaigns. ACoS is derived server-side from the sums.
  spendCents: number; salesCents: number; orders: number; acos: number | null
  // RD.P0 — all four derived scope sets, so the row can be narrowed by any grain and not just by
  // market. `marketplaces` above stays because the Market COLUMN renders it.
  scope: RdGroupScope
  // RD.P2 — the campaign grain rolled up. Null while /rank-runtime is in flight, or for a group
  // holding no campaigns.
  runtime: RdGroupRuntime | null
}
// RD.P0 — the RankTarget palette (and its built-in fallbacks) moved to the page's data layer, so
// the week strip, the drawer and every later section colour a key the same way.
const eur = (cents: number) => (cents === 0 ? '\u2014' : `\u20ac${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`)
const builderHref = (id?: string) => `/marketing/ads/rules-automation/builder/dayparting-schedule${id ? `?groupId=${id}` : ''}`

export function RankGoalsList() {
  // RD.P0 — the three fetches this component used to own (groups · rank-targets · portfolios) come
  // from the page's one data layer now, so `/rank-schedule-groups` is no longer requested twice per
  // page load and every later section reads the same rows this grid does.
  const { groups, targets: tmetaState, loading, refresh, groupRuntime, campaigns, clock, scopeOptions } = useRdData()
  // RD.P0 — scope AND the open drawer come from the URL, so a schedule someone is looking at is a
  // link rather than a description of where to click.
  const { state: url, set: setUrl } = useRdUrlState()
  const market = url.market
  const [rows, setRows] = useState<RankRow[]>([])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [tplFor, setTplFor] = useState<string[] | null>(null) // F2 — bulk apply a template

  // Rows stay LOCAL state rather than a derived memo, because rename, delete and the optimistic
  // enable/pause below all reconcile in place — a round-trip and a flash of the loading state for
  // a fact the list already holds would be worse. `refresh()` re-seeds them from the server, which
  // is also what correctly discards an optimistic flip the server then rejected.
  useEffect(() => {
    setRows(groups.map((g): RankRow => {
      const meta = tmetaState[g.defaultTargetKey]
      const ameta = tmetaState[g.activeTargetKey]
      return {
        id: g.id,
        name: g.name,
        baseline: meta?.name ?? (g.defaultTargetKey || '—'),
        baselineKey: g.defaultTargetKey,
        baselineColor: meta?.color ?? null,
        windows: g.windowCount,
        campaigns: g.campaignCount,
        enabled: g.enabled,
        portfolioId: g.portfolioId,
        portfolioName: g.portfolioName,
        activeKey: g.activeTargetKey,
        activeName: ameta?.name ?? (g.activeTargetKey || '—'),
        activeColor: ameta?.color ?? null,
        lastEvaluatedAt: g.lastEvaluatedAt,
        // RDX/B1 — the DERIVED market set, not the stored scalar, which is null on 9 of 16 groups.
        marketplaces: g.scope.marketplaces,
        scope: g.scope,
        runtime: groupRuntime.get(g.id) ?? null,
        windowsRaw: g.windowsRaw,
        spendCents: g.performance.costCents,
        salesCents: g.performance.salesCents,
        orders: g.performance.orders,
        acos: g.performance.acos,
        health: scheduleHealth({
          enabled: g.enabled,
          lastEvaluatedAt: g.lastEvaluatedAt,
          failedWrites: g.failedWrites,
          governedElsewhere: g.governedElsewhere,
          membersTotal: g.membersTotal,
          // RD.P2 — the state this column most needed: running, and unable to reach its goal.
          cannotConverge: groupRuntime.get(g.id)?.cannotConverge ?? 0,
        }),
      }
    }))
  }, [groups, tmetaState, groupRuntime])

  // Persisted group-level enable/pause (PATCH cascades to every member schedule). Optimistic; reverts
  // the affected row(s) if the PATCH fails.
  const setEnabled = useCallback(async (ids: string[], enabled: boolean) => {
    const idset = new Set(ids)
    setRows((rs) => rs.map((r) => (idset.has(r.id) ? { ...r, enabled } : r)))
    const results = await Promise.all(ids.map((id) =>
      fetch(`${getBackendUrl()}/api/advertising/rank-schedule-groups/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) })
        .then((r) => r.ok).catch(() => false)))
    const failed = new Set(ids.filter((_, i) => !results[i]))
    if (failed.size) setRows((rs) => rs.map((r) => (failed.has(r.id) ? { ...r, enabled: !enabled } : r)))
  }, [])

  // HX.8 — one palette object, shared with the drawer so a historical week shape is coloured by the
  // same swatches as the live one. Memoised: passing a fresh object each render would re-run the
  // version list's diff memo on every keystroke in the grid's search box.
  const palette = useMemo(() => ({
    color: (k: string) => tmetaState[k]?.color ?? null,
    name: (k: string) => tmetaState[k]?.name ?? k,
  }), [tmetaState])

  // RDX/A4 + E1, now URL-driven. Only opens on a row that actually exists, so a stale `?row=` from
  // a deleted schedule renders the list rather than an empty drawer.
  const activity = useMemo(() => {
    if (!url.row) return null
    const r = rows.find((x) => x.id === url.row)
    return r ? { id: r.id, name: r.name, tab: (isDrawerTab(url.drawer) ? url.drawer : 'next24') as DrawerTab } : null
  }, [rows, url.row, url.drawer])
  // Opening and closing the inspector IS a navigation — pushed, so Back closes the drawer, which
  // is what someone who just opened one will press. Filter changes stay on replace.
  const openRow = useCallback((id: string, tab: DrawerTab) => setUrl({ row: id, drawer: tab }, { history: 'push' }), [setUrl])
  const closeRow = useCallback(() => setUrl({ row: '', drawer: '' }, { history: 'push' }), [setUrl])

  // RDX/B2 — local reconciliation after a row action. The list already holds everything the row
  // needs, so a full refetch would only cost a round-trip and a flash of the loading state.
  const renameRow = useCallback((id: string, name: string) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, name } : r)))
  }, [])
  const removeRow = useCallback((id: string) => {
    setRows((rs) => rs.filter((r) => r.id !== id))
    // A deleted row must not linger in the selection and get swept into a later bulk Enable/Pause.
    setSel((s) => { if (!s.has(id)) return s; const n = new Set(s); n.delete(id); return n })
  }, [])

  const columns: GridColumn<RankRow>[] = useMemo(() => [
    {
      key: 'baseline', label: 'Baseline rank', metric: false, sortable: true, sortValue: (r) => r.baseline,
      tip: 'The rank held outside every window — "for the rest of the week, hold Y".',
      render: (r) => (
        <span className="h10-rg-chip" style={r.baselineColor ? { borderColor: r.baselineColor } : undefined} title={r.baseline}>
          <span className="sw" style={{ background: r.baselineColor ?? '#99a1ac' }} />
          <span className="lbl">{r.baseline}</span>
        </span>
      ),
    },
    {
      // RDX/A3 — the column the page most obviously lacked. At 22:00 the list used to still read
      // "Rest of Search" because Baseline was the only rank shown; this is what the engine is
      // actually holding this hour, resolved server-side in the schedule's own timezone.
      key: 'nowHolding', label: 'Now holding', metric: false, sortable: true, sortValue: (r) => r.activeName,
      tip: 'The rank this schedule resolves to right now. Differs from Baseline while a window is open.',
      render: (r) => (
        r.activeKey
          ? (
            <span className={`h10-rg-chip ${r.activeKey !== r.baselineKey ? 'live' : ''}`} style={r.activeColor ? { borderColor: r.activeColor } : undefined} title={r.activeKey !== r.baselineKey ? `In a window — holding ${r.activeName} instead of the ${r.baseline} baseline` : r.activeName}>
              <span className="sw" style={{ background: r.activeColor ?? '#99a1ac' }} />
              <span className="lbl">{r.activeName}</span>
            </span>
          )
          : <span className="h10-rg-none" title="No window is open and no baseline is set, so this schedule holds nothing right now.">—</span>
      ),
    },
    {
      // RD.P2 — a SPREAD, never one collapsed word. "IT AIRMESH: 8 capped · 2 all-out" is the
      // sentence the page could not say: one row hid eleven campaigns with four different fates.
      key: 'mode', label: 'Mode', metric: false, sortable: true, sortValue: (r) => r.runtime?.modeSummary ?? 'zz',
      tip: 'What the controller will actually do this hour across this schedule\u2019s campaigns. Where they disagree, every state is listed.',
      render: (r) => (r.runtime
        ? <ModeSpreadCell summary={r.runtime.modeSummary} mixed={r.runtime.mixed} members={r.runtime.members} />
        : <span className="rd-none">—</span>),
    },
    {
      key: 'goal', label: 'Goal vs actual', metric: false, sortable: true,
      sortValue: (r) => -(r.runtime?.goalsLive ?? -1),
      tip: 'How many of this schedule\u2019s campaigns have a goal the controller actually reads. A dash means none do.',
      render: (r) => {
        if (!r.runtime) return <span className="rd-none">—</span>
        if (r.runtime.goalsLive === 0) {
          return <span className="rd-goal dead" title="No campaign in this schedule has a goal the controller reads — every one of them either holds a fixed placement or is all-out."><span className="v">—</span><span className="was">no goal is read</span></span>
        }
        return <span className="rd-goal" title={`${r.runtime.goalsLive} of ${r.runtime.members} campaigns are chasing a live goal.`}><b>{r.runtime.goalsLive}</b><span className="vs">of</span><span className="v">{r.runtime.members}</span><span className="unit">live</span></span>
      },
    },
    {
      key: 'signal', label: 'Signal', metric: false, sortable: true, sortValue: (r) => r.runtime?.signalSummary ?? 'zz',
      tip: 'The feedback lane the ACTIVE targets drive across this schedule. "No signal" and "no coverage" are different problems.',
      render: (r) => (r.runtime
        ? <SignalCell signal={{ kind: r.runtime.signalSummary.includes('coverage') ? 'no-coverage' : r.runtime.signalSummary.includes('no signal') ? 'no-signal' : 'top-is', lane: null, valuePct: null, ageDays: null, rows: null, label: r.runtime.signalSummary }} />
        : <span className="rd-none">—</span>),
    },
    {
      // RDX/B1 — the column that makes the header's market switch mean something. Multi-market
      // groups list every market rather than collapsing to the first one.
      key: 'market', label: 'Market', metric: false, sortable: true, sortValue: (r) => r.marketplaces.join(','),
      tip: 'The marketplaces this schedule\u2019s campaigns sit in, derived from the campaigns themselves.',
      render: (r) => (
        r.marketplaces.length === 0
          ? <span className="h10-rg-none" title="No market resolved — the member campaigns carry no marketplace.">—</span>
          : <span className="h10-rg-mkts">{r.marketplaces.map((m) => <span key={m} className="mk">{m}</span>)}</span>
      ),
    },
    /**
     * FB.3e — the count is a LINK into the campaigns grain, filtered to this schedule's members
     * (the `?schedule=` filter). Operator: "when I click on it it should change the view to
     * campaigns view and list me all the campaigns using the same rank rule." The patch clears
     * every campaigns-grain filter so the destination shows exactly this schedule's members —
     * `useRdUrlState.set` MERGES, and a leftover `?tile=`/`?mode=` would silently narrow it.
     */
    {
      key: 'campaigns', label: 'Campaigns', metric: true, sortable: true, sortValue: (r) => r.campaigns,
      tip: 'How many campaigns this schedule binds. Click a count to open those campaigns in the Campaigns view.',
      render: (r) => (
        <a
          className="nds-btn link" href={`?grain=campaigns&schedule=${r.id}`}
          title={`List ${r.campaigns} campaign${r.campaigns === 1 ? '' : 's'} bound to “${r.name}” in the Campaigns view`}
          onClick={(e) => {
            e.stopPropagation(); if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
            e.preventDefault()
            setUrl({ grain: 'campaigns', schedule: r.id, row: '', drawer: '', tile: '', mode: '', signal: '', converge: '', fresh: '', ceiling: '', cstatus: '', campaign: '' })
          }}
        >{r.campaigns}</a>
      ),
    },
    {
      // RDX/B3 — was `windows.length`. The key stays 'windows' so anyone with a saved column
      // layout keeps the column instead of silently losing it.
      key: 'windows', label: 'Week shape', metric: false, sortable: true, sortValue: (r) => r.windows,
      tip: 'When this schedule departs from its baseline. One row per weekday (Mon\u2013Sun), one cell per hour. Hover for the summary.',
      render: (r) => (
        <span className="h10-wkcell">
          <WeekShape
            windows={r.windowsRaw}
            baselineKey={r.baselineKey}
            colorOf={(k) => tmetaState[k]?.color ?? null}
            nameOf={(k) => tmetaState[k]?.name ?? k}
            baselineName={r.baseline}
          />
          <span className="n">{r.windows === 0 ? 'no windows' : `${r.windows} window${r.windows === 1 ? '' : 's'}`}</span>
        </span>
      ),
    },
    {
      // Sorts on the timestamp, renders the relative string — sorting on "4m ago" as text would
      // order it alphabetically. Never-run rows sort last rather than first.
      key: 'lastRun', label: 'Last run', metric: false, sortable: true,
      sortValue: (r) => (r.lastEvaluatedAt ? -new Date(r.lastEvaluatedAt).getTime() : Number.MAX_SAFE_INTEGER),
      tip: 'When the rank loop last evaluated this schedule. It runs every 15 minutes.',
      render: (r) => <span className={r.health.tone === 'warn' && r.health.label === 'Stale' ? 'h10-rg-warn' : undefined} title={r.lastEvaluatedAt ? new Date(r.lastEvaluatedAt).toLocaleString() : 'Never evaluated'}>{relTime(r.lastEvaluatedAt)}</span>,
    },
    {
      key: 'health', label: 'Health', metric: false, sortable: true,
      sortValue: (r) => ({ bad: 0, warn: 1, muted: 2, ok: 3 })[r.health.tone],
      tip: 'Whether this schedule is actually working. Status only tells you whether it is switched on.',
      render: (r) => <Pill tone={pillTone(r.health.tone)} title={r.health.detail}>{r.health.label}</Pill>,
    },
    // RDX/B4 — hidden by default: the page's job is control, and four metric columns would push
    // Health and Now-holding off a narrow screen. One click in Customise brings them back.
    {
      key: 'spend', label: 'Spend 30d', metric: true, sortable: true, defaultHidden: true,
      sortValue: (r) => r.spendCents, tip: 'Ad spend across this schedule\u2019s campaigns over the last 30 days.',
      render: (r) => <span>{eur(r.spendCents)}</span>,
      total: (rows) => <span>{eur(rows.reduce((n, r) => n + r.spendCents, 0))}</span>,
    },
    {
      key: 'sales', label: 'Sales 30d', metric: true, sortable: true, defaultHidden: true,
      sortValue: (r) => r.salesCents, tip: 'Attributed ad sales over the last 30 days.',
      render: (r) => <span>{eur(r.salesCents)}</span>,
      total: (rows) => <span>{eur(rows.reduce((n, r) => n + r.salesCents, 0))}</span>,
    },
    {
      /* FB.3e — VISIBLE now (operator decision, on recommendation): the grid stays a control
         surface, but ONE decision number rides beside the controls — ACoS answers "is this hold
         paying?" without a tab switch. Spend/Sales stay behind Customize. */
      key: 'acos', label: 'ACoS 30d', metric: true, sortable: true,
      // Unmeasurable sorts LAST rather than as 0%, which would read as perfect efficiency.
      sortValue: (r) => (r.acos == null ? Number.MAX_SAFE_INTEGER : r.acos),
      tip: 'Spend \u00f7 sales across the whole schedule. Derived from the summed totals, not averaged across campaigns.',
      render: (r) => (r.acos == null ? <span className="h10-rg-none" title="No attributed sales in the window">—</span> : <span>{r.acos}%</span>),
      total: (rows) => {
        const c = rows.reduce((n, r) => n + r.spendCents, 0), sl = rows.reduce((n, r) => n + r.salesCents, 0)
        return <span>{sl > 0 ? `${Math.round((c / sl) * 1000) / 10}%` : '\u2014'}</span>
      },
    },
    { key: 'status', label: 'Status', metric: false, sortable: true, sortValue: (r) => (r.enabled ? 0 : 1), render: (r) => <Pill tone={pillTone(r.enabled ? 'ok' : 'warn')}>{r.enabled ? 'Active' : 'Paused'}</Pill> },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [tmetaState])

  // RDX/B1 — the header's market switch, applied. Kept OUTSIDE the grid's own filter set on
  // purpose: it is a page-level scope that the heatmap above obeys too, not a column filter you
  // tick off in the Filters accordion. A group whose market can't be resolved is hidden by an
  // explicit market choice rather than leaking into every market.
  // RD.P0 — the scope contract, not just the market. `groupMatchesScope` matches on the DERIVED
  // sets, so a schedule holding one DE campaign answers yes to DE whatever its stored column says
  // (that column is null on 9 of 16 groups), and the narrowest grain picked decides alone.
  const visibleRows = useMemo(
    () => rows.filter((r) => groupMatchesScope(r, url)),
    [rows, url],
  )
  // Schedules exist, but none in the chosen market — a different situation from an empty account.
  const narrowedToEmpty = !loading && rows.length > 0 && visibleRows.length === 0
  // Name the grain that emptied the list, not always "market". Once `?portfolio=` or `?product=`
  // can narrow, "No rank schedules in IT" over a portfolio filter would send the operator to the
  // wrong control — and the market picker would show IT is not the problem.
  const narrowedBy = boundBy(url)
  const narrowedWhere = narrowedBy === 'market' ? market : `this ${GRAIN_LABEL[narrowedBy ?? 'market']}`

  /**
   * FB.3c (2026-08-20) — the duplicate "Filters" bar, closed.
   *
   * This grid used to hold its own Status / Health / Baseline definitions in `AdsDataGrid`'s
   * built-in panel — private state, not linkable, with a second Clear blind to the page bar's.
   * The operator saw two "Filters" cards on one page and reported it. The campaigns grain was
   * converted by FB.3; this file sits outside `dayparting/` and was missed.
   *
   * Same shape as `RankCampaignsGrid` now: definitions from the ONE module (`rdFilters`), value
   * from the URL, changes back to the URL, and the grid's own panel hidden. `RankRow` satisfies
   * `RdGoalsFilterRow` structurally — TypeScript checks the fit right here.
   */
  const filters: GridFilter[] = useMemo(
    () => rdFilters({
      options: scopeOptions, url, campaigns, tileCounts: {},
      baselineOptions: rdBaselineOptions(groups, (k) => tmetaState[k]?.name ?? k),
    }),
    [scopeOptions, url, campaigns, groups, tmetaState],
  )
  const filterState = useMemo(() => rdFilterState(url), [url])
  const setFilterState = useCallback(
    (next: FilterState) => setUrl(rdUrlPatch(rdFlattenBarChange(next))),
    [setUrl],
  )

  // Mirrors Ads Manager's first-column: a max-width name wrapper so a long name truncates with an
  // ellipsis and the hover Manage button stays inside the column (not spilling into the next one).
  const renderFirst = (r: RankRow) => (
    <span className="rg-namecell">
      <span className="rg-namew">
        {/* FB.3e — `rd-campname`: the SAME 240px name cap the campaigns grain wears, so switching
            grains no longer moves the first column (schedule names run to 144 characters). */}
        <a className="h10-nt-name rg-name rd-campname" href={builderHref(r.id)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={r.name}>{r.name}</a>
        <a className="h10-nt-open" href={builderHref(r.id)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}><ExternalLink size={11} /> Manage</a>
        {/* RDX/A4 — row click opens Activity too, but an explicit affordance keeps it discoverable
            next to Manage rather than relying on someone guessing the row is clickable. */}
        <Button size="xs" className="h10-nt-open hist" onClick={(e) => { e.stopPropagation(); openRow(r.id, 'activity') }}><History size={11} /> Activity</Button>
      </span>
      {r.portfolioName && <span className="rg-pfbadge" title={`Portfolio schedule · ${r.portfolioName}`}>Portfolio · {r.portfolioName}</span>}
      <ScheduleRowActions row={r} onRenamed={renameRow} onDeleted={removeRow} />
    </span>
  )

  return (
    <>
    <AdsDataGrid<RankRow>
      rows={visibleRows}
      loading={loading}
      rowId={(r) => r.id}
      enabledFirst={(r) => r.enabled}
      noun="Rank Schedule"
      firstColLabel="Rank Schedule"
      renderFirst={renderFirst}
      firstSortValue={(r) => r.name}
      columns={columns}
      filters={filters}
      filterState={filterState}
      onFilterStateChange={setFilterState}
      hideFilterPanel
      selectable
      selected={sel}
      onSelectedChange={setSel}
      selectionActions={(ids, clear) => (
        <span className="h10-bulkrow">
          <Button variant="ghost" onClick={() => { void setEnabled(ids, true); clear() }}>Enable</Button>
          <Button variant="ghost" onClick={() => { void setEnabled(ids, false); clear() }}>Pause</Button>
          {/* F2 — the place N schedules are already selected is the place to apply one plan to
              all of them. No new page, no new nav. */}
          <Button variant="ghost" onClick={() => setTplFor(ids)}>Apply template…</Button>
        </span>
      )}
      customizable
      // FB.3e — v2: AdsDataGrid restores hidden-column sets from localStorage, so ACoS 30d would
      // have stayed hidden for anyone with a saved layout. A new key trades one saved layout for
      // the column the operator asked to see.
      storageKey="rank-goals-grid-v2"
      searchable
      searchPlaceholder="Search rank schedules…"
      searchValue={(r) => r.name}
      pagerCentered
      defaultSort={{ key: '__first', dir: 'asc' }}
      emptyLabel={narrowedToEmpty ? `No rank schedules in ${narrowedWhere}.` : 'No rank schedules yet.'}
      // RDX/B1 — "no schedules yet" would be a lie when the account has 16 and you simply picked a
      // market none of them serve, and offering "Create Rank Schedule" there points at the wrong
      // fix. Narrowed-to-empty gets its own copy, and no CTA.
      emptyNode={narrowedToEmpty ? (
        <span className="h10-rr-empty">
          <NoDataIllus size={104} />
          <b>No rank schedules in {narrowedWhere}.</b>
          <span className="sub">{rows.length} schedule{rows.length === 1 ? '' : 's'} exist outside it — widen the scope to see them.</span>
        </span>
      ) : (
        <span className="h10-rr-empty">
          <NoDataIllus size={104} />
          <b>No rank schedules yet — create one named schedule to hold a rank across many campaigns.</b>
          <a className="nds-btn primary" href={builderHref()}><Plus size={13} /> Create Rank Schedule</a>
        </span>
      )}
      toolbarLeft={<GrainSwitch schedules={rows.length} campaigns={campaigns.length} skewMinutes={clock?.skewMinutes ?? null} />}
      toolbarRight={<a className="nds-btn primary" href={builderHref()}><Plus size={13} /> Rank Schedule</a>}
      /* RDX/E1 — a plain row click opens the forward view ("what is this about to do"), which is
         the more useful default; the explicit Activity button still opens the history it names. */
      onRowClick={(r) => openRow(r.id, 'next24')}
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
    {tplFor && (
      <TemplateLibrary
        groupIds={tplFor}
        groupNames={rows.filter((r) => tplFor.includes(r.id)).map((r) => r.name)}
        palette={palette}
        onClose={() => setTplFor(null)}
        // A template rewrites the plan, so the list's Week shape and window count are stale until
        // it reloads. RD.P0 — one refresh on the shared layer, so the sections above this grid see
        // the rewritten plan too rather than only the row that triggered it.
        onApplied={() => { setSel(new Set()); refresh() }}
      />
    )}
    </>
  )
}
