'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { AlertOctagon, ChevronLeft, Info } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import {
  BreakdownBar,
  InsightsHeader,
  KPICard,
  TableWithSparkline,
  WaterfallChart,
  formatCurrency,
  formatPct,
  readFilterState,
  type InsightsFilterState,
  type TableColumn,
} from '@/components/insights'
import { getBackendUrl } from '@/lib/backend-url'

interface WaterfallStep {
  key: string
  label: string
  value: number
  kind: 'start' | 'add' | 'sub' | 'total'
}

interface ProfitChannel {
  key: string
  label: string
  revenue: number
  cogs: number
  fees: number
  grossProfit: number
  netProfit: number
  marginPct: number | null
  unitsSold: number
}

interface ProfitSkuRow {
  sku: string
  productName: string | null
  brand: string | null
  revenue: number
  cogs: number
  fees: number
  grossProfit: number
  marginPct: number | null
  unitsSold: number
}

interface ProfitReport {
  window: { from: string; to: string }
  compare: { from: string; to: string } | null
  currency: string
  totals: {
    revenue: number
    cogs: number
    fees: number
    adSpend: number
    refunds: number
    grossProfit: number
    netProfit: number
    marginPct: number | null
  }
  totalsPrev: {
    revenue: number
    cogs: number
    fees: number
    adSpend: number
    refunds: number
    grossProfit: number
    netProfit: number
    marginPct: number | null
  }
  deltas: {
    revenue: number | null
    cogs: number | null
    fees: number | null
    adSpend: number | null
    refunds: number | null
    grossProfit: number | null
    netProfit: number | null
  }
  waterfall: WaterfallStep[]
  byChannel: ProfitChannel[]
  /** I6 — per-(channel, marketplace, currency) P&L in native currency. */
  byMarketplace?: Array<{
    channel: string
    marketplace: string
    currency: string
    revenue: number
    cogs: number
    fees: number
    grossProfit: number
    netProfit: number
    marginPct: number | null
    unitsSold: number
  }>
  bySku: ProfitSkuRow[]
  lossMakers: ProfitSkuRow[]
  feeNotes: { label: string; detail: string }[]
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

export default function ProfitClient() {
  const params = useSearchParams()
  const filterState = readFilterState(
    new URLSearchParams(params?.toString() ?? ''),
  )
  const [report, setReport] = useState<ProfitReport | null>(null)
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
        const res = await fetch(`${getBackendUrl()}/api/insights/profit?${qs}`, {
          credentials: 'include',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json: ProfitReport = await res.json()
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
    window.open(`${getBackendUrl()}/api/insights/profit?${qs.toString()}`, '_blank')
  }

  const skuColumns: TableColumn<ProfitSkuRow>[] = [
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
        <span
          className="block truncate max-w-[260px]"
          title={r.productName ?? ''}
        >
          {r.productName ?? '—'}
        </span>
      ),
      format: 'text',
    },
    {
      key: 'revenue',
      label: 'Revenue',
      align: 'right',
      accessor: (r) => r.revenue,
      format: 'currency',
    },
    {
      key: 'cogs',
      label: 'COGS',
      align: 'right',
      accessor: (r) => r.cogs,
      format: 'currency',
    },
    {
      key: 'fees',
      label: 'Fees',
      align: 'right',
      accessor: (r) => r.fees,
      format: 'currency',
    },
    {
      key: 'grossProfit',
      label: 'Gross profit',
      align: 'right',
      accessor: (r) => r.grossProfit,
      format: 'currency',
    },
    {
      key: 'margin',
      label: 'Margin',
      align: 'right',
      accessor: (r) => r.marginPct,
      format: 'percent',
      width: '80px',
    },
    {
      key: 'units',
      label: 'Units',
      align: 'right',
      accessor: (r) => r.unitsSold,
      format: 'number',
      width: '60px',
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
        title="Profit & cost"
        description="P&L waterfall, margin per channel/SKU, and fee detail. COGS sourced from Product.costPrice; fees estimated per channel."
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

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-5">
        <KPICard
          label="Revenue"
          value={
            report ? formatCurrency(report.totals.revenue, currency) : loading ? '…' : '—'
          }
          deltaPct={report?.deltas.revenue ?? null}
          accent="emerald"
        />
        <KPICard
          label="COGS"
          value={
            report ? formatCurrency(report.totals.cogs, currency) : loading ? '…' : '—'
          }
          deltaPct={report?.deltas.cogs ?? null}
          invertDelta
          accent="amber"
        />
        <KPICard
          label="Channel fees"
          value={
            report ? formatCurrency(report.totals.fees, currency) : loading ? '…' : '—'
          }
          deltaPct={report?.deltas.fees ?? null}
          invertDelta
          accent="slate"
        />
        <KPICard
          label="Ad spend"
          value={
            report ? formatCurrency(report.totals.adSpend, currency) : loading ? '…' : '—'
          }
          deltaPct={report?.deltas.adSpend ?? null}
          invertDelta
          accent="violet"
        />
        <KPICard
          label="Refunds"
          value={
            report ? formatCurrency(report.totals.refunds, currency) : loading ? '…' : '—'
          }
          deltaPct={report?.deltas.refunds ?? null}
          invertDelta
          accent="rose"
        />
        <KPICard
          label="Gross profit"
          value={
            report ? formatCurrency(report.totals.grossProfit, currency) : loading ? '…' : '—'
          }
          deltaPct={report?.deltas.grossProfit ?? null}
          accent="blue"
        />
        <KPICard
          label="Net profit"
          value={
            report ? formatCurrency(report.totals.netProfit, currency) : loading ? '…' : '—'
          }
          deltaPct={report?.deltas.netProfit ?? null}
          accent="emerald"
          secondary={
            report?.totals.marginPct != null
              ? `${formatPct(report.totals.marginPct)} margin`
              : undefined
          }
        />
      </div>

      <Card
        title="P&L waterfall"
        description="Revenue → COGS → fees → ad spend → refunds → net profit"
        className="mb-3"
        noPadding
      >
        <div className="p-4">
          {report ? (
            <WaterfallChart
              steps={report.waterfall}
              currency={currency}
              height={300}
            />
          ) : (
            <div className="h-[300px] flex items-center justify-center text-slate-400 text-sm">
              {loading ? 'Loading…' : 'No data'}
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
        <Card title="Margin by channel" description="Net contribution per channel">
          {report && report.byChannel.length > 0 ? (
            <BreakdownBar
              entries={report.byChannel.map((c) => ({
                key: c.key,
                label: c.label,
                value: c.netProfit,
                delta: c.marginPct,
              }))}
              currency={currency}
              format="currency"
              total={Math.max(
                ...report.byChannel.map((c) => Math.abs(c.netProfit)),
                1,
              )}
              showShare={false}
              showDelta
            />
          ) : (
            <div className="text-sm text-slate-400 py-6 text-center">
              {loading ? 'Loading…' : 'No data'}
            </div>
          )}
        </Card>
        <Card
          title="Fee notes"
          description="How fees are estimated"
          action={<Info className="w-3.5 h-3.5 text-slate-400" />}
        >
          {report ? (
            <ul className="space-y-2">
              {report.feeNotes.map((n) => (
                <li
                  key={n.label}
                  className="rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs"
                >
                  <span className="font-semibold text-slate-700 dark:text-slate-200">
                    {n.label}:
                  </span>{' '}
                  <span className="text-slate-500 dark:text-slate-400">
                    {n.detail}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-sm text-slate-400 py-6 text-center">
              {loading ? 'Loading…' : ''}
            </div>
          )}
        </Card>
      </div>

      {report && report.byMarketplace && report.byMarketplace.length > 0 && (
        <Card
          title="P&L per marketplace"
          description="One row per (channel × marketplace × currency) — native currency, no implicit conversion"
          className="mb-3"
          noPadding
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="text-left font-medium px-3 py-2">Channel</th>
                  <th className="text-left font-medium px-3 py-2">Market</th>
                  <th className="text-right font-medium px-3 py-2">Revenue</th>
                  <th className="text-right font-medium px-3 py-2">COGS</th>
                  <th className="text-right font-medium px-3 py-2">Fees</th>
                  <th className="text-right font-medium px-3 py-2">Gross</th>
                  <th className="text-right font-medium px-3 py-2">Net</th>
                  <th className="text-right font-medium px-3 py-2">Margin</th>
                  <th className="text-right font-medium px-3 py-2">Units</th>
                </tr>
              </thead>
              <tbody>
                {report.byMarketplace.map((row) => {
                  const positive = row.netProfit >= 0
                  return (
                    <tr
                      key={`${row.channel}|${row.marketplace}|${row.currency}`}
                      className="border-b border-slate-100 dark:border-slate-800/60 last:border-0 hover:bg-slate-50/60 dark:hover:bg-slate-800/30"
                    >
                      <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">
                        {row.channel}
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-slate-700 dark:text-slate-300">
                          {row.marketplace}
                        </span>
                        <span className="ml-1.5 text-[11px] text-slate-400 dark:text-slate-500 font-mono">
                          {row.currency}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                        {formatCurrency(row.revenue, row.currency)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">
                        {row.cogs > 0
                          ? `−${formatCurrency(row.cogs, row.currency)}`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">
                        {row.fees > 0
                          ? `−${formatCurrency(row.fees, row.currency)}`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                        {formatCurrency(row.grossProfit, row.currency)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums font-semibold ${
                          positive
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {formatCurrency(row.netProfit, row.currency)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums ${
                          row.marginPct == null
                            ? 'text-slate-400'
                            : row.marginPct >= 0
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {row.marginPct == null
                          ? '—'
                          : `${row.marginPct.toFixed(1)}%`}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                        {row.unitsSold.toLocaleString('it-IT')}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {report && report.lossMakers.length > 0 && (
        <Card
          title={
            <span className="inline-flex items-center gap-1.5">
              <AlertOctagon className="w-4 h-4 text-rose-500" />
              Loss-makers
            </span>
          }
          description={`${report.lossMakers.length} SKU${report.lossMakers.length === 1 ? '' : 's'} selling at negative margin`}
          className="mb-3"
        >
          <TableWithSparkline
            rows={report.lossMakers}
            columns={skuColumns}
            currency={currency}
            rowKey={(r) => r.sku}
            dense
          />
        </Card>
      )}

      <Card
        title="Margin by SKU"
        description="Sorted by gross profit (revenue − COGS − fees), top 100"
      >
        {report ? (
          <TableWithSparkline
            rows={report.bySku}
            columns={skuColumns}
            currency={currency}
            rowKey={(r) => r.sku}
            dense
            emptyLabel="No sales in this window"
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
