/**
 * AD.2 — Daily True Profit grid.
 *
 * Per-product daily P&L with margin color bands and coverage badges.
 * Coverage shows which fee components are real (from ProductProfitDaily.coverage)
 * vs zero-by-default (e.g. ad spend before AD.2's metrics-ingest runs).
 */

import Link from 'next/link'
import { TrendingUp } from 'lucide-react'
import { AdvertisingNav } from '../_shared/AdvertisingNav'
import { formatEur, formatPct, MARGIN_BAND_CLASS, marginBand } from '../_shared/formatters'
import { getBackendUrl } from '@/lib/backend-url'

export const dynamic = 'force-dynamic'

interface ProfitRow {
  id: string
  productId: string
  marketplace: string
  date: string
  unitsSold: number
  grossRevenueCents: number
  cogsCents: number
  referralFeesCents: number
  fbaFulfillmentFeesCents: number
  fbaStorageFeesCents: number
  advertisingSpendCents: number
  returnsRefundsCents: number
  trueProfitCents: number
  trueProfitMarginPct: string | null
  coverage: { hasCostPrice?: boolean; hasReferralFee?: boolean; hasFbaFee?: boolean; hasAdSpend?: boolean } | null
  product: { id: string; sku: string; name: string } | null
}

async function fetchProfit(): Promise<ProfitRow[]> {
  const res = await fetch(
    `${getBackendUrl()}/api/advertising/profit/daily?limit=500`,
    { cache: 'no-store' },
  )
  if (!res.ok) return []
  const json = (await res.json()) as { items: ProfitRow[] }
  return json.items
}

function coveragePct(c: ProfitRow['coverage']): number {
  if (!c) return 0
  const fields = [c.hasCostPrice, c.hasReferralFee, c.hasFbaFee, c.hasAdSpend]
  return fields.filter(Boolean).length / fields.length
}

export default async function ProfitPage() {
  const rows = await fetchProfit()

  const totals = rows.reduce(
    (acc, r) => {
      acc.revenue += r.grossRevenueCents
      acc.cogs += r.cogsCents
      acc.fees += r.referralFeesCents + r.fbaFulfillmentFeesCents + r.fbaStorageFeesCents
      acc.adSpend += r.advertisingSpendCents
      acc.refunds += r.returnsRefundsCents
      acc.profit += r.trueProfitCents
      acc.units += r.unitsSold
      return acc
    },
    { revenue: 0, cogs: 0, fees: 0, adSpend: 0, refunds: 0, profit: 0, units: 0 },
  )
  const totalMargin = totals.revenue > 0 ? totals.profit / totals.revenue : null

  return (
    <div className="px-4 py-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
        <TrendingUp className="h-5 w-5 text-emerald-500" />
        Daily True Profit
      </h1>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
        Revenue − COGS − Amazon Fees − FBA Fees − Storage − Ad Spend − Refunds.
        Rows with partial coverage show a badge — missing fields default to 0
        (e.g. ad spend before the AD.2 metrics ingest runs).
      </p>
      <AdvertisingNav />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <Stat label="Revenue" value={formatEur(totals.revenue)} />
        <Stat label="COGS" value={formatEur(totals.cogs)} />
        <Stat label="Fees" value={formatEur(totals.fees)} />
        <Stat label="True Profit" value={formatEur(totals.profit)} />
        <Stat
          label="Margin"
          value={totalMargin != null ? formatPct(totalMargin) : '—'}
          band={marginBand(totalMargin)}
        />
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-950/50 border-b border-slate-200 dark:border-slate-800">
            <tr className="text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">SKU</th>
              <th className="px-3 py-2">Mkt</th>
              <th className="px-3 py-2 text-right">Units</th>
              <th className="px-3 py-2 text-right">Revenue</th>
              <th className="px-3 py-2 text-right">COGS</th>
              <th className="px-3 py-2 text-right">Fees</th>
              <th className="px-3 py-2 text-right">Adv</th>
              <th className="px-3 py-2 text-right">Profit</th>
              <th className="px-3 py-2 text-right">Margin</th>
              <th className="px-3 py-2">Cov.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-3 py-6 text-center text-sm text-slate-500">
                  No P&amp;L rows. Run:{' '}
                  <code className="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
                    POST /api/advertising/cron/true-profit-rollup/trigger
                  </code>
                </td>
              </tr>
            ) : (
              rows.slice(0, 200).map((r) => {
                const margin = r.trueProfitMarginPct != null ? Number(r.trueProfitMarginPct) : null
                const band = marginBand(margin)
                const cov = coveragePct(r.coverage)
                return (
                  <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-950/40">
                    <td className="px-3 py-2 text-xs font-mono tabular-nums">
                      {new Date(r.date).toLocaleDateString('en-GB', {
                        month: '2-digit',
                        day: '2-digit',
                      })}
                    </td>
                    <td className="px-3 py-2">
                      {r.product ? (
                        <Link
                          href={`/products/${r.product.id}`}
                          className="text-blue-600 dark:text-blue-400 hover:underline font-mono"
                        >
                          {r.product.sku}
                        </Link>
                      ) : (
                        <span className="font-mono text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono">{r.marketplace}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.unitsSold}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatEur(r.grossRevenueCents)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatEur(r.cogsCents)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatEur(r.referralFeesCents + r.fbaFulfillmentFeesCents + r.fbaStorageFeesCents)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatEur(r.advertisingSpendCents)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        r.trueProfitCents >= 0
                          ? 'text-emerald-700 dark:text-emerald-300'
                          : 'text-rose-700 dark:text-rose-300'
                      }`}
                    >
                      {formatEur(r.trueProfitCents)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span
                        className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset ${MARGIN_BAND_CLASS[band]}`}
                      >
                        {margin != null ? formatPct(margin) : '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ring-1 ring-inset ${
                          cov >= 0.75
                            ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900'
                            : cov >= 0.5
                              ? 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900'
                              : 'bg-slate-50 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700'
                        }`}
                        title={JSON.stringify(r.coverage ?? {})}
                      >
                        {Math.round(cov * 100)}%
                      </span>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      {rows.length > 200 && (
        <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          Showing first 200 of {rows.length} rows. Filters coming in AD.2 polish.
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  band,
}: {
  label: string
  value: string
  band?: 'good' | 'warn' | 'bad' | 'none'
}) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div
        className={`text-base font-semibold tabular-nums ${
          band === 'good'
            ? 'text-emerald-700 dark:text-emerald-300'
            : band === 'warn'
              ? 'text-amber-700 dark:text-amber-300'
              : band === 'bad'
                ? 'text-rose-700 dark:text-rose-300'
                : 'text-slate-900 dark:text-slate-100'
        }`}
      >
        {value}
      </div>
    </div>
  )
}
