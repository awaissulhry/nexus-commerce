'use client'

/**
 * Rank Goals list — the Dayparting Schedules tab's real content. Rank goals are AdSchedule rows
 * (GET /advertising/schedules, goal-mode), created by the Rank Goal builder; the legacy RuleListTab
 * only listed AutomationRule dayparting rules, so goal-mode schedules never appeared. This lists
 * them on the shared AdsDataGrid — same grid/filters/toolbar/customize/selection chrome as the
 * Apply Rules and Ads Manager grids — with a Manage link into the builder and persisted enable/pause.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, ExternalLink } from 'lucide-react'
import { AdsDataGrid, type GridColumn, type GridFilter } from '../../campaigns/_grid/AdsDataGrid'
import { NoDataIllus } from '../_shared/NoDataIllus'
import { getBackendUrl } from '@/lib/backend-url'

interface SchedWindow { targetKey?: string }
interface RankRow { id: string; name: string; baseline: string; baselineKey: string; windows: number; enabled: boolean }

const TARGET_LABEL: Record<string, string> = {
  'own-top': 'Own Top of Search', 'defend-top': 'Defend Top', 'rest-of-search': 'Rest of Search',
  'pause': 'Min bid', 'own-top-allout': 'Own Top — All-Out',
}
const label = (k: string | null | undefined) => (k ? (TARGET_LABEL[k] ?? k) : '—')
const isGoalMode = (s: { defaultTargetKey?: string | null; windows?: SchedWindow[] }) =>
  !!s.defaultTargetKey || (Array.isArray(s.windows) && s.windows.some((w) => !!w?.targetKey))
const builderHref = (id?: string) => `/marketing/ads/rules-automation/builder/dayparting-schedule${id ? `?scheduleId=${id}` : ''}`

export function RankGoalsList() {
  const [rows, setRows] = useState<RankRow[]>([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState<Set<string>>(new Set())

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/schedules`, { cache: 'no-store' }).then((r) => r.json())
        const all = (Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : []) as Array<Record<string, unknown>>
        const goals = all.filter((s) => isGoalMode(s as never)).map((s): RankRow => ({
          id: String(s.id),
          name: String(s.name ?? 'Rank goal'),
          baseline: label(s.defaultTargetKey as string | null),
          baselineKey: String(s.defaultTargetKey ?? ''),
          windows: Array.isArray(s.windows) ? (s.windows as SchedWindow[]).length : 0,
          enabled: s.enabled !== false,
        }))
        if (alive) setRows(goals)
      } catch { if (alive) setRows([]) }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])

  // Persisted enable/pause. Optimistic; reverts the row(s) if the PATCH fails.
  const setEnabled = useCallback(async (ids: string[], enabled: boolean) => {
    const idset = new Set(ids)
    setRows((rs) => rs.map((r) => (idset.has(r.id) ? { ...r, enabled } : r)))
    const results = await Promise.all(ids.map((id) =>
      fetch(`${getBackendUrl()}/api/advertising/schedules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) })
        .then((r) => r.ok).catch(() => false)))
    const failed = new Set(ids.filter((_, i) => !results[i]))
    if (failed.size) setRows((rs) => rs.map((r) => (failed.has(r.id) ? { ...r, enabled: !enabled } : r)))
  }, [])

  const columns: GridColumn<RankRow>[] = useMemo(() => [
    { key: 'baseline', label: 'Baseline rank', metric: false, sortable: true, sortValue: (r) => r.baseline, render: (r) => <span className="h10-nt-crit">{r.baseline}</span> },
    { key: 'windows', label: 'Windows', metric: true, sortable: true, sortValue: (r) => r.windows, render: (r) => <span>{r.windows}</span> },
    { key: 'status', label: 'Status', metric: false, sortable: true, sortValue: (r) => (r.enabled ? 0 : 1), render: (r) => <span className={`h10-pill ${r.enabled ? 'ok' : 'warn'}`}>{r.enabled ? 'Active' : 'Paused'}</span> },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [])

  const filters: GridFilter[] = useMemo(() => {
    const baselines = Array.from(new Set(rows.map((r) => r.baselineKey).filter(Boolean)))
    return [
      { key: 'status', label: 'Status', kind: 'select', placeholder: 'Any status', options: [{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }], value: (r) => ((r as RankRow).enabled ? 'active' : 'paused') },
      { key: 'baseline', label: 'Baseline', kind: 'multiselect', placeholder: 'Any baseline', options: baselines.map((k) => ({ value: k, label: label(k) })), value: (r) => (r as RankRow).baselineKey },
    ]
  }, [rows])

  const renderFirst = (r: RankRow) => (
    <span className="h10-nt-first">
      <span className="cp-name" title={r.name}>{r.name}</span>
      <span className="h10-nt-acts">
        <a className="h10-nt-open" href={builderHref(r.id)} onClick={(e) => e.stopPropagation()}><ExternalLink size={11} /> Manage</a>
      </span>
    </span>
  )

  return (
    <AdsDataGrid<RankRow>
      rows={rows}
      loading={loading}
      rowId={(r) => r.id}
      noun="Rank Goal"
      firstColLabel="Rank Goal"
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
        </span>
      )}
      customizable
      storageKey="rank-goals-grid"
      searchable
      searchPlaceholder="Search rank goals…"
      searchValue={(r) => r.name}
      pagerCentered
      defaultSort={{ key: '__first', dir: 'asc' }}
      emptyLabel="No rank goals yet."
      emptyNode={(
        <span className="h10-rr-empty">
          <NoDataIllus size={104} />
          <b>No rank goals yet — create one to hold a rank on a schedule.</b>
          <a className="h10-am-btn primary" href={builderHref()}><Plus size={13} /> Create Rank Goal</a>
        </span>
      )}
      toolbarRight={<a className="h10-am-btn primary" href={builderHref()}><Plus size={13} /> Rank Goal</a>}
    />
  )
}
