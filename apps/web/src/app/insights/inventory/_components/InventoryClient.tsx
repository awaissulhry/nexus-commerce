'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ChevronLeft, Snowflake, ZapOff } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import {
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

interface InventoryRow {
  sku: string
  productId: string
  productName: string | null
  brand: string | null
  available: number
  reserved: number
  costPrice: number | null
  inventoryValue: number
  unitsSold: number
  revenue: number
  daysOfInventory: number | null
  lastMovementAt: string | null
  stockoutDays: number
  stockoutCostEstimate: number
  returnsCount: number
  returnRatePct: number | null
  abcClass: string | null
}

interface AbcBucket {
  abcClass: string
  label: string
  count: number
  inventoryValue: number
  revenueShare: number
}

interface InventoryReport {
  window: { from: string; to: string }
  totals: {
    skuCount: number
    inventoryValue: number
    deadStockValue: number
    deadStockSkus: number
    avgDaysOfInventory: number | null
    stockoutCostEstimate: number
    returnRatePct: number | null
  }
  abcMix: AbcBucket[]
  rows: InventoryRow[]
  deadStock: InventoryRow[]
  stockoutWatch: InventoryRow[]
}

const ABC_COLORS: Record<string, string> = {
  A: 'rgb(16 185 129)',
  B: 'rgb(59 130 246)',
  C: 'rgb(245 158 11)',
  D: 'rgb(244 63 94)',
  '—': 'rgb(100 116 139)',
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

export default function InventoryClient() {
  const params = useSearchParams()
  const filterState = readFilterState(
    new URLSearchParams(params?.toString() ?? ''),
  )
  const [report, setReport] = useState<InventoryReport | null>(null)
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
          `${getBackendUrl()}/api/insights/inventory?${qs}`,
          { credentials: 'include' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json: InventoryReport = await res.json()
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
      `${getBackendUrl()}/api/insights/inventory?${qs.toString()}`,
      '_blank',
    )
  }

  const rowColumns: TableColumn<InventoryRow>[] = [
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
      key: 'abc',
      label: 'ABC',
      align: 'center',
      accessor: (r) =>
        r.abcClass ? (
          <span
            className={cn(
              'inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold',
              r.abcClass === 'A'
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                : r.abcClass === 'B'
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                  : r.abcClass === 'C'
                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                    : 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
            )}
          >
            {r.abcClass}
          </span>
        ) : (
          <span className="text-slate-400">—</span>
        ),
      format: 'text',
      width: '40px',
    },
    {
      key: 'available',
      label: 'Available',
      align: 'right',
      accessor: (r) => r.available,
      format: 'number',
    },
    {
      key: 'value',
      label: 'Value',
      align: 'right',
      accessor: (r) => r.inventoryValue,
      format: 'currency',
    },
    {
      key: 'units',
      label: 'Units sold',
      align: 'right',
      accessor: (r) => r.unitsSold,
      format: 'number',
    },
    {
      key: 'doh',
      label: 'DoH',
      align: 'right',
      accessor: (r) =>
        r.daysOfInventory == null ? '—' : (
          <span
            className={cn(
              'tabular-nums',
              r.daysOfInventory < 7
                ? 'text-rose-600 dark:text-rose-400 font-semibold'
                : r.daysOfInventory < 30
                  ? 'text-amber-600 dark:text-amber-400'
                  : '',
            )}
          >
            {Math.round(r.daysOfInventory)}d
          </span>
        ),
      format: 'text',
      width: '60px',
    },
    {
      key: 'returns',
      label: 'Returns',
      align: 'right',
      accessor: (r) =>
        r.returnRatePct == null ? '—' : (
          <span
            className={cn(
              'tabular-nums',
              r.returnRatePct > 20
                ? 'text-rose-600 dark:text-rose-400'
                : r.returnRatePct > 5
                  ? 'text-amber-600 dark:text-amber-400'
                  : '',
            )}
          >
            {r.returnRatePct.toFixed(1)}%
          </span>
        ),
      format: 'text',
      width: '70px',
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
        title="Inventory & fulfillment"
        description="Inventory value, ABC mix, dead stock, stockout cost and return rate per SKU."
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
          value={report ? formatNum(report.totals.skuCount) : loading ? '…' : '—'}
          accent="emerald"
        />
        <KPICard
          label="Inventory value"
          value={
            report
              ? formatCurrency(report.totals.inventoryValue, 'EUR')
              : loading
                ? '…'
                : '—'
          }
          accent="blue"
        />
        <KPICard
          label="Dead stock value"
          value={
            report
              ? formatCurrency(report.totals.deadStockValue, 'EUR')
              : loading
                ? '…'
                : '—'
          }
          accent="rose"
          invertDelta
          secondary={
            report ? `${formatNum(report.totals.deadStockSkus)} SKUs` : undefined
          }
        />
        <KPICard
          label="Avg days on hand"
          value={
            report?.totals.avgDaysOfInventory != null
              ? `${Math.round(report.totals.avgDaysOfInventory)}d`
              : loading
                ? '…'
                : '—'
          }
          accent="violet"
        />
        <KPICard
          label="Stockout cost estimate"
          value={
            report
              ? formatCurrency(report.totals.stockoutCostEstimate, 'EUR')
              : loading
                ? '…'
                : '—'
          }
          accent="amber"
          invertDelta
          secondary="potential lost sales"
        />
        <KPICard
          label="Return rate"
          value={
            report?.totals.returnRatePct != null
              ? formatPct(report.totals.returnRatePct)
              : loading
                ? '…'
                : '—'
          }
          accent="rose"
          invertDelta
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-3">
        <Card title="ABC class mix" description="Population + value by class">
          {report && report.abcMix.length > 0 ? (
            <BreakdownPie
              entries={report.abcMix
                .filter((b) => b.count > 0)
                .map((b) => ({
                  key: b.abcClass,
                  label: `${b.abcClass} (${b.count})`,
                  value: b.inventoryValue,
                  color: ABC_COLORS[b.abcClass],
                }))}
              variant="donut"
              format="currency"
              currency="EUR"
              height={220}
              centerLabel="Value"
              centerValue={formatCurrency(report.totals.inventoryValue, 'EUR')}
            />
          ) : (
            <div className="h-[220px] flex items-center justify-center text-slate-400 text-sm">
              {loading ? 'Loading…' : 'No data'}
            </div>
          )}
        </Card>
        <Card
          title={
            <span className="inline-flex items-center gap-1.5">
              <Snowflake className="w-4 h-4 text-blue-500" />
              Dead stock
            </span>
          }
          description="No movement this window, stock on hand"
          className="lg:col-span-2"
        >
          {report && report.deadStock.length > 0 ? (
            <TableWithSparkline
              rows={report.deadStock.slice(0, 10)}
              columns={rowColumns.filter(
                (c) => c.key !== 'units' && c.key !== 'returns',
              )}
              currency="EUR"
              rowKey={(r) => r.sku}
              dense
            />
          ) : (
            <div className="text-sm text-slate-400 py-6 text-center">
              {loading ? 'Loading…' : 'No dead stock — every SKU moved this window'}
            </div>
          )}
        </Card>
      </div>

      {report && report.stockoutWatch.length > 0 && (
        <Card
          title={
            <span className="inline-flex items-center gap-1.5">
              <ZapOff className="w-4 h-4 text-rose-500" />
              Stockout watch
            </span>
          }
          description={`${report.stockoutWatch.length} SKU${report.stockoutWatch.length === 1 ? '' : 's'} with < 7 days of inventory`}
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
        title="All SKUs"
        description="Top 100 by inventory value"
      >
        {report ? (
          <TableWithSparkline
            rows={report.rows}
            columns={rowColumns}
            currency="EUR"
            rowKey={(r) => r.sku}
            dense
            emptyLabel="No inventory data"
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
