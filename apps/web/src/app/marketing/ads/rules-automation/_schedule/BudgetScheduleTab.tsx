'use client'

/**
 * Budget Schedules list tab — the "Hourly Campaign Performance" chart card (dual-metric,
 * no-data state until AMS hourly data lands) above the schedules grid (the shared AdsDataGrid):
 * Budget Schedule Name · Type · Days · Auto Refill · Start/End Date · Exclude Start/End Date.
 * Rows come from GET /advertising/budget-schedules (empty until the backend phase ships).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Eye, EyeOff, Search, Info, ExternalLink } from 'lucide-react'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { HoverCard } from '../../campaigns/FilterDropdown'
import { MetricSelect } from './MetricSelect'
import { getBackendUrl } from '@/lib/backend-url'

interface ScheduleRow { id: string; name: string; type: string; days: string; autoRefill: boolean; startDate: string; endDate: string; excludeStart: string; excludeEnd: string }

const TYPE_LABEL: Record<string, string> = { 'campaign-budget': 'Campaign Budget', 'budget-multiplier': 'Budget Multiplier' }

export function BudgetScheduleTab() {
  const router = useRouter()
  const [rows, setRows] = useState<ScheduleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [metric1, setMetric1] = useState('Spend')
  const [metric2, setMetric2] = useState('ACoS')
  const [chartOpen, setChartOpen] = useState(true)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/budget-schedules`).then((r) => r.json())
        const items = (Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : []) as Array<Record<string, unknown>>
        if (alive) setRows(items.map((s) => ({
          id: String(s.id), name: String(s.name ?? ''), type: TYPE_LABEL[String(s.type ?? '')] ?? String(s.type ?? '—'),
          days: String(s.days ?? '—'), autoRefill: !!s.autoRefill,
          startDate: s.startDate ? String(s.startDate) : '—', endDate: s.endDate ? String(s.endDate) : '—',
          excludeStart: s.excludeStart ? String(s.excludeStart) : '—', excludeEnd: s.excludeEnd ? String(s.excludeEnd) : '—',
        })))
      } catch { /* backend not live yet — empty */ }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])

  const columns: GridColumn<ScheduleRow>[] = useMemo(() => [
    { key: 'type', label: 'Type', metric: false, sortable: true, render: (r) => r.type },
    { key: 'days', label: 'Days', metric: false, sortable: false, render: (r) => r.days },
    { key: 'autoRefill', label: 'Auto Refill', metric: false, sortable: false, render: (r) => (r.autoRefill ? 'On' : 'Off') },
    { key: 'startDate', label: 'Start Date', metric: false, sortable: true, render: (r) => r.startDate },
    { key: 'endDate', label: 'End Date', metric: false, sortable: true, render: (r) => r.endDate },
    { key: 'excludeStart', label: 'Exclude Start Date', metric: false, sortable: false, render: (r) => r.excludeStart },
    { key: 'excludeEnd', label: 'Exclude End Date', metric: false, sortable: false, render: (r) => r.excludeEnd },
  ], [])

  const renderFirst = (r: ScheduleRow): ReactNode => (
    <span className="h10-nt-namew">
      <a className="h10-nt-name" href={`/marketing/ads/rules-automation/builder/budget-schedule?scheduleId=${r.id}`}>{r.name}</a>
      <a className="h10-nt-open" href={`/marketing/ads/rules-automation/builder/budget-schedule?scheduleId=${r.id}`}><ExternalLink size={11} /> Open</a>
    </span>
  )

  const newSchedule = () => router.push('/marketing/ads/rules-automation/builder/budget-schedule')

  return (
    <>
      <div className="h10-sb-listchart">
        <div className="hd">
          <b>Hourly Campaign Performance</b>
          <HoverCard text="Spend, ACoS and other metrics by hour of day — use it to decide when to raise or lower budgets." placement="below"><span className="i" aria-hidden="true"><Info size={14} /></span></HoverCard>
        </div>
        {chartOpen && (
          <div className="bd">
            <div className="controls">
              <MetricSelect value={metric1} onChange={setMetric1} dot="#0b2447" label="Metric 1" />
              <span className="grow" />
              <MetricSelect value={metric2} onChange={setMetric2} dot="#1f6fde" label="Metric 2" />
            </div>
            <div className="h10-sb-nodata">
              <span className="ill"><Search size={26} /></span>
              <span className="t">Hourly data is not available for this marketplace.</span>
            </div>
          </div>
        )}
      </div>

      <AdsDataGrid<ScheduleRow>
        rows={rows}
        loading={loading}
        rowId={(r) => r.id}
        noun="Schedule"
        firstColLabel="Budget Schedule Name"
        renderFirst={renderFirst}
        firstSortValue={(r) => r.name}
        columns={columns}
        selectable
        selected={sel}
        onSelectedChange={setSel}
        customizable={false}
        searchable
        searchPlaceholder="Search schedules…"
        searchValue={(r) => r.name}
        pagerCentered
        defaultSort={{ key: 'startDate', dir: 'desc' }}
        emptyLabel="No schedules created"
        toolbarRight={<>
          <button type="button" className="h10-sb-eye" aria-label={chartOpen ? 'Hide hourly chart' : 'Show hourly chart'} aria-pressed={chartOpen} onClick={() => setChartOpen((v) => !v)}>{chartOpen ? <Eye size={17} /> : <EyeOff size={17} />}</button>
          <button type="button" className="h10-am-btn primary" onClick={newSchedule}><Plus size={13} /> Rule</button>
        </>}
      />
    </>
  )
}
