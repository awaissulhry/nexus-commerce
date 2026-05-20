'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import {
  BreakdownPie,
  InsightsHeader,
  KPICard,
  TableWithSparkline,
  formatNum,
  formatPct,
  readFilterState,
  type InsightsFilterState,
  type TableColumn,
} from '@/components/insights'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

type Lifecycle =
  | 'NEW'
  | 'GROWING'
  | 'MATURE'
  | 'DECLINING'
  | 'DEAD'
  | 'UNKNOWN'

interface ProductPerfRow {
  sku: string
  productId: string
  productName: string | null
  brand: string | null
  productType: string | null
  parentSku: string | null
  revenue: number
  unitsSold: number
  orders: number
  deltaRevPct: number | null
  lifecycle: Lifecycle
  qualityScore: number | null
  buyBoxWinRate: number | null
  buyBoxObservations: number
  available: number | null
  daysOnHand: number | null
  series: number[]
}

interface LifecycleBucket {
  key: Lifecycle
  label: string
  count: number
  revenue: number
}

interface CoOccurrencePair {
  skuA: string
  skuB: string
  count: number
  revenue: number
}

interface ProductReport {
  window: { from: string; to: string }
  compare: { from: string; to: string } | null
  currency: string
  totals: {
    activeSkus: number
    newSkus: number
    decliningSkus: number
    deadSkus: number
    avgBuyBoxRate: number | null
    avgQuality: number | null
  }
  bestSellers: ProductPerfRow[]
  worstSellers: ProductPerfRow[]
  lifecycle: LifecycleBucket[]
  rows: ProductPerfRow[]
  pairs: CoOccurrencePair[]
}

const LIFECYCLE_COLORS: Record<Lifecycle, string> = {
  NEW: 'rgb(59 130 246)',
  GROWING: 'rgb(16 185 129)',
  MATURE: 'rgb(20 184 166)',
  DECLINING: 'rgb(245 158 11)',
  DEAD: 'rgb(244 63 94)',
  UNKNOWN: 'rgb(100 116 139)',
}

const LIFECYCLE_BADGE: Record<Lifecycle, string> = {
  NEW: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  GROWING: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  MATURE: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  DECLINING: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  DEAD: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  UNKNOWN: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
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

export default function ProductsClient() {
  const params = useSearchParams()
  const filterState = readFilterState(
    new URLSearchParams(params?.toString() ?? ''),
  )
  const [report, setReport] = useState<ProductReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (report) setRefreshing(true)
      try {
        const qs = buildQuery(filterState).toString()
        const res = await fetch(
          `${getBackendUrl()}/api/insights/products?${qs}`,
          { credentials: 'include' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json: ProductReport = await res.json()
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
    window.open(
      `${getBackendUrl()}/api/insights/products?${qs.toString()}`,
      '_blank',
    )
  }

  const rowColumns: TableColumn<ProductPerfRow>[] = [
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
        <span className="block truncate max-w-[220px]" title={r.productName ?? ''}>
          {r.productName ?? '—'}
        </span>
      ),
      format: 'text',
    },
    {
      key: 'lifecycle',
      label: 'Stage',
      align: 'center',
      accessor: (r) => (
        <span
          className={cn(
            'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider',
            LIFECYCLE_BADGE[r.lifecycle],
          )}
        >
          {r.lifecycle === 'UNKNOWN' ? '—' : r.lifecycle}
        </span>
      ),
      format: 'text',
      width: '90px',
    },
    {
      key: 'revenue',
      label: 'Revenue',
      align: 'right',
      accessor: (r) => r.revenue,
      format: 'currency',
    },
    {
      key: 'units',
      label: 'Units',
      align: 'right',
      accessor: (r) => r.unitsSold,
      format: 'number',
    },
    {
      key: 'delta',
      label: 'Δ',
      align: 'right',
      accessor: (r) => r.deltaRevPct,
      format: 'delta',
      width: '60px',
    },
    {
      key: 'quality',
      label: 'Quality',
      align: 'right',
      accessor: (r) =>
        r.qualityScore == null ? '—' : (
          <span className="tabular-nums">{r.qualityScore}/100</span>
        ),
      format: 'text',
      width: '80px',
    },
    {
      key: 'buybox',
      label: 'Buy box',
      align: 'right',
      accessor: (r) =>
        r.buyBoxWinRate == null ? '—' : (
          <span
            className={cn(
              'tabular-nums',
              r.buyBoxWinRate >= 0.8
                ? 'text-emerald-600 dark:text-emerald-400'
                : r.buyBoxWinRate >= 0.5
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-rose-600 dark:text-rose-400',
            )}
          >
            {(r.buyBoxWinRate * 100).toFixed(0)}%
          </span>
        ),
      format: 'text',
      width: '80px',
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
      key: 'doh',
      label: 'DoH',
      align: 'right',
      accessor: (r) =>
        r.daysOnHand == null ? '—' : (
          <span className="tabular-nums">{Math.round(r.daysOnHand)}d</span>
        ),
      format: 'text',
      width: '60px',
    },
    {
      key: 'trend',
      label: 'Trend',
      align: 'right',
      accessor: (r) => r.series,
      format: 'sparkline',
      width: '90px',
    },
  ]

  const pairColumns: TableColumn<CoOccurrencePair>[] = [
    {
      key: 'pair',
      label: 'SKU pair',
      align: 'left',
      accessor: (r) => (
        <span className="font-mono text-[11px]">
          {r.skuA} + {r.skuB}
        </span>
      ),
      format: 'text',
    },
    {
      key: 'count',
      label: 'Orders together',
      align: 'right',
      accessor: (r) => r.count,
      format: 'number',
    },
    {
      key: 'revenue',
      label: 'Combined revenue',
      align: 'right',
      accessor: (r) => r.revenue,
      format: 'currency',
    },
  ]

  const bestSellerColumns = rowColumns.filter((c) => c.key !== 'doh' && c.key !== 'stock')
  const worstSellerColumns = bestSellerColumns

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
        title="Product performance"
        description="Best/worst sellers, lifecycle stages, buy box win rate and cross-sell pairs."
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
          label="Active SKUs"
          value={report ? formatNum(report.totals.activeSkus) : loading ? '…' : '—'}
          accent="emerald"
        />
        <KPICard
          label="New (last 60d)"
          value={report ? formatNum(report.totals.newSkus) : loading ? '…' : '—'}
          accent="blue"
        />
        <KPICard
          label="Declining"
          value={report ? formatNum(report.totals.decliningSkus) : loading ? '…' : '—'}
          accent="amber"
          invertDelta
        />
        <KPICard
          label="Dead"
          value={report ? formatNum(report.totals.deadSkus) : loading ? '…' : '—'}
          accent="rose"
          invertDelta
        />
        <KPICard
          label="Avg buy box rate"
          value={
            report?.totals.avgBuyBoxRate != null
              ? formatPct(report.totals.avgBuyBoxRate * 100)
              : loading
                ? '…'
                : '—'
          }
          accent="violet"
        />
        <KPICard
          label="Avg listing quality"
          value={
            report?.totals.avgQuality != null
              ? `${Math.round(report.totals.avgQuality)}/100`
              : loading
                ? '…'
                : '—'
          }
          accent="slate"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-3">
        <Card title="Lifecycle mix">
          {report && report.lifecycle.length > 0 ? (
            <BreakdownPie
              entries={report.lifecycle
                .filter((l) => l.count > 0)
                .map((l) => ({
                  key: l.key,
                  label: l.label,
                  value: l.count,
                  color: LIFECYCLE_COLORS[l.key],
                }))}
              variant="donut"
              format="number"
              currency={currency}
              height={220}
              centerLabel="SKUs"
              centerValue={formatNum(report.totals.activeSkus)}
            />
          ) : (
            <div className="h-[220px] flex items-center justify-center text-slate-400 text-sm">
              {loading ? 'Loading…' : 'No data'}
            </div>
          )}
        </Card>
        <Card
          title="Best sellers"
          description="Top 10 by revenue"
          className="lg:col-span-2"
        >
          {report ? (
            <TableWithSparkline
              rows={report.bestSellers}
              columns={bestSellerColumns}
              currency={currency}
              rowKey={(r) => r.sku}
              dense
              emptyLabel="No sales in this window"
            />
          ) : (
            <div className="text-sm text-slate-400 py-6 text-center">
              {loading ? 'Loading…' : ''}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Worst sellers"
        description="Lowest-revenue active SKUs (still moving units)"
        className="mb-3"
      >
        {report ? (
          <TableWithSparkline
            rows={report.worstSellers}
            columns={worstSellerColumns}
            currency={currency}
            rowKey={(r) => r.sku}
            dense
            emptyLabel="No data"
          />
        ) : (
          <div className="text-sm text-slate-400 py-6 text-center">
            {loading ? 'Loading…' : ''}
          </div>
        )}
      </Card>

      {report && report.pairs.length > 0 && (
        <Card
          title="Frequently bought together"
          description="SKU pairs co-occurring in the same order"
          className="mb-3"
        >
          <TableWithSparkline
            rows={report.pairs}
            columns={pairColumns}
            currency={currency}
            rowKey={(r) => `${r.skuA}|${r.skuB}`}
            dense
          />
        </Card>
      )}

      <Card
        title="All products"
        description="Top 100 by revenue with quality, buy box, stock"
      >
        {report ? (
          <TableWithSparkline
            rows={report.rows}
            columns={rowColumns}
            currency={currency}
            rowKey={(r) => r.sku}
            dense
            emptyLabel="No data"
          />
        ) : (
          <div className="text-sm text-slate-400 py-6 text-center">
            {loading ? 'Loading…' : ''}
          </div>
        )}
      </Card>
    </div>
  )
}
