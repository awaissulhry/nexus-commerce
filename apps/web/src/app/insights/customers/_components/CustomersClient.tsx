'use client'

import { useCallback, useEffect, useState } from 'react'
import { useInsightsLiveRefresh } from '../../_components/useInsightsLiveRefresh'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import {
  BreakdownBar,
  BreakdownPie,
  InsightsHeader,
  KPICard,
  TableWithSparkline,
  formatCurrency,
  formatNum,
  formatPct,
  readFilterState,
  type InsightsFilterState,
  type TableColumn,
} from '@/components/insights'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

interface RfmSegment {
  key: string
  label: string
  count: number
  totalSpend: number
}

interface LtvBand {
  bandKey: string
  label: string
  minCents: number
  count: number
  totalSpendCents: number
}

interface CohortGridRow {
  cohort: string
  cohortSize: number
  cells: Array<{ monthOffset: number; retainedCount: number; retainedPct: number }>
}

interface GeoBucket {
  marketplace: string
  customers: number
  revenue: number
}

interface TopCustomer {
  id: string
  email: string
  name: string | null
  totalOrders: number
  totalSpent: number
  rfmLabel: string | null
  firstOrderAt: string | null
  lastOrderAt: string | null
}

interface CustomerReport {
  window: { from: string; to: string }
  totals: {
    activeCustomers: number
    newCustomers: number
    returningCustomers: number
    repeatRatePct: number | null
    avgOrdersPerCustomer: number | null
    avgLifetimeValue: number
    revenueNew: number
    revenueReturning: number
    concentrationTop10Pct: number | null
  }
  rfm: RfmSegment[]
  ltvBands: LtvBand[]
  cohort: CohortGridRow[]
  byGeography: GeoBucket[]
  topCustomers: TopCustomer[]
}

const RFM_COLORS: Record<string, string> = {
  CHAMPION: 'rgb(16 185 129)',
  LOYAL: 'rgb(20 184 166)',
  POTENTIAL: 'rgb(59 130 246)',
  NEW: 'rgb(139 92 246)',
  AT_RISK: 'rgb(245 158 11)',
  LOST: 'rgb(244 63 94)',
  ONE_TIME: 'rgb(100 116 139)',
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

function cohortToneFor(pct: number): string {
  if (pct === 0) return 'bg-slate-50 dark:bg-slate-900 text-tertiary'
  if (pct < 0.05) return 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200'
  if (pct < 0.15) return 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-900 dark:text-emerald-100'
  if (pct < 0.3) return 'bg-emerald-300 dark:bg-emerald-800/70 text-emerald-950 dark:text-emerald-50'
  if (pct < 0.5) return 'bg-emerald-500 text-white'
  return 'bg-emerald-700 text-white'
}

export default function CustomersClient() {
  const params = useSearchParams()
  const filterState = readFilterState(
    new URLSearchParams(params?.toString() ?? ''),
  )
  const [report, setReport] = useState<CustomerReport | null>(null)
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
          `${getBackendUrl()}/api/insights/customers?${qs}`,
          { credentials: 'include' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json: CustomerReport = await res.json()
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
      `${getBackendUrl()}/api/insights/customers?${qs.toString()}`,
      '_blank',
    )
  }

  const topColumns: TableColumn<TopCustomer>[] = [
    {
      key: 'email',
      label: 'Customer',
      align: 'left',
      accessor: (r) => (
        <div className="min-w-0">
          <div className="font-medium text-slate-900 dark:text-slate-100 truncate" title={r.name ?? r.email}>
            {r.name ?? r.email}
          </div>
          <div className="text-[10px] text-slate-500 truncate" title={r.email}>
            {r.email}
          </div>
        </div>
      ),
      format: 'text',
    },
    {
      key: 'orders',
      label: 'Orders',
      align: 'right',
      accessor: (r) => r.totalOrders,
      format: 'number',
      width: '70px',
    },
    {
      key: 'spent',
      label: 'Lifetime spend',
      align: 'right',
      accessor: (r) => r.totalSpent,
      format: 'currency',
    },
    {
      key: 'rfm',
      label: 'Segment',
      align: 'center',
      accessor: (r) =>
        r.rfmLabel ? (
          <span
            className={cn(
              'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider',
              r.rfmLabel === 'CHAMPION'
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                : r.rfmLabel === 'AT_RISK'
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                  : r.rfmLabel === 'LOST'
                    ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
                    : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
            )}
          >
            {r.rfmLabel}
          </span>
        ) : (
          <span className="text-tertiary">—</span>
        ),
      format: 'text',
      width: '110px',
    },
    {
      key: 'lastOrder',
      label: 'Last order',
      align: 'left',
      accessor: (r) =>
        r.lastOrderAt ? (
          <span className="text-[11px] tabular-nums text-slate-600">
            {new Date(r.lastOrderAt).toLocaleDateString('it-IT')}
          </span>
        ) : (
          <span className="text-tertiary">—</span>
        ),
      format: 'text',
      width: '90px',
    },
  ]

  const newReturningPct = report
    ? report.totals.revenueNew + report.totals.revenueReturning > 0
      ? (report.totals.revenueReturning /
          (report.totals.revenueNew + report.totals.revenueReturning)) *
        100
      : 0
    : 0

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
        title="Customer insights"
        description="RFM segments, lifetime value, cohort retention and geography mix."
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
          label="Active customers"
          value={report ? formatNum(report.totals.activeCustomers) : loading ? '…' : '—'}
          accent="emerald"
        />
        <KPICard
          label="New"
          value={report ? formatNum(report.totals.newCustomers) : loading ? '…' : '—'}
          accent="blue"
        />
        <KPICard
          label="Returning"
          value={report ? formatNum(report.totals.returningCustomers) : loading ? '…' : '—'}
          accent="violet"
        />
        <KPICard
          label="Repeat rate"
          value={
            report?.totals.repeatRatePct != null
              ? formatPct(report.totals.repeatRatePct)
              : loading
                ? '…'
                : '—'
          }
          accent="emerald"
        />
        <KPICard
          label="Avg LTV"
          value={report ? formatCurrency(report.totals.avgLifetimeValue, 'EUR') : loading ? '…' : '—'}
          accent="amber"
        />
        <KPICard
          label="Top-10% concentration"
          value={
            report?.totals.concentrationTop10Pct != null
              ? formatPct(report.totals.concentrationTop10Pct * 100)
              : loading
                ? '…'
                : '—'
          }
          accent="rose"
          secondary={
            report?.totals.concentrationTop10Pct != null
              ? `of lifetime spend from top 10%`
              : undefined
          }
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-3">
        <Card title="RFM segments" description="Population by quintile-derived label">
          {report && report.rfm.length > 0 ? (
            <BreakdownPie
              entries={report.rfm.map((r) => ({
                key: r.key,
                label: r.label,
                value: r.count,
                color: RFM_COLORS[r.key],
              }))}
              variant="donut"
              format="number"
              height={220}
              centerLabel="Customers"
              centerValue={formatNum(report.rfm.reduce((s, r) => s + r.count, 0))}
            />
          ) : (
            <div className="h-[220px] flex items-center justify-center text-tertiary text-sm">
              {loading ? 'Loading…' : 'No RFM data'}
            </div>
          )}
        </Card>
        <Card title="LTV distribution" description="Customers by lifetime spend band">
          {report && report.ltvBands.length > 0 ? (
            <BreakdownBar
              entries={report.ltvBands.map((b) => ({
                key: b.bandKey,
                label: b.label,
                value: b.count,
              }))}
              format="number"
              total={report.ltvBands.reduce((s, b) => s + b.count, 0)}
            />
          ) : (
            <div className="h-[220px] flex items-center justify-center text-tertiary text-sm">
              {loading ? 'Loading…' : 'No LTV data'}
            </div>
          )}
        </Card>
        <Card title="New vs returning" description="Revenue mix this window">
          {report ? (
            <div className="space-y-3">
              <div className="rounded-md border border-default dark:border-slate-700 p-2.5">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-medium text-slate-700">Returning</span>
                  <span className="tabular-nums font-semibold">
                    {formatCurrency(report.totals.revenueReturning, 'EUR')}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full"
                    style={{ width: `${newReturningPct}%` }}
                  />
                </div>
                <div className="text-[10px] text-slate-500 mt-1">
                  {newReturningPct.toFixed(1)}% of window revenue
                </div>
              </div>
              <div className="rounded-md border border-default dark:border-slate-700 p-2.5">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-medium text-slate-700">New</span>
                  <span className="tabular-nums font-semibold">
                    {formatCurrency(report.totals.revenueNew, 'EUR')}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full"
                    style={{ width: `${100 - newReturningPct}%` }}
                  />
                </div>
                <div className="text-[10px] text-slate-500 mt-1">
                  {(100 - newReturningPct).toFixed(1)}% of window revenue
                </div>
              </div>
            </div>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-tertiary text-sm">
              {loading ? 'Loading…' : ''}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Cohort retention"
        description="Customers' first-order month vs subsequent months. Each cell is the % of the cohort that ordered again that many months later."
        className="mb-3"
        noPadding
      >
        <div className="p-4 overflow-x-auto">
          {report && report.cohort.length > 0 ? (
            <table className="text-xs border-separate border-spacing-[2px]">
              <thead>
                <tr>
                  <th className="text-left text-slate-500 font-medium px-2 py-1 sticky left-0 bg-white dark:bg-slate-900 z-10">
                    Cohort
                  </th>
                  <th className="text-right text-slate-500 font-medium px-2 py-1">
                    Size
                  </th>
                  {Array.from({ length: 12 }, (_, i) => (
                    <th
                      key={i}
                      className="text-center text-slate-500 font-medium px-2 py-1"
                    >
                      M{i}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.cohort.map((row) => (
                  <tr key={row.cohort}>
                    <th className="text-left font-medium text-slate-700 dark:text-slate-200 px-2 py-1 sticky left-0 bg-white dark:bg-slate-900 z-10">
                      {row.cohort}
                    </th>
                    <td className="text-right tabular-nums text-slate-700 dark:text-slate-200 px-2 py-1">
                      {formatNum(row.cohortSize)}
                    </td>
                    {row.cells.map((c) => (
                      <td
                        key={c.monthOffset}
                        className={cn(
                          'text-center tabular-nums px-2 py-1 rounded-sm',
                          cohortToneFor(c.retainedPct),
                        )}
                        title={`${row.cohort} → M${c.monthOffset}: ${c.retainedCount} retained (${(c.retainedPct * 100).toFixed(1)}%)`}
                      >
                        {c.retainedPct === 0
                          ? '—'
                          : `${(c.retainedPct * 100).toFixed(0)}%`}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-tertiary text-sm">
              {loading ? 'Loading…' : 'No cohort data'}
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
        <Card title="Geography" description="Customers + revenue by marketplace">
          {report && report.byGeography.length > 0 ? (
            <BreakdownBar
              entries={report.byGeography.map((g) => ({
                key: g.marketplace,
                label: g.marketplace,
                value: g.revenue,
              }))}
              format="currency"
              currency="EUR"
              total={report.byGeography.reduce((s, g) => s + g.revenue, 0)}
            />
          ) : (
            <div className="h-[200px] flex items-center justify-center text-tertiary text-sm">
              {loading ? 'Loading…' : 'No data'}
            </div>
          )}
        </Card>
        <Card title="Avg orders per customer">
          {report ? (
            <div className="flex flex-col items-center justify-center h-[200px]">
              <div className="text-4xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {report.totals.avgOrdersPerCustomer != null
                  ? report.totals.avgOrdersPerCustomer.toFixed(2)
                  : '—'}
              </div>
              <div className="text-xs text-slate-500 mt-1">orders / customer this window</div>
            </div>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-tertiary text-sm">
              {loading ? 'Loading…' : ''}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Top customers"
        description="Top 25 by lifetime spend"
      >
        {report ? (
          <TableWithSparkline
            rows={report.topCustomers}
            columns={topColumns}
            currency="EUR"
            rowKey={(r) => r.id}
            dense
            emptyLabel="No customers in scope"
          />
        ) : (
          <div className="text-sm text-tertiary py-6 text-center">
            {loading ? 'Loading…' : ''}
          </div>
        )}
      </Card>
    </div>
  )
}
