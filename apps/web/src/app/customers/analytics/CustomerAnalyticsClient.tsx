'use client'

import { useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Overview {
  totalCustomers: number
  b2bCount: number
  b2cCount: number
  unknownCount: number
  newLast30d: number
  atRiskCount: number
  lostCount: number
  championCount: number
  repeatRate: number
  avgOrderFrequency: number
  ltvPercentiles: { p10: number; p25: number; p50: number; p75: number; p90: number }
  rfmDistribution: Record<string, number>
  topChannels: Array<{ channel: string; customerCount: number }>
}

const RFM_LABELS: Array<{ key: string; label: string; color: string }> = [
  { key: 'CHAMPION',  label: 'Champions',  color: 'bg-emerald-500' },
  { key: 'LOYAL',     label: 'Loyal',       color: 'bg-teal-500' },
  { key: 'POTENTIAL', label: 'Potential',   color: 'bg-blue-500' },
  { key: 'NEW',       label: 'New',         color: 'bg-violet-500' },
  { key: 'AT_RISK',   label: 'At Risk',     color: 'bg-amber-500' },
  { key: 'LOST',      label: 'Lost',        color: 'bg-rose-500' },
  { key: 'ONE_TIME',  label: 'One-Time',    color: 'bg-slate-400' },
]

const CHANNEL_COLORS: Record<string, string> = {
  AMAZON: 'bg-amber-400',
  EBAY: 'bg-blue-400',
  SHOPIFY: 'bg-emerald-400',
}

function euros(cents: number): string {
  return `€${(cents / 100).toFixed(0)}`
}

function LTVBar({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-slate-400 w-6 shrink-0">{label}</span>
      <div className="flex-1 h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-violet-500 rounded-full"
          style={{ width: `${Math.min((value / Math.max(max, 1)) * 100, 100)}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-slate-600 dark:text-slate-400 w-16 text-right shrink-0">
        {euros(value)}
      </span>
    </div>
  )
}

export function CustomerAnalyticsClient({ overview }: { overview: Overview }) {
  const [recomputeBusy, setRecomputeBusy] = useState(false)
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null)

  const total = overview.totalCustomers

  async function recomputeRFM() {
    setRecomputeBusy(true)
    setRecomputeMsg(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/customers/analytics/rfm/recompute`, { method: 'POST' })
      const json = (await res.json()) as { processed: number; errors: number }
      setRecomputeMsg(`Scored ${json.processed} customers (${json.errors} errors)`)
    } finally {
      setRecomputeBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* RFM heatmap */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300">
            RFM Segments
          </h2>
          <div className="flex items-center gap-2">
            {recomputeMsg && (
              <span className="text-xs text-slate-500">{recomputeMsg}</span>
            )}
            <button
              type="button"
              onClick={recomputeRFM}
              disabled={recomputeBusy}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded ring-1 ring-inset ring-slate-300 dark:ring-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-50 disabled:opacity-40"
            >
              {recomputeBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Recompute RFM
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {RFM_LABELS.map(({ key, label, color }) => {
            const count = overview.rfmDistribution[key] ?? 0
            const pct = total > 0 ? Math.round(count / total * 100) : 0
            return (
              <div
                key={key}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2"
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <div className={`w-2 h-2 rounded-full ${color}`} />
                  <span className="text-xs text-slate-600 dark:text-slate-400">{label}</span>
                </div>
                <div className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">{count}</div>
                <div className="text-[10px] text-slate-400">{pct}% of total</div>
              </div>
            )
          })}
        </div>
        {Object.keys(overview.rfmDistribution).length === 0 && (
          <p className="text-xs text-slate-400 mt-2">
            No RFM scores yet — click "Recompute RFM" to score all customers.
          </p>
        )}
      </section>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        {/* LTV distribution */}
        <section>
          <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
            LTV Distribution (Lifetime Value)
          </h2>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-3 space-y-2">
            <LTVBar label="P10" value={overview.ltvPercentiles.p10} max={overview.ltvPercentiles.p90} />
            <LTVBar label="P25" value={overview.ltvPercentiles.p25} max={overview.ltvPercentiles.p90} />
            <LTVBar label="P50" value={overview.ltvPercentiles.p50} max={overview.ltvPercentiles.p90} />
            <LTVBar label="P75" value={overview.ltvPercentiles.p75} max={overview.ltvPercentiles.p90} />
            <LTVBar label="P90" value={overview.ltvPercentiles.p90} max={overview.ltvPercentiles.p90} />
            <p className="text-[10px] text-slate-400 pt-1">
              Median LTV: {euros(overview.ltvPercentiles.p50)} · P90: {euros(overview.ltvPercentiles.p90)}
            </p>
          </div>
        </section>

        {/* Channel concentration + B2B/B2C */}
        <div className="space-y-3">
          {overview.topChannels.length > 0 && (
            <section>
              <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                Channel Concentration
              </h2>
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-3 space-y-2">
                {overview.topChannels.map((ch) => {
                  const pct = total > 0 ? Math.round(ch.customerCount / total * 100) : 0
                  return (
                    <div key={ch.channel} className="flex items-center gap-2">
                      <span className="text-xs text-slate-600 dark:text-slate-400 w-20 shrink-0">{ch.channel}</span>
                      <div className="flex-1 h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${CHANNEL_COLORS[ch.channel] ?? 'bg-slate-400'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-xs text-slate-500 w-16 text-right">{ch.customerCount} ({pct}%)</span>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          <section>
            <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
              Customer Type
            </h2>
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                {[
                  { label: 'B2B', count: overview.b2bCount, color: 'bg-violet-500' },
                  { label: 'B2C', count: overview.b2cCount, color: 'bg-blue-500' },
                  { label: 'Unknown', count: overview.unknownCount, color: 'bg-slate-300 dark:bg-slate-700' },
                ].map(({ label, count, color }) => {
                  const pct = total > 0 ? Math.round(count / total * 100) : 0
                  return (
                    <div key={label} style={{ flex: `${pct} 0 0` }} className="min-w-0">
                      <div className={`h-4 ${color} rounded-sm`} title={`${label}: ${count}`} />
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center gap-4 text-xs text-slate-500">
                <span>B2B: {overview.b2bCount}</span>
                <span>B2C: {overview.b2cCount}</span>
                <span>Avg {overview.avgOrderFrequency.toFixed(1)} orders/customer</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
