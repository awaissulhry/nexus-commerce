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
import { Plus, ExternalLink, History } from 'lucide-react'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import { NoDataIllus } from '../_shared/NoDataIllus'
import { ScheduleActivityDrawer, isDrawerTab, type DrawerTab } from '../dayparting/ScheduleActivityDrawer'
import { ScheduleRowActions } from '../dayparting/ScheduleRowActions'
import { WeekShape } from '../dayparting/WeekShape'
import { TemplateLibrary } from '../dayparting/TemplateLibrary'
import { scheduleHealth, relTime, type Health } from '../dayparting/scheduleHealth'
import { useRdData } from '../dayparting/_rd/RdData'
import { useRdUrlState } from '../dayparting/_rd/useRdUrlState'
import { GRAIN_LABEL, boundBy, groupMatchesScope } from '../dayparting/_rd/scope'
import type { RdGroupScope } from '../dayparting/_rd/types'
import { getBackendUrl } from '@/lib/backend-url'

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
}
// RD.P0 — the RankTarget palette (and its built-in fallbacks) moved to the page's data layer, so
// the week strip, the drawer and every later section colour a key the same way.
const eur = (cents: number) => (cents === 0 ? '\u2014' : `\u20ac${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`)
const builderHref = (id?: string) => `/marketing/ads/rules-automation/builder/dayparting-schedule${id ? `?groupId=${id}` : ''}`

export function RankGoalsList() {
  // RD.P0 — the three fetches this component used to own (groups · rank-targets · portfolios) come
  // from the page's one data layer now, so `/rank-schedule-groups` is no longer requested twice per
  // page load and every later section reads the same rows this grid does.
  const { groups, targets: tmetaState, loading, refresh } = useRdData()
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
        }),
      }
    }))
  }, [groups, tmetaState])

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
    { key: 'campaigns', label: 'Campaigns', metric: true, sortable: true, sortValue: (r) => r.campaigns, render: (r) => <span>{r.campaigns}</span> },
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
      render: (r) => <span className={`h10-pill ${r.health.tone}`} title={r.health.detail}>{r.health.label}</span>,
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
      key: 'acos', label: 'ACoS 30d', metric: true, sortable: true, defaultHidden: true,
      // Unmeasurable sorts LAST rather than as 0%, which would read as perfect efficiency.
      sortValue: (r) => (r.acos == null ? Number.MAX_SAFE_INTEGER : r.acos),
      tip: 'Spend \u00f7 sales across the whole schedule. Derived from the summed totals, not averaged across campaigns.',
      render: (r) => (r.acos == null ? <span className="h10-rg-none" title="No attributed sales in the window">\u2014</span> : <span>{r.acos}%</span>),
      total: (rows) => {
        const c = rows.reduce((n, r) => n + r.spendCents, 0), sl = rows.reduce((n, r) => n + r.salesCents, 0)
        return <span>{sl > 0 ? `${Math.round((c / sl) * 1000) / 10}%` : '\u2014'}</span>
      },
    },
    { key: 'status', label: 'Status', metric: false, sortable: true, sortValue: (r) => (r.enabled ? 0 : 1), render: (r) => <span className={`h10-pill ${r.enabled ? 'ok' : 'warn'}`}>{r.enabled ? 'Active' : 'Paused'}</span> },
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

  const filters: GridFilter[] = useMemo(() => {
    const baselines = Array.from(new Set(rows.map((r) => r.baselineKey).filter(Boolean)))
    const nameOf = (k: string) => rows.find((r) => r.baselineKey === k)?.baseline ?? k
    return [
      { key: 'status', label: 'Status', kind: 'select', placeholder: 'Any status', options: [{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }], value: (r) => ((r as RankRow).enabled ? 'active' : 'paused') },
      // RDX/A3 — "show me only the schedules that are actually broken" is the first question this
      // page should be able to answer, so health is filterable, not just visible.
      { key: 'health', label: 'Health', kind: 'multiselect', placeholder: 'Any health', options: [{ value: 'bad', label: 'Writes failing' }, { value: 'warn', label: 'Needs attention' }, { value: 'ok', label: 'OK' }, { value: 'muted', label: 'Idle' }], value: (r) => (r as RankRow).health.tone },
      { key: 'baseline', label: 'Baseline', kind: 'multiselect', placeholder: 'Any baseline', options: baselines.map((k) => ({ value: k, label: nameOf(k) })), value: (r) => (r as RankRow).baselineKey },
    ]
  }, [rows])

  // Mirrors Ads Manager's first-column: a max-width name wrapper so a long name truncates with an
  // ellipsis and the hover Manage button stays inside the column (not spilling into the next one).
  const renderFirst = (r: RankRow) => (
    <span className="rg-namecell">
      <span className="rg-namew">
        <a className="h10-nt-name rg-name" href={builderHref(r.id)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} title={r.name}>{r.name}</a>
        <a className="h10-nt-open" href={builderHref(r.id)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}><ExternalLink size={11} /> Manage</a>
        {/* RDX/A4 — row click opens Activity too, but an explicit affordance keeps it discoverable
            next to Manage rather than relying on someone guessing the row is clickable. */}
        <button type="button" className="h10-nt-open hist" onClick={(e) => { e.stopPropagation(); openRow(r.id, 'activity') }}><History size={11} /> Activity</button>
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
      filtersDefaultOpen={false}
      selectable
      selected={sel}
      onSelectedChange={setSel}
      selectionActions={(ids, clear) => (
        <span className="h10-bulkrow">
          <button type="button" className="h10-am-btn bulk" onClick={() => { void setEnabled(ids, true); clear() }}>Enable</button>
          <button type="button" className="h10-am-btn bulk" onClick={() => { void setEnabled(ids, false); clear() }}>Pause</button>
          {/* F2 — the place N schedules are already selected is the place to apply one plan to
              all of them. No new page, no new nav. */}
          <button type="button" className="h10-am-btn bulk" onClick={() => setTplFor(ids)}>Apply template…</button>
        </span>
      )}
      customizable
      storageKey="rank-goals-grid"
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
          <a className="h10-am-btn primary" href={builderHref()}><Plus size={13} /> Create Rank Schedule</a>
        </span>
      )}
      toolbarRight={<a className="h10-am-btn primary" href={builderHref()}><Plus size={13} /> Rank Schedule</a>}
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
