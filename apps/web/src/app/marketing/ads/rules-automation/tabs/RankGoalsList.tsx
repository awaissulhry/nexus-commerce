'use client'

/**
 * Rank Goals list — the Dayparting Schedules tab's real content. Rank goals are stored as
 * AdSchedule rows (GET /advertising/schedules), created by the Rank Goal builder. The legacy
 * RuleListTab only listed AutomationRule-based dayparting rules, so goal-mode schedules never
 * appeared anywhere. This lists them (read-only) with a link back into the builder to manage.
 */
import { useEffect, useMemo, useState } from 'react'
import { Plus, ExternalLink } from 'lucide-react'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { getBackendUrl } from '@/lib/backend-url'

interface SchedWindow { days?: number[]; startHour?: number; endHour?: number; targetKey?: string }
interface RankRow { id: string; name: string; baseline: string; windows: number; enabled: boolean }

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

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/schedules`, { cache: 'no-store' }).then((r) => r.json())
        const all = (Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : []) as Array<Record<string, unknown>>
        const goals = all
          .filter((s) => isGoalMode(s as never))
          .map((s): RankRow => ({
            id: String(s.id),
            name: String(s.name ?? 'Rank goal'),
            baseline: label(s.defaultTargetKey as string | null),
            windows: Array.isArray(s.windows) ? (s.windows as SchedWindow[]).length : 0,
            enabled: s.enabled !== false,
          }))
        if (alive) setRows(goals)
      } catch { if (alive) setRows([]) }
    })()
    return () => { alive = false }
  }, [])

  const columns: GridColumn<RankRow>[] = useMemo(() => [
    { key: 'baseline', label: 'Baseline rank', metric: false, sortable: true, render: (r) => <span className="h10-nt-crit">{r.baseline}</span> },
    { key: 'windows', label: 'Windows', metric: false, sortable: true, render: (r) => <span className="h10-nt-freq"><b>{r.windows}</b><span>{r.windows === 1 ? 'window' : 'windows'}</span></span> },
    { key: 'status', label: 'Status', metric: false, sortable: false, render: (r) => <span className={`cp-badge ${r.enabled ? 'auto' : 'manual'}`}>{r.enabled ? 'Active' : 'Paused'}</span> },
  ], [])

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
      rowId={(r) => r.id}
      noun="Rank Goal"
      firstColLabel="Rank Goal"
      renderFirst={renderFirst}
      firstSortValue={(r) => r.name}
      columns={columns}
      selectable={false}
      customizable={false}
      searchable
      searchPlaceholder="Search rank goals…"
      searchValue={(r) => r.name}
      pagerCentered
      defaultSort={{ key: '__first', dir: 'asc' }}
      emptyLabel="No rank goals yet."
      emptyNode={(
        <span className="h10-rr-empty">
          <b>No rank goals yet — create one to hold a rank on a schedule.</b>
          <a className="h10-am-btn primary" href={builderHref()}><Plus size={13} /> Create Rank Goal</a>
        </span>
      )}
      toolbarRight={<a className="h10-am-btn primary" href={builderHref()}><Plus size={13} /> Rank Goal</a>}
    />
  )
}
