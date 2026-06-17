'use client'

import { useCallback, useEffect, useState } from 'react'
import { useInsightsLiveRefresh } from '../../_components/useInsightsLiveRefresh'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ChevronLeft, Sparkles, Target, ZapOff } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import {
  InsightsHeader,
  KPICard,
  TableWithSparkline,
  TrendChart,
  formatCurrency,
  formatNum,
  formatPct,
  readFilterState,
  trendColor,
  type InsightsFilterState,
  type TableColumn,
} from '@/components/insights'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

interface ForecastTrendPoint {
  date: string
  forecast: number
  lower80: number
  upper80: number
}

interface ForecastSkuRow {
  sku: string
  productName: string | null
  brand: string | null
  forecast30: number
  forecast60: number
  forecast90: number
  lower30: number
  upper30: number
  projectedRevenue30: number
  available: number
  daysToStockout: number | null
  needsReorder: boolean
  signalsActive: string[]
  modelRegime: string | null
}

interface AccuracyBucket {
  modelRegime: string
  rowCount: number
  mape: number | null
  meanAbsError: number
  withinBandPct: number
}

interface ForecastReport {
  generatedAt: string
  horizonStart: string
  horizonEnd: string
  totals: {
    forecast30: number
    forecast60: number
    forecast90: number
    projectedRevenue30: number
    stockoutRiskCount: number
    skuCount: number
  }
  trend: ForecastTrendPoint[]
  topSkus: ForecastSkuRow[]
  stockoutWatch: ForecastSkuRow[]
  accuracyOverall: AccuracyBucket
  accuracyByModel: AccuracyBucket[]
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

export default function ForecastClient() {
  const params = useSearchParams()
  const filterState = readFilterState(
    new URLSearchParams(params?.toString() ?? ''),
  )
  const [report, setReport] = useState<ForecastReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  // AL.1 — live refresh on order events (debounced 2s)
  const bumpNonce = useCallback(() => setNonce((n) => n + 1), [])
  useInsightsLiveRefresh(bumpNonce)

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (report) setRefreshing(true)
      try {
        const qs = buildQuery(filterState).toString()
        const res = await fetch(
          `${getBackendUrl()}/api/insights/forecast?${qs}`,
          { credentials: 'include' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json: ForecastReport = await res.json()
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

  function downloadCsv() {
    const qs = buildQuery(filterState)
    qs.set('format', 'csv')
    window.open(
      `${getBackendUrl()}/api/insights/forecast?${qs.toString()}`,
      '_blank',
    )
  }

  const rowColumns: TableColumn<ForecastSkuRow>[] = [
    {
      key: 'sku',
      label: 'SKU',
      align: 'left',
      accessor: (r) => (
        <Link
          href={`/products/${encodeURIComponent(r.sku)}`}
          className="font-mono text-[11px] hover:text-blue-600"
        >
          {r.sku}
        </Link>
      ),
      format: 'text',
      width: '120px',
    },
    {
      key: 'name',
      label: 'Name',
      align: 'left',
      accessor: (r) => (
        <span className="block truncate max-w-[200px]" title={r.productName ?? ''}>
          {r.productName ?? '—'}
        </span>
      ),
      format: 'text',
    },
    {
      key: 'f30',
      label: '30d (units)',
      align: 'right',
      accessor: (r) => (
        <span className="tabular-nums">
          <span className="font-semibold">{formatNum(r.forecast30)}</span>
          <span className="text-[10px] text-slate-500 ml-1">
            ({r.lower30}–{r.upper30})
          </span>
        </span>
      ),
      format: 'text',
      width: '140px',
    },
    {
      key: 'f60',
      label: '60d',
      align: 'right',
      accessor: (r) => r.forecast60,
      format: 'number',
      width: '70px',
    },
    {
      key: 'f90',
      label: '90d',
      align: 'right',
      accessor: (r) => r.forecast90,
      format: 'number',
      width: '70px',
    },
    {
      key: 'revenue',
      label: 'Proj. revenue 30d',
      align: 'right',
      accessor: (r) => r.projectedRevenue30,
      format: 'currency',
    },
    {
      key: 'stock',
      label: 'Stock',
      align: 'right',
      accessor: (r) => r.available,
      format: 'number',
      width: '70px',
    },
    {
      key: 'dts',
      label: 'Days to OOS',
      align: 'right',
      accessor: (r) =>
        r.daysToStockout == null ? '—' : (
          <span
            className={cn(
              'tabular-nums',
              r.daysToStockout < 7
                ? 'text-rose-600 dark:text-rose-400 font-bold'
                : r.daysToStockout < 21
                  ? 'text-amber-600 dark:text-amber-400 font-semibold'
                  : '',
            )}
          >
            {Math.round(r.daysToStockout)}d
          </span>
        ),
      format: 'text',
      width: '90px',
    },
    {
      key: 'signals',
      label: 'Signals',
      align: 'left',
      accessor: (r) =>
        r.signalsActive.length === 0 ? (
          <span className="text-slate-300">—</span>
        ) : (
          <div className="flex items-center gap-0.5 flex-wrap">
            {r.signalsActive.map((s) => (
              <span
                key={s}
                className="inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300"
                title={`${s} signal applied`}
              >
                {s}
              </span>
            ))}
          </div>
        ),
      format: 'text',
      width: '110px',
    },
  ]

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
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
        title="Forecast & projections"
        description="90-day demand forecast per SKU with prediction intervals + projected stockouts + accuracy vs recent actuals."
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

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
        <KPICard
          label="Forecast 30d (units)"
          value={report ? formatNum(report.totals.forecast30) : loading ? '…' : '—'}
          accent="emerald"
        />
        <KPICard
          label="Forecast 60d"
          value={report ? formatNum(report.totals.forecast60) : loading ? '…' : '—'}
          accent="blue"
        />
        <KPICard
          label="Forecast 90d"
          value={report ? formatNum(report.totals.forecast90) : loading ? '…' : '—'}
          accent="violet"
        />
        <KPICard
          label="Projected revenue 30d"
          value={
            report
              ? formatCurrency(report.totals.projectedRevenue30, 'EUR')
              : loading
                ? '…'
                : '—'
          }
          accent="emerald"
        />
        <KPICard
          label="Stockout risk SKUs"
          value={
            report ? formatNum(report.totals.stockoutRiskCount) : loading ? '…' : '—'
          }
          accent="rose"
          invertDelta
          secondary="< 21 days inventory"
        />
        <KPICard
          label="Forecast MAPE"
          value={
            report?.accuracyOverall.mape != null
              ? formatPct(report.accuracyOverall.mape)
              : loading
                ? '…'
                : '—'
          }
          accent="amber"
          invertDelta
          secondary={
            report?.accuracyOverall.withinBandPct != null
              ? `${formatPct(report.accuracyOverall.withinBandPct)} within band`
              : undefined
          }
        />
      </div>

      <Card
        title="90-day demand forecast"
        description="Daily units forecast across all SKUs in scope, with 80% prediction interval"
        className="mb-3"
        noPadding
      >
        <div className="p-4">
          {report && report.trend.length > 0 ? (
            <TrendChart
              data={report.trend.map((p) => ({
                date: p.date,
                forecast: p.forecast,
                lower80: p.lower80,
                upper80: p.upper80,
              }))}
              series={[
                {
                  key: 'upper80',
                  label: 'Upper 80%',
                  color: trendColor(2),
                  dashed: true,
                  format: 'number',
                },
                {
                  key: 'forecast',
                  label: 'Forecast',
                  color: trendColor(0),
                  format: 'number',
                },
                {
                  key: 'lower80',
                  label: 'Lower 80%',
                  color: trendColor(2),
                  dashed: true,
                  format: 'number',
                },
              ]}
              variant="area"
              height={280}
              showLegend
            />
          ) : (
            <div className="h-[280px] flex items-center justify-center text-tertiary text-sm">
              {loading
                ? 'Loading…'
                : 'No forecast data yet — the replenishment worker needs to run at least once.'}
            </div>
          )}
        </div>
      </Card>

      {report && report.stockoutWatch.length > 0 && (
        <Card
          title={
            <span className="inline-flex items-center gap-1.5">
              <ZapOff className="w-4 h-4 text-rose-500" />
              Stockout watch
            </span>
          }
          description="SKUs projected to run out within 21 days at forecast pace"
          className="mb-3"
        >
          <TableWithSparkline
            rows={report.stockoutWatch}
            columns={rowColumns}
            currency="EUR"
            rowKey={(r) => r.sku}
            dense
          />
        </Card>
      )}

      <Card
        title="Top SKUs by forecast volume"
        description="Sorted by 30-day forecast units"
        className="mb-3"
      >
        {report ? (
          <TableWithSparkline
            rows={report.topSkus}
            columns={rowColumns}
            currency="EUR"
            rowKey={(r) => r.sku}
            dense
            emptyLabel="No forecast rows"
          />
        ) : (
          <div className="text-sm text-tertiary py-6 text-center">
            {loading ? 'Loading…' : ''}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card
          title={
            <span className="inline-flex items-center gap-1.5">
              <Target className="w-4 h-4 text-blue-500" />
              Accuracy — last 30 days
            </span>
          }
          description="How close the forecast was to actuals"
        >
          {report ? (
            <dl className="space-y-1.5 text-sm">
              <Row
                label="Rows evaluated"
                value={formatNum(report.accuracyOverall.rowCount)}
              />
              <Row
                label="MAPE"
                value={
                  report.accuracyOverall.mape != null
                    ? formatPct(report.accuracyOverall.mape)
                    : '—'
                }
                bold
              />
              <Row
                label="Mean absolute error"
                value={`${formatNum(report.accuracyOverall.meanAbsError)} units`}
              />
              <Row
                label="Within prediction band"
                value={formatPct(report.accuracyOverall.withinBandPct)}
              />
            </dl>
          ) : (
            <div className="text-sm text-tertiary py-6 text-center">
              {loading ? 'Loading…' : ''}
            </div>
          )}
        </Card>

        <Card
          title={
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-violet-500" />
              Accuracy by model regime
            </span>
          }
          description="Compare cold-start vs trailing-mean vs Holt-Winters"
        >
          {report && report.accuracyByModel.length > 0 ? (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-default dark:border-slate-800">
                  <th className="text-left text-[11px] uppercase tracking-wider font-medium text-slate-500 px-2 py-1.5">
                    Regime
                  </th>
                  <th className="text-right text-[11px] uppercase tracking-wider font-medium text-slate-500 px-2 py-1.5">
                    Rows
                  </th>
                  <th className="text-right text-[11px] uppercase tracking-wider font-medium text-slate-500 px-2 py-1.5">
                    MAPE
                  </th>
                  <th className="text-right text-[11px] uppercase tracking-wider font-medium text-slate-500 px-2 py-1.5">
                    Within band
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.accuracyByModel.map((row) => (
                  <tr
                    key={row.modelRegime}
                    className="border-b border-subtle dark:border-slate-800/60 last:border-b-0"
                  >
                    <td className="px-2 py-1.5 font-mono text-[11px]">
                      {row.modelRegime}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {formatNum(row.rowCount)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {row.mape != null ? formatPct(row.mape) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {formatPct(row.withinBandPct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-sm text-tertiary py-6 text-center">
              {loading ? 'Loading…' : 'No accuracy data — needs forecast-accuracy job to have run'}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

function Row({
  label,
  value,
  bold,
}: {
  label: string
  value: string
  bold?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-subtle dark:border-slate-800/60 last:border-b-0 py-1">
      <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
      <dd
        className={cn(
          'tabular-nums',
          bold
            ? 'font-semibold text-slate-900 dark:text-slate-100'
            : 'text-slate-700 dark:text-slate-200',
        )}
      >
        {value}
      </dd>
    </div>
  )
}
