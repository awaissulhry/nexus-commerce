'use client'

// F.2 — Buy Box drill-down dashboard.
//
// Reads /api/pricing/buybox-stats. Three sections:
//   1. Headline tile — overall win rate over the window + observation count.
//   2. Per-marketplace table — channel:marketplace × win rate (with bar) ×
//      observations. Sorted by observation count desc so the most-active
//      markets are at the top.
//   3. Top competitors — winnerSellerId + fulfillment method × times won.
//      Operator can copy a SellerId to investigate (their listings,
//      pricing strategy, fulfillment mix).

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Trophy,
  Users,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface MarketplaceStat {
  channel: string
  marketplace: string
  observations: number
  ourWins: number
  winRatePct: number | null
}

interface CompetitorStat {
  winnerSellerId: string | null
  fulfillmentMethod: string | null
  timesWon: number
}

interface BuyBoxStats {
  windowDays: number
  observations: number
  ourWins: number
  winRatePct: number | null
  byMarketplace: MarketplaceStat[]
  topCompetitors: CompetitorStat[]
}

const WINDOWS = [
  { days: 7, label: '7 days' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
]

export default function BuyBoxClient() {
  const [days, setDays] = useState(7)
  const [data, setData] = useState<BuyBoxStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/pricing/buybox-stats?days=${days}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (loading && !data) {
    return (
      <Card>
        <div className="text-md text-slate-500 py-8 text-center inline-flex items-center justify-center gap-2 w-full">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading Buy Box stats…
        </div>
      </Card>
    )
  }

  if (error) {
    return (
      <div className="border border-rose-200 bg-rose-50 rounded px-3 py-2 text-base text-rose-700 inline-flex items-start gap-1.5">
        <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
        <span>{error}</span>
      </div>
    )
  }

  if (!data || data.observations === 0) {
    return (
      <EmptyState
        icon={Trophy}
        title="No Buy Box observations yet"
        description="The daily SP-API competitive-pricing cron writes BuyBoxHistory rows for every Amazon listing it polls. Once SP-API creds are configured and the cron runs, win-rate trends appear here."
      />
    )
  }

  const overallTone =
    data.winRatePct == null
      ? 'slate'
      : data.winRatePct < 50
      ? 'rose'
      : data.winRatePct < 80
      ? 'amber'
      : 'emerald'

  return (
    <div className="space-y-4">
      {/* Window selector + refresh */}
      <div className="flex items-center gap-2">
        <div className="text-base text-slate-700">Window:</div>
        {WINDOWS.map((w) => (
          <button
            key={w.days}
            onClick={() => setDays(w.days)}
            className={cn(
              'h-7 px-2.5 text-base border rounded-md',
              days === w.days
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50',
            )}
          >
            {w.label}
          </button>
        ))}
        <div className="ml-auto">
          <Button
            variant="secondary"
            size="md"
            onClick={fetchData}
            icon={<RefreshCw size={12} />}
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* Headline */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card>
          <div className="space-y-0.5">
            <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold">
              Overall win rate · {data.windowDays}d
            </div>
            <div
              className={cn(
                'text-[32px] font-semibold tabular-nums leading-none mt-1',
                overallTone === 'rose'
                  ? 'text-rose-700'
                  : overallTone === 'amber'
                  ? 'text-amber-700'
                  : overallTone === 'emerald'
                  ? 'text-emerald-700'
                  : 'text-slate-700',
              )}
            >
              {data.winRatePct != null ? `${data.winRatePct.toFixed(1)}%` : '—'}
            </div>
            <div className="text-sm text-slate-500">
              {data.ourWins.toLocaleString()} / {data.observations.toLocaleString()} obs
            </div>
          </div>
        </Card>
        <Card>
          <div className="space-y-0.5">
            <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold">
              Markets observed
            </div>
            <div className="text-[32px] font-semibold tabular-nums leading-none mt-1 text-slate-800">
              {data.byMarketplace.length}
            </div>
            <div className="text-sm text-slate-500">
              channels × marketplaces with traffic
            </div>
          </div>
        </Card>
        <Card>
          <div className="space-y-0.5">
            <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold">
              Distinct competitors
            </div>
            <div className="text-[32px] font-semibold tabular-nums leading-none mt-1 text-slate-800">
              {data.topCompetitors.length}
            </div>
            <div className="text-sm text-slate-500">
              top {data.topCompetitors.length} shown below
            </div>
          </div>
        </Card>
      </div>

      {/* Per-marketplace table */}
      <div className="space-y-2">
        <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold">
          Per-marketplace · {data.byMarketplace.length}
        </div>
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-md">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                    Channel
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                    Marketplace
                  </th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700">
                    Wins
                  </th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700">
                    Observations
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 min-w-[200px]">
                    Win rate
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.byMarketplace.map((m) => (
                  <tr
                    key={`${m.channel}|${m.marketplace}`}
                    className="border-b border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-3 py-2 text-slate-700 font-medium">
                      {m.channel}
                    </td>
                    <td className="px-3 py-2 font-mono text-sm text-slate-700">
                      {m.marketplace}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-800">
                      {m.ourWins.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                      {m.observations.toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <WinRateBar pct={m.winRatePct} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* Top competitors */}
      {data.topCompetitors.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold inline-flex items-center gap-1.5">
            <Users size={12} /> Top competitors · {data.topCompetitors.length}
          </div>
          <Card noPadding>
            <div className="overflow-x-auto">
              <table className="w-full text-md">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                      Seller ID
                    </th>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                      Fulfillment
                    </th>
                    <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700">
                      Times won the box
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.topCompetitors.map((c, i) => (
                    <tr
                      key={`${c.winnerSellerId}|${c.fulfillmentMethod}|${i}`}
                      className="border-b border-slate-100 hover:bg-slate-50"
                    >
                      <td className="px-3 py-2 font-mono text-sm text-slate-700">
                        {c.winnerSellerId ?? '(unknown)'}
                      </td>
                      <td className="px-3 py-2 text-base text-slate-700">
                        {c.fulfillmentMethod ?? (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-800">
                        {c.timesWon.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}

function WinRateBar({ pct }: { pct: number | null }) {
  if (pct == null) {
    return <span className="text-sm text-slate-400">—</span>
  }
  const tone =
    pct < 50 ? 'rose' : pct < 80 ? 'amber' : 'emerald'
  const barCls = {
    rose: 'bg-rose-400',
    amber: 'bg-amber-400',
    emerald: 'bg-emerald-400',
  }[tone]
  const textCls = {
    rose: 'text-rose-700',
    amber: 'text-amber-700',
    emerald: 'text-emerald-700',
  }[tone]
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', barCls)}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <span className={cn('text-base font-semibold tabular-nums w-14 text-right', textCls)}>
        {pct.toFixed(1)}%
      </span>
    </div>
  )
}
