'use client'

/**
 * PH.4 — Per-rule repricing observability rollup.
 *
 * Aggregates the evaluator's decisions per RepricingRule so an operator
 * can answer "is this rule actually working?" at a glance: how often it
 * evaluated, how often it moved the price (and what %), the average
 * absolute move, and the coordinate's buy-box win rate. Reads
 * GET /api/pricing/repricing-rule-stats (PH.4 API).
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { BarChart3, Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

const STRATEGY_LABEL: Record<string, string> = {
  match_buy_box: 'Match Buy Box',
  beat_lowest_by_pct: 'Beat Lowest %',
  beat_lowest_by_amount: 'Beat Lowest €',
  fixed_to_buy_box_minus: 'Buy Box − Fixed',
  maximize_margin_win_box: 'Max Margin Win Box',
  manual: 'Manual',
}

interface RuleStat {
  ruleId: string
  channel: string
  marketplace: string | null
  strategy: string
  enabled: boolean
  product: { id: string; name: string; brand: string | null }
  evaluations: number
  moved: number
  movedPct: number
  avgDeltaAbs: number
  lastDecisionAt: string
  lastPrice: number
  buyBox: { observations: number; winRatePct: number } | null
}

const WINDOWS = [7, 14, 30] as const

export function RepricingRuleStats() {
  const router = useRouter()
  const [windowDays, setWindowDays] = useState<number>(7)
  const [rules, setRules] = useState<RuleStat[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchStats = useCallback(async (days: number) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/pricing/repricing-rule-stats?windowDays=${days}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setRules(json.rules ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchStats(windowDays)
  }, [fetchStats, windowDays])

  return (
    <div className="mb-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-violet-600 dark:text-violet-400" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            By rule
          </h2>
          {!loading && (
            <span className="text-xs text-slate-400 dark:text-slate-500">
              {rules.length} active over last {windowDays}d
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {WINDOWS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setWindowDays(d)}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${
                windowDays === d
                  ? 'bg-violet-600 text-white'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-slate-400 dark:text-slate-500 px-4 py-6">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading rule stats…
        </div>
      ) : error ? (
        <div className="text-sm text-slate-400 dark:text-slate-500 px-4 py-6">
          Couldn’t load rule stats ({error}).
        </div>
      ) : rules.length === 0 ? (
        <div className="text-sm text-slate-400 dark:text-slate-500 px-4 py-6">
          No rules have produced decisions in the last {windowDays} days.
          Create repricing rules on a product to populate this view.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500 border-b border-slate-100 dark:border-slate-800">
                <th className="font-medium px-4 py-2">Product</th>
                <th className="font-medium px-2 py-2">Strategy</th>
                <th className="font-medium px-2 py-2 text-right">Evals</th>
                <th className="font-medium px-2 py-2 text-right">Moved</th>
                <th className="font-medium px-2 py-2 text-right">Avg move</th>
                <th className="font-medium px-2 py-2 text-right">Win rate</th>
                <th className="font-medium px-4 py-2 text-right">Last</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr
                  key={r.ruleId}
                  onClick={() => router.push(`/products/${r.product.id}/edit`)}
                  className="border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer"
                >
                  <td className="px-4 py-2">
                    <div className="font-medium text-slate-800 dark:text-slate-200 truncate max-w-[220px]">
                      {r.product.name}
                    </div>
                    <div className="text-[11px] text-slate-400 dark:text-slate-500">
                      {r.channel}
                      {r.marketplace ? ` · ${r.marketplace}` : ''}
                      {!r.enabled && (
                        <span className="ml-1 text-slate-400">· paused</span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    {STRATEGY_LABEL[r.strategy] ?? r.strategy}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                    {r.evaluations}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    <span className="text-slate-700 dark:text-slate-300">{r.moved}</span>
                    <span
                      className={`ml-1 text-[11px] ${
                        r.movedPct >= 50
                          ? 'text-violet-600 dark:text-violet-400'
                          : 'text-slate-400 dark:text-slate-500'
                      }`}
                    >
                      ({r.movedPct}%)
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
                    {r.avgDeltaAbs > 0 ? `€${r.avgDeltaAbs.toFixed(2)}` : '—'}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {r.buyBox ? (
                      <span
                        className={
                          r.buyBox.winRatePct >= 70
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : r.buyBox.winRatePct >= 40
                              ? 'text-amber-700 dark:text-amber-400'
                              : 'text-rose-700 dark:text-rose-400'
                        }
                        title={`${r.buyBox.observations} observations`}
                      >
                        {r.buyBox.winRatePct}%
                      </span>
                    ) : (
                      <span className="text-slate-300 dark:text-slate-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-[11px] text-slate-400 dark:text-slate-500 whitespace-nowrap">
                    {new Date(r.lastDecisionAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
