'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import {
  BreakdownBar,
  BreakdownPie,
  HeatmapGrid,
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
import { getBackendUrl } from '@/lib/backend-url'

interface SalesBucket {
  key: string
  label: string
  revenue: number
  orders: number
  units: number
  share: number
  deltaPct: number | null
}

interface SalesTrendPoint {
  date: string
  revenue: number
  ordersCount: number
  units: number
  revenuePrev?: number
}

interface ParetoPoint {
  rank: number
  sku: string
  cumulativeRevenue: number
  cumulativeShare: number
}

interface SalesReport {
  window: { from: string; to: string }
  compare: { from: string; to: string } | null
  currency: string
  totals: {
    revenue: number
    orders: number
    units: number
    aov: number
    refundsValue: number
    returnsCount: number
    discountValue: number
  }
  totalsPrev: {
    revenue: number
    orders: number
    units: number
    aov: number
    refundsValue: number
    returnsCount: number
  }
  trend: SalesTrendPoint[]
  byChannel: SalesBucket[]
  byMarket: SalesBucket[]
  byBrand: SalesBucket[]
  byProductType: SalesBucket[]
  byFulfillment: SalesBucket[]
  matrix: Array<{ channel: string; market: string; revenue: number; orders: number }>
  pareto: ParetoPoint[]
  paretoSummary: { topNCount: number; topNShare: number; skuCount: number }
}

function delta(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null
  return ((current - previous) / previous) * 100
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

export default function SalesClient() {
  const params = useSearchParams()
  const filterState: InsightsFilterState = readFilterState(
    new URLSearchParams(params?.toString() ?? ''),
  )
  const [report, setReport] = useState<SalesReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const had = report !== null
      if (had) setRefreshing(true)
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

  function downloadCsv() {
    const qs = buildQuery(filterState)
    qs.set('format', 'csv')
    window.open(`${getBackendUrl()}/api/insights/sales?${qs.toString()}`, '_blank')
  }

  const paretoChart = report
    ? report.pareto.slice(0, 50).map((p) => ({
        date: String(p.rank),
        sku: p.sku,
        share: Math.round(p.cumulativeShare * 1000) / 10,
      }))
    : []

  const skuColumns: TableColumn<ParetoPoint>[] = [
    {
      key: 'rank',
      label: '#',
      align: 'right',
      accessor: (r) => r.rank,
      format: 'number',
      width: '40px',
    },
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
    },
    {
      key: 'cumRev',
      label: 'Cumulative revenue',
      align: 'right',
      accessor: (r) => r.cumulativeRevenue,
      format: 'currency',
    },
    {
      key: 'cumShare',
      label: 'Cumulative share',
      align: 'right',
      accessor: (r) => r.cumulativeShare * 100,
      format: 'percent',
    },
  ]

  const channelMarketCols = report
    ? [...report.byMarket]
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 12)
        .map((m) => ({ key: m.key, label: m.label }))
    : []
  const channelRows = report
    ? report.byChannel.map((c) => ({ key: c.key, label: c.label }))
    : []
  const matrixCells = report
    ? report.matrix.map((m) => ({
        row: m.channel,
        col: m.market,
        value: m.revenue,
      }))
    : []

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="mb-2">
        <Link
          href="/insights"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
        >
          <ChevronLeft className="w-3 h-3" />
          Insights
        </Link>
      </div>
      <InsightsHeader
        title="Sales reports"
        description="Revenue, orders, AOV and channel/market splits with Pareto concentration."
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
          label="Revenue"
          value={
            report
              ? formatCurrency(report.totals.revenue, currency)
              : loading
                ? '…'
                : '—'
          }
          deltaPct={
            report ? delta(report.totals.revenue, report.totalsPrev.revenue) : null
          }
          accent="emerald"
        />
        <KPICard
          label="Orders"
          value={report ? formatNum(report.totals.orders) : loading ? '…' : '—'}
          deltaPct={
            report ? delta(report.totals.orders, report.totalsPrev.orders) : null
          }
          accent="blue"
        />
        <KPICard
          label="Units sold"
          value={report ? formatNum(report.totals.units) : loading ? '…' : '—'}
          deltaPct={
            report ? delta(report.totals.units, report.totalsPrev.units) : null
          }
          accent="violet"
        />
        <KPICard
          label="AOV"
          value={
            report ? formatCurrency(report.totals.aov, currency) : loading ? '…' : '—'
          }
          deltaPct={report ? delta(report.totals.aov, report.totalsPrev.aov) : null}
          accent="amber"
        />
        <KPICard
          label="Refunds"
          value={
            report
              ? formatCurrency(report.totals.refundsValue, currency)
              : loading
                ? '…'
                : '—'
          }
          deltaPct={
            report
              ? delta(report.totals.refundsValue, report.totalsPrev.refundsValue)
              : null
          }
          invertDelta
          accent="rose"
        />
        <KPICard
          label="Returns"
          value={report ? formatNum(report.totals.returnsCount) : loading ? '…' : '—'}
          deltaPct={
            report
              ? delta(report.totals.returnsCount, report.totalsPrev.returnsCount)
              : null
          }
          invertDelta
          accent="rose"
        />
      </div>

      <Card
        title="Revenue trend"
        description="Current window overlaid with comparison window"
        className="mb-3"
        noPadding
      >
        <div className="p-4">
          {report && report.trend.length > 0 ? (
            <TrendChart
              data={report.trend.map((p) => ({
                date: p.date,
                revenue: p.revenue,
                revenuePrev: p.revenuePrev ?? 0,
                orders: p.ordersCount,
              }))}
              series={[
                {
                  key: 'revenue',
                  label: 'Revenue',
                  color: trendColor(0),
                  format: 'currency',
                },
                {
                  key: 'revenuePrev',
                  label: 'Revenue (prev)',
                  color: trendColor(5),
                  dashed: true,
                  format: 'currency',
                },
                {
                  key: 'orders',
                  label: 'Orders',
                  color: trendColor(1),
                  format: 'number',
                  yAxisId: 'right',
                },
              ]}
              variant="area"
              currency={currency}
              height={300}
              rightAxisFormat="number"
            />
          ) : (
            <div className="h-[260px] flex items-center justify-center text-slate-400 text-sm">
              {loading ? 'Loading…' : 'No data for this window'}
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-3">
        <Card title="By channel">
          {report && report.byChannel.length > 0 ? (
            <BreakdownPie
              entries={report.byChannel.map((b) => ({
                key: b.key,
                label: b.label,
                value: b.revenue,
              }))}
              variant="donut"
              currency={currency}
              height={200}
              centerLabel="Channels"
              centerValue={String(report.byChannel.length)}
            />
          ) : (
            <div className="h-[200px] flex items-center justify-center text-slate-400 text-sm">
              {loading ? 'Loading…' : 'No data'}
            </div>
          )}
        </Card>
        <Card title="By market" description="Top markets">
          {report && report.byMarket.length > 0 ? (
            <BreakdownBar
              entries={report.byMarket.slice(0, 10).map((b) => ({
                key: b.key,
                label: b.label,
                value: b.revenue,
                delta: b.deltaPct,
              }))}
              currency={currency}
              total={report.totals.revenue}
              maxRows={10}
            />
          ) : (
            <div className="h-[200px] flex items-center justify-center text-slate-400 text-sm">
              {loading ? 'Loading…' : 'No data'}
            </div>
          )}
        </Card>
        <Card title="By fulfillment">
          {report && report.byFulfillment.length > 0 ? (
            <BreakdownBar
              entries={report.byFulfillment.map((b) => ({
                key: b.key,
                label: b.label,
                value: b.revenue,
                delta: b.deltaPct,
              }))}
              currency={currency}
              total={report.totals.revenue}
            />
          ) : (
            <div className="h-[200px] flex items-center justify-center text-slate-400 text-sm">
              {loading ? 'Loading…' : 'No data'}
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
        <Card title="By brand">
          {report && report.byBrand.length > 0 ? (
            <BreakdownBar
              entries={report.byBrand.slice(0, 10).map((b) => ({
                key: b.key,
                label: b.label,
                value: b.revenue,
                delta: b.deltaPct,
              }))}
              currency={currency}
              total={report.totals.revenue}
            />
          ) : (
            <div className="text-sm text-slate-400 py-6 text-center">
              {loading ? 'Loading…' : 'No brand data'}
            </div>
          )}
        </Card>
        <Card title="By product type">
          {report && report.byProductType.length > 0 ? (
            <BreakdownBar
              entries={report.byProductType.slice(0, 10).map((b) => ({
                key: b.key,
                label: b.label,
                value: b.revenue,
                delta: b.deltaPct,
              }))}
              currency={currency}
              total={report.totals.revenue}
            />
          ) : (
            <div className="text-sm text-slate-400 py-6 text-center">
              {loading ? 'Loading…' : 'No product type data'}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Channel × market heatmap"
        description="Revenue intensity across channel × market"
        className="mb-3"
        noPadding
      >
        <div className="p-4">
          {report && matrixCells.length > 0 ? (
            <HeatmapGrid
              cells={matrixCells}
              rows={channelRows}
              cols={channelMarketCols}
              currency={currency}
              ariaLabel="Channel by market revenue heatmap"
            />
          ) : (
            <div className="h-[140px] flex items-center justify-center text-slate-400 text-sm">
              {loading ? 'Loading…' : 'No data'}
            </div>
          )}
        </div>
      </Card>

      <Card
        title="Pareto: SKU revenue concentration"
        description={
          report
            ? `Top ${report.paretoSummary.topNCount} of ${report.paretoSummary.skuCount} SKUs deliver ${formatPct(report.paretoSummary.topNShare * 100)} of revenue`
            : 'Calculating…'
        }
        className="mb-3"
        noPadding
      >
        <div className="p-4">
          {paretoChart.length > 0 ? (
            <TrendChart
              data={paretoChart.map((p) => ({ date: p.date, share: p.share }))}
              series={[
                {
                  key: 'share',
                  label: 'Cumulative %',
                  color: trendColor(0),
                  format: 'number',
                },
              ]}
              variant="line"
              height={220}
              showLegend={false}
            />
          ) : (
            <div className="h-[220px] flex items-center justify-center text-slate-400 text-sm">
              {loading ? 'Loading…' : 'No data'}
            </div>
          )}
        </div>
      </Card>

      <Card
        title="Pareto SKUs"
        description="SKUs sorted by descending revenue contribution"
      >
        {report ? (
          <TableWithSparkline
            rows={report.pareto.slice(0, 50)}
            columns={skuColumns}
            currency={currency}
            rowKey={(r) => r.sku}
            dense
            emptyLabel="No SKU revenue in this window"
          />
        ) : (
          <div className="text-sm text-slate-400 py-6 text-center">
            {loading ? 'Loading…' : 'No data'}
          </div>
        )}
      </Card>
    </div>
  )
}
