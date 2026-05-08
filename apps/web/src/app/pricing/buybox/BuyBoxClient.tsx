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
  Loader2,
  RefreshCw,
  Trophy,
  Users,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { useTranslations } from '@/lib/i18n/use-translations'
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

export default function BuyBoxClient() {
  const { t } = useTranslations()
  const WINDOWS = [
    { days: 7, label: t('pricing.buybox.window.7days') },
    { days: 14, label: t('pricing.buybox.window.14days') },
    { days: 30, label: t('pricing.buybox.window.30days') },
  ]
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
        <div className="text-md text-slate-500 dark:text-slate-400 py-8 text-center inline-flex items-center justify-center gap-2 w-full">
          <Loader2 className="w-4 h-4 animate-spin" /> {t('pricing.buybox.loading')}
        </div>
      </Card>
    )
  }

  if (error) {
    return (
      <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950 rounded px-3 py-2 text-base text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
        <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
        <span>{error}</span>
      </div>
    )
  }

  if (!data || data.observations === 0) {
    return (
      <EmptyState
        icon={Trophy}
        title={t('pricing.buybox.empty')}
        description={t('pricing.buybox.emptyHint')}
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
          <div className="text-base text-slate-700 dark:text-slate-300">{t('pricing.buybox.window')}</div>
        {WINDOWS.map((w) => (
          <button
            key={w.days}
            onClick={() => setDays(w.days)}
            className={cn(
              'h-7 px-2.5 text-base border rounded-md',
              days === w.days
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800',
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
            {t('pricing.action.refresh')}
          </Button>
        </div>
      </div>

      {/* Headline */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card>
          <div className="space-y-0.5">
            <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              {t('pricing.buybox.headline.winRate', { days: data.windowDays })}
            </div>
            <div
              className={cn(
                'text-[32px] font-semibold tabular-nums leading-none mt-1',
                overallTone === 'rose'
                  ? 'text-rose-700 dark:text-rose-300'
                  : overallTone === 'amber'
                  ? 'text-amber-700 dark:text-amber-300'
                  : overallTone === 'emerald'
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : 'text-slate-700 dark:text-slate-300',
              )}
            >
              {data.winRatePct != null ? `${data.winRatePct.toFixed(1)}%` : '—'}
            </div>
            <div className="text-sm text-slate-500 dark:text-slate-400">
              {t('pricing.buybox.headline.winsObs', {
                wins: data.ourWins.toLocaleString(),
                obs: data.observations.toLocaleString(),
              })}
            </div>
          </div>
        </Card>
        <Card>
          <div className="space-y-0.5">
            <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              {t('pricing.buybox.headline.markets')}
            </div>
            <div className="text-[32px] font-semibold tabular-nums leading-none mt-1 text-slate-800 dark:text-slate-200">
              {data.byMarketplace.length}
            </div>
            <div className="text-sm text-slate-500 dark:text-slate-400">
              {t('pricing.buybox.headline.marketsHint')}
            </div>
          </div>
        </Card>
        <Card>
          <div className="space-y-0.5">
            <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              {t('pricing.buybox.headline.competitors')}
            </div>
            <div className="text-[32px] font-semibold tabular-nums leading-none mt-1 text-slate-800 dark:text-slate-200">
              {data.topCompetitors.length}
            </div>
            <div className="text-sm text-slate-500 dark:text-slate-400">
              {t('pricing.buybox.headline.competitorsHint', {
                n: data.topCompetitors.length,
              })}
            </div>
          </div>
        </Card>
      </div>

      {/* Per-marketplace table */}
      <div className="space-y-2">
        <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
          {t('pricing.buybox.section.perMarketplace', {
            n: data.byMarketplace.length,
          })}
        </div>
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-md">
              <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                    {t('pricing.buybox.table.channel')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                    {t('pricing.buybox.table.marketplace')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                    {t('pricing.buybox.table.wins')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                    {t('pricing.buybox.table.observations')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 min-w-[200px]">
                    {t('pricing.buybox.table.winRate')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.byMarketplace.map((m) => (
                  <tr
                    key={`${m.channel}|${m.marketplace}`}
                    className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <td className="px-3 py-2 text-slate-700 dark:text-slate-300 font-medium">
                      {m.channel}
                    </td>
                    <td className="px-3 py-2 font-mono text-sm text-slate-700 dark:text-slate-300">
                      {m.marketplace}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">
                      {m.ourWins.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
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
          <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold inline-flex items-center gap-1.5">
            <Users size={12} />{' '}
            {t('pricing.buybox.section.topCompetitors', {
              n: data.topCompetitors.length,
            })}
          </div>
          <Card noPadding>
            <div className="overflow-x-auto">
              <table className="w-full text-md">
                <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                      {t('pricing.buybox.table.sellerId')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                      {t('pricing.buybox.table.fulfillment')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                      {t('pricing.buybox.table.timesWon')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.topCompetitors.map((c, i) => (
                    <tr
                      key={`${c.winnerSellerId}|${c.fulfillmentMethod}|${i}`}
                      className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <td className="px-3 py-2 font-mono text-sm text-slate-700 dark:text-slate-300">
                        {c.winnerSellerId ?? t('pricing.buybox.unknownSeller')}
                      </td>
                      <td className="px-3 py-2 text-base text-slate-700 dark:text-slate-300">
                        {c.fulfillmentMethod ?? (
                          <span className="text-slate-400 dark:text-slate-500 dark:text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-800 dark:text-slate-200">
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
    return <span className="text-sm text-slate-400 dark:text-slate-500 dark:text-slate-400">—</span>
  }
  const tone =
    pct < 50 ? 'rose' : pct < 80 ? 'amber' : 'emerald'
  const barCls = {
    rose: 'bg-rose-400',
    amber: 'bg-amber-400',
    emerald: 'bg-emerald-400',
  }[tone]
  const textCls = {
    rose: 'text-rose-700 dark:text-rose-300',
    amber: 'text-amber-700 dark:text-amber-300',
    emerald: 'text-emerald-700 dark:text-emerald-300',
  }[tone]
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
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
