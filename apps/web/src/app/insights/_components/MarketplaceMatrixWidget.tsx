'use client'

/**
 * I9 — multi-currency marketplace matrix.
 *
 * Renders one row per (channel, marketplace, currency) tuple from the
 * `summary.byMarketplace` payload. Each row stands alone in its native
 * currency — there is no implicit conversion. This is the canonical
 * read for any operator selling across multiple Amazon marketplaces or
 * mixing channels, mirroring the per-marketplace P&L view in Amazon
 * Seller Central.
 */

import { Card } from '@/components/ui/Card'
import {
  formatCurrency,
  formatNum,
  formatDelta,
  deltaTone,
} from '@/components/insights'
import type { MarketplaceMetricsRow } from './useInsightsData'

const CHANNEL_TONE: Record<string, string> = {
  AMAZON:
    'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900/60',
  EBAY:
    'bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900/60',
  SHOPIFY:
    'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900/60',
}

const DELTA_TONE: Record<string, string> = {
  pos: 'text-emerald-600 dark:text-emerald-400',
  neg: 'text-rose-600 dark:text-rose-400',
  flat: 'text-slate-500 dark:text-slate-400',
  na: 'text-slate-400 dark:text-slate-500',
}

export function MarketplaceMatrixWidget({
  rows,
  loading,
}: {
  rows: MarketplaceMetricsRow[]
  loading: boolean
}) {
  if (loading && rows.length === 0) {
    return (
      <Card
        title="Per-marketplace P&L"
        description="Native currency per row — no implicit conversion"
      >
        <div className="h-[180px] flex items-center justify-center text-slate-400 text-sm">
          Loading…
        </div>
      </Card>
    )
  }
  if (rows.length === 0) return null

  const sorted = [...rows].sort((a, b) => b.revenue.current - a.revenue.current)

  return (
    <Card
      title="Per-marketplace P&L"
      description="One row per (channel × marketplace × currency) — native currency, no implicit conversion"
      action={
        <span className="text-xs text-slate-500 tabular-nums">
          {sorted.length} {sorted.length === 1 ? 'marketplace' : 'marketplaces'}
        </span>
      }
      noPadding
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <th className="text-left font-medium px-3 py-2">Channel</th>
              <th className="text-left font-medium px-3 py-2">Market</th>
              <th className="text-right font-medium px-3 py-2">Revenue</th>
              <th className="text-right font-medium px-3 py-2">Refunds</th>
              <th className="text-right font-medium px-3 py-2">Net</th>
              <th className="text-right font-medium px-3 py-2">Orders</th>
              <th className="text-right font-medium px-3 py-2">Units</th>
              <th className="text-right font-medium px-3 py-2">AOV</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const key = `${row.channel}|${row.marketplace}|${row.currency}`
              const revDelta = formatDelta(row.revenue.deltaPct)
              const revTone = deltaTone(row.revenue.deltaPct)
              const netDelta = formatDelta(row.netRevenue.deltaPct)
              const netTone = deltaTone(row.netRevenue.deltaPct)
              const channelClass =
                CHANNEL_TONE[row.channel] ??
                'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700'
              return (
                <tr
                  key={key}
                  className="border-b border-slate-100 dark:border-slate-800/60 last:border-0 hover:bg-slate-50/60 dark:hover:bg-slate-800/30"
                >
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${channelClass}`}
                    >
                      {row.channel}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-medium text-slate-900 dark:text-slate-100">
                      {row.marketplace}
                    </span>
                    <span className="ml-1.5 text-[11px] text-slate-400 dark:text-slate-500 font-mono">
                      {row.currency}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <div className="font-semibold text-slate-900 dark:text-slate-100">
                      {formatCurrency(row.revenue.current, row.currency)}
                    </div>
                    <div className={`text-[11px] ${DELTA_TONE[revTone]}`}>
                      {revDelta.label}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-400">
                    {row.refunds.current > 0
                      ? `−${formatCurrency(row.refunds.current, row.currency)}`
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <div className="font-medium text-slate-900 dark:text-slate-100">
                      {formatCurrency(row.netRevenue.current, row.currency)}
                    </div>
                    <div className={`text-[11px] ${DELTA_TONE[netTone]}`}>
                      {netDelta.label}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                    {formatNum(row.orders.current)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                    {formatNum(row.units.current)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                    {row.orders.current > 0
                      ? formatCurrency(row.aov.current, row.currency)
                      : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
