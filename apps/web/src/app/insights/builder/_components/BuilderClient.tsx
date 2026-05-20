'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ChevronLeft, Plus, Save, Trash2 } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import {
  BreakdownBar,
  BreakdownPie,
  InsightsHeader,
  KPICard,
  TableWithSparkline,
  TrendChart,
  formatCurrency,
  formatNum,
  readFilterState,
  trendColor,
  type InsightsFilterState,
  type TableColumn,
} from '@/components/insights'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

type Dimension =
  | 'channel'
  | 'market'
  | 'brand'
  | 'productType'
  | 'fulfillment'
  | 'date'
type Metric = 'revenue' | 'orders' | 'units' | 'aov'
type Viz = 'bar' | 'pie' | 'table' | 'trend'

interface SavedReport {
  id: string
  name: string
  dimension: Dimension
  metric: Metric
  viz: Viz
  createdAt: string
}

const STORAGE_KEY = 'insights.builder.v1'

const DIMENSION_LABEL: Record<Dimension, string> = {
  channel: 'Channel',
  market: 'Market',
  brand: 'Brand',
  productType: 'Product type',
  fulfillment: 'Fulfillment',
  date: 'Date',
}

const METRIC_LABEL: Record<Metric, string> = {
  revenue: 'Revenue',
  orders: 'Orders',
  units: 'Units',
  aov: 'AOV',
}

const VIZ_LABEL: Record<Viz, string> = {
  bar: 'Bar',
  pie: 'Donut',
  table: 'Table',
  trend: 'Trend (date only)',
}

interface SalesBucket {
  key: string
  label: string
  revenue: number
  orders: number
  units: number
  share: number
  deltaPct: number | null
}

interface SalesReport {
  window: { from: string; to: string }
  currency: string
  totals: { revenue: number; orders: number; units: number; aov: number }
  trend: Array<{ date: string; revenue: number; ordersCount: number; units: number }>
  byChannel: SalesBucket[]
  byMarket: SalesBucket[]
  byBrand: SalesBucket[]
  byProductType: SalesBucket[]
  byFulfillment: SalesBucket[]
}

function loadSaved(): SavedReport[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as SavedReport[]) : []
  } catch {
    return []
  }
}

function persistSaved(list: SavedReport[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
}

function bucketsFor(report: SalesReport, dim: Dimension): SalesBucket[] {
  switch (dim) {
    case 'channel':
      return report.byChannel
    case 'market':
      return report.byMarket
    case 'brand':
      return report.byBrand
    case 'productType':
      return report.byProductType
    case 'fulfillment':
      return report.byFulfillment
    case 'date':
      return []
  }
}

function buildQuery(state: InsightsFilterState): URLSearchParams {
  const p = new URLSearchParams()
  if (state.window) p.set('window', state.window)
  if (state.from) p.set('from', state.from)
  if (state.to) p.set('to', state.to)
  if (state.compare) p.set('compare', state.compare)
  if (state.channels.length) p.set('channels', state.channels.join(','))
  if (state.markets.length) p.set('markets', state.markets.join(','))
  if (state.brands.length) p.set('brands', state.brands.join(','))
  return p
}

export default function BuilderClient() {
  const params = useSearchParams()
  const filterState = readFilterState(
    new URLSearchParams(params?.toString() ?? ''),
  )

  const [report, setReport] = useState<SalesReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [nonce, setNonce] = useState(0)

  const [dimension, setDimension] = useState<Dimension>('channel')
  const [metric, setMetric] = useState<Metric>('revenue')
  const [viz, setViz] = useState<Viz>('bar')
  const [reportName, setReportName] = useState('')
  const [saved, setSaved] = useState<SavedReport[]>([])

  useEffect(() => {
    setSaved(loadSaved())
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (report) setRefreshing(true)
      try {
        const qs = buildQuery(filterState).toString()
        const res = await fetch(`${getBackendUrl()}/api/insights/sales?${qs}`, {
          credentials: 'include',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json: SalesReport = await res.json()
        if (!cancelled) {
          setReport(json)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed')
      } finally {
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filterState.window,
    filterState.from,
    filterState.to,
    filterState.compare,
    filterState.channels.join(','),
    filterState.markets.join(','),
    filterState.brands.join(','),
    nonce,
  ])

  const currency = report?.currency ?? 'EUR'

  const dimensionValues: SalesBucket[] = useMemo(() => {
    if (!report || dimension === 'date') return []
    return bucketsFor(report, dimension)
  }, [report, dimension])

  const metricValueFor = (b: SalesBucket): number => {
    if (metric === 'revenue') return b.revenue
    if (metric === 'orders') return b.orders
    if (metric === 'units') return b.units
    return b.orders > 0 ? Math.round(b.revenue / b.orders) : 0
  }

  function saveReport() {
    if (!reportName.trim()) return
    const r: SavedReport = {
      id: crypto.randomUUID(),
      name: reportName.trim(),
      dimension,
      metric,
      viz,
      createdAt: new Date().toISOString(),
    }
    const next = [r, ...saved].slice(0, 50)
    setSaved(next)
    persistSaved(next)
    setReportName('')
  }

  function loadReport(r: SavedReport) {
    setDimension(r.dimension)
    setMetric(r.metric)
    setViz(r.viz)
    setReportName(r.name)
  }

  function deleteReport(id: string) {
    const next = saved.filter((s) => s.id !== id)
    setSaved(next)
    persistSaved(next)
  }

  function downloadCsv() {
    if (!report) return
    const rows: string[] = []
    if (dimension === 'date') {
      rows.push(['date', 'revenue', 'orders', 'units'].join(','))
      for (const p of report.trend) {
        rows.push([p.date, p.revenue, p.ordersCount, p.units].join(','))
      }
    } else {
      rows.push([DIMENSION_LABEL[dimension], METRIC_LABEL[metric]].join(','))
      for (const b of dimensionValues) {
        rows.push([JSON.stringify(b.label), metricValueFor(b)].join(','))
      }
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `insights-builder-${dimension}-${metric}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const sortedEntries = useMemo(() => {
    return [...dimensionValues]
      .map((b) => ({ ...b, value: metricValueFor(b) }))
      .sort((a, b) => b.value - a.value)
  }, [dimensionValues, metric])

  const tableColumns: TableColumn<SalesBucket>[] = [
    {
      key: 'label',
      label: DIMENSION_LABEL[dimension],
      align: 'left',
      accessor: (b) => b.label,
      format: 'text',
    },
    {
      key: 'value',
      label: METRIC_LABEL[metric],
      align: 'right',
      accessor: (b) => metricValueFor(b),
      format:
        metric === 'revenue' || metric === 'aov'
          ? 'currency'
          : 'number',
    },
    {
      key: 'share',
      label: 'Share',
      align: 'right',
      accessor: (b) => b.share * 100,
      format: 'percent',
      width: '80px',
    },
    {
      key: 'delta',
      label: 'Δ vs prev',
      align: 'right',
      accessor: (b) => b.deltaPct,
      format: 'delta',
      width: '90px',
    },
  ]

  const showTrend = dimension === 'date'
  const showPie = viz === 'pie' && !showTrend
  const showBar = viz === 'bar' && !showTrend
  const showTable = viz === 'table' && !showTrend

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="mb-2">
        <Link
          href="/insights"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
        >
          <ChevronLeft className="w-3 h-3" />
          Insights
        </Link>
      </div>
      <InsightsHeader
        title="Report builder"
        description="Pivot any sales metric by any dimension. Switch visualisation and export with one click."
        filterState={filterState}
        refreshing={refreshing}
        onRefresh={() => setNonce((n) => n + 1)}
        onExport={downloadCsv}
        exportLabel="Export CSV"
      />

      {error && (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      <Card title="Configure pivot" className="mb-3">
        <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
          <Picker
            label="Dimension"
            value={dimension}
            options={Object.entries(DIMENSION_LABEL).map(([k, v]) => ({
              value: k as Dimension,
              label: v,
            }))}
            onChange={(v) => {
              setDimension(v)
              if (v === 'date') setViz('trend')
              else if (viz === 'trend') setViz('bar')
            }}
          />
          <Picker
            label="Metric"
            value={metric}
            options={Object.entries(METRIC_LABEL).map(([k, v]) => ({
              value: k as Metric,
              label: v,
            }))}
            onChange={setMetric}
          />
          <Picker
            label="Visualisation"
            value={viz}
            options={Object.entries(VIZ_LABEL).map(([k, v]) => ({
              value: k as Viz,
              label: v,
            }))}
            onChange={setViz}
          />
        </div>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-3">
        <KPICard
          label="Total revenue"
          value={
            report ? formatCurrency(report.totals.revenue, currency) : loading ? '…' : '—'
          }
          accent="emerald"
        />
        <KPICard
          label="Total orders"
          value={report ? formatNum(report.totals.orders) : loading ? '…' : '—'}
          accent="blue"
        />
        <KPICard
          label="Units sold"
          value={report ? formatNum(report.totals.units) : loading ? '…' : '—'}
          accent="violet"
        />
        <KPICard
          label="AOV"
          value={
            report ? formatCurrency(report.totals.aov, currency) : loading ? '…' : '—'
          }
          accent="amber"
        />
      </div>

      <Card
        title={`${METRIC_LABEL[metric]} by ${DIMENSION_LABEL[dimension]}`}
        description={`Visualisation: ${VIZ_LABEL[viz]}`}
        className="mb-3"
      >
        {showTrend && report ? (
          <TrendChart
            data={report.trend.map((p) => ({
              date: p.date,
              revenue: p.revenue,
              orders: p.ordersCount,
              units: p.units,
              aov: p.ordersCount > 0 ? Math.round(p.revenue / p.ordersCount) : 0,
            }))}
            series={[
              {
                key: metric === 'orders' ? 'orders' : metric,
                label: METRIC_LABEL[metric],
                color: trendColor(0),
                format:
                  metric === 'revenue' || metric === 'aov' ? 'currency' : 'number',
              },
            ]}
            currency={currency}
            variant="area"
            height={280}
            showLegend={false}
          />
        ) : showBar ? (
          <BreakdownBar
            entries={sortedEntries.map((b) => ({
              key: b.key,
              label: b.label,
              value: b.value,
              delta: b.deltaPct,
            }))}
            currency={currency}
            format={
              metric === 'revenue' || metric === 'aov' ? 'currency' : 'number'
            }
            total={sortedEntries.reduce((s, b) => s + b.value, 0)}
          />
        ) : showPie ? (
          <BreakdownPie
            entries={sortedEntries.map((b) => ({
              key: b.key,
              label: b.label,
              value: b.value,
            }))}
            variant="donut"
            currency={currency}
            format={metric === 'revenue' || metric === 'aov' ? 'currency' : 'number'}
            height={280}
          />
        ) : showTable ? (
          <TableWithSparkline
            rows={sortedEntries}
            columns={tableColumns}
            currency={currency}
            rowKey={(b) => b.key}
            dense
          />
        ) : (
          <div className="text-sm text-slate-400 py-8 text-center">
            {loading ? 'Loading…' : 'Configure the pivot above to render'}
          </div>
        )}
      </Card>

      <Card title="Save this report" className="mb-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            placeholder="Report name (e.g. 'Daily Amazon IT revenue')"
            value={reportName}
            onChange={(e) => setReportName(e.target.value)}
            className="flex-1 h-8 px-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          />
          <button
            type="button"
            onClick={saveReport}
            disabled={!reportName.trim()}
            className="inline-flex items-center gap-1.5 h-8 px-3 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save className="w-3.5 h-3.5" />
            Save
          </button>
        </div>
      </Card>

      {saved.length > 0 && (
        <Card title="Saved reports" description="Stored in browser localStorage">
          <ul className="space-y-2">
            {saved.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 rounded-md border border-slate-200 dark:border-slate-700 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                    {s.name}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {METRIC_LABEL[s.metric]} by {DIMENSION_LABEL[s.dimension]} ·{' '}
                    {VIZ_LABEL[s.viz]}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => loadReport(s)}
                  className="inline-flex items-center gap-1 h-6 px-2 text-xs rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <Plus className="w-3 h-3" />
                  Load
                </button>
                <button
                  type="button"
                  onClick={() => deleteReport(s.id)}
                  className="inline-flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                  aria-label="Delete report"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function Picker<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (next: T) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">
        {label}
      </label>
      <div
        role="tablist"
        className="inline-flex items-center border border-slate-200 dark:border-slate-700 rounded-md p-0.5 bg-white dark:bg-slate-900"
      >
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={value === opt.value}
            onClick={() => onChange(opt.value)}
            className={cn(
              'h-6 px-2.5 text-xs rounded transition-colors',
              value === opt.value
                ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-semibold'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100',
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}
