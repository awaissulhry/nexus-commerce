'use client'

/**
 * CS.4 — Dashboard panel for the channel-stock-event triage queue.
 *
 * Sits next to StockDriftPanel on /dashboard/health. Surfaces the
 * OPEN (PENDING + REVIEW_NEEDED) ChannelStockEvent count + top 5
 * worst drifts so the operator sees pending channel drift without
 * navigating to /fulfillment/stock/channel-drift.
 *
 * Distinct from StockDriftPanel: that one watches OUTBOUND drift
 * (master vs what we pushed to channels). This one watches INBOUND
 * drift (channels pushing values back at us).
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRight, CheckCircle2, Cable, Loader2, RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'

interface ChannelStockEvent {
  id: string
  channel: string
  channelEventId: string
  productId: string | null
  sku: string
  channelReportedQty: number
  localQtyAtObservation: number
  drift: number
  status: 'PENDING' | 'AUTO_APPLIED' | 'REVIEW_NEEDED' | 'APPLIED' | 'IGNORED'
  createdAt: string
  product: { id: string; sku: string; name: string } | null
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

export default function ChannelStockEventPanel() {
  const { t } = useTranslations()
  const [events, setEvents] = useState<ChannelStockEvent[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchEvents = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/stock/channel-events?status=OPEN&limit=100`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setEvents(data.items ?? [])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchEvents() }, [fetchEvents])

  // Sort by abs(drift) desc so the worst surfaces first. Cap at 5.
  const topRows = (events ?? [])
    .slice()
    .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift))
    .slice(0, 5)

  // Aggregate by channel for the header badges.
  const byChannel = new Map<string, number>()
  for (const e of events ?? []) {
    byChannel.set(e.channel, (byChannel.get(e.channel) ?? 0) + 1)
  }
  const totalOpen = events?.length ?? 0

  return (
    <section
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden"
      aria-labelledby="cs-panel-title"
    >
      <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
        <div className="flex items-center gap-2">
          <Cable size={14} className="text-slate-500 dark:text-slate-400" aria-hidden="true" />
          <h2 id="cs-panel-title" className="text-md font-semibold text-slate-900 dark:text-slate-100">
            {t('channelDrift.pageTitle')}
          </h2>
          {totalOpen > 0 && (
            <span className="text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-200">
              {t('channelDrift.dashboard.openCount', { n: totalOpen })}
            </span>
          )}
          {byChannel.size > 0 && (
            <div className="hidden sm:flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
              {Array.from(byChannel.entries()).map(([channel, count]) => (
                <span key={channel} className="font-mono">
                  {channel}:{count}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchEvents}
            disabled={loading}
            className="h-7 w-7 inline-flex items-center justify-center rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50"
            aria-label={t('common.refresh')}
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
          <Link
            href="/fulfillment/stock/channel-drift"
            className="text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 inline-flex items-center gap-0.5"
          >
            {t('channelDrift.dashboard.openTriage')} <ArrowRight size={11} aria-hidden="true" />
          </Link>
        </div>
      </header>

      {loading && !events && (
        <div className="px-5 py-8 text-center text-md text-slate-500 dark:text-slate-400 inline-flex items-center justify-center gap-2 w-full">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          {t('channelDrift.dashboard.loading')}
        </div>
      )}

      {error && (
        <div className="px-5 py-3 text-md text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border-b border-rose-200 dark:border-rose-900 inline-flex items-center gap-2 w-full">
          <AlertTriangle size={14} aria-hidden="true" /> {t('channelDrift.dashboard.loadFailed', { error })}
        </div>
      )}

      {!loading && !error && totalOpen === 0 && (
        <div className="px-5 py-8 text-center">
          <CheckCircle2 size={20} className="text-emerald-500 dark:text-emerald-400 mx-auto mb-2" aria-hidden="true" />
          <p className="text-md text-slate-500 dark:text-slate-400">
            {t('channelDrift.dashboard.allSynced')}
          </p>
        </div>
      )}

      {!loading && totalOpen > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800 text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">
              <tr>
                <th className="text-left font-semibold px-3 py-2">{t('channelDrift.col.channel')}</th>
                <th className="text-left font-semibold px-3 py-2">{t('channelDrift.col.product')}</th>
                <th className="text-right font-semibold px-3 py-2">{t('channelDrift.col.local')}</th>
                <th className="text-right font-semibold px-3 py-2">{t('channelDrift.col.channelReported')}</th>
                <th className="text-right font-semibold px-3 py-2">{t('channelDrift.col.drift')}</th>
                <th className="text-left font-semibold px-3 py-2">{t('channelDrift.col.observed')}</th>
              </tr>
            </thead>
            <tbody>
              {topRows.map((e) => {
                const driftLarge = Math.abs(e.drift) > 5
                return (
                  <tr key={e.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs text-slate-700 dark:text-slate-300">{e.channel}</td>
                    <td className="px-3 py-2">
                      {e.product ? (
                        <Link href={`/products/${e.product.id}`} className="hover:underline">
                          <div className="text-md text-slate-900 dark:text-slate-100 truncate max-w-xs">{e.product.name}</div>
                          <div className="font-mono text-xs text-slate-500 dark:text-slate-400">{e.product.sku}</div>
                        </Link>
                      ) : (
                        <div className="font-mono text-xs text-slate-500 dark:text-slate-400">{e.sku}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{e.localQtyAtObservation}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">{e.channelReportedQty}</td>
                    <td className={`px-3 py-2 text-right tabular-nums font-semibold ${
                      driftLarge ? 'text-rose-700 dark:text-rose-300' : 'text-amber-700 dark:text-amber-300'
                    }`}>
                      {e.drift > 0 ? '+' : ''}{e.drift}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{relativeTime(e.createdAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {totalOpen > topRows.length && (
            <div className="px-5 py-2 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 text-center bg-slate-50 dark:bg-slate-800/50">
              {t('channelDrift.dashboard.topOfTotal', { shown: topRows.length, total: totalOpen })} ·{' '}
              <Link href="/fulfillment/stock/channel-drift" className="text-blue-600 dark:text-blue-400 hover:underline">
                {t('channelDrift.dashboard.seeAll')}
              </Link>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
