// ZZ — Command Center overview, multi-channel + multi-marketplace.
//
// Orchestrator for /dashboard/overview. Owns data fetching, polling,
// tab-focus refresh, and section layout. Each section lives in its
// own file under _components/ — see them for KPI strip, sparkline,
// channel grid, marketplace matrix, top SKUs, alerts, catalog
// snapshot, activity feed, and quick actions. Shared types and
// formatting live in _lib/.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import Header from './_components/Header'
import KpiGrid from './_components/KpiGrid'
import Sparkline from './_components/Sparkline'
import ChannelTrendChart from './_components/ChannelTrendChart'
import ChannelGrid from './_components/ChannelGrid'
import MarketplaceMatrix from './_components/MarketplaceMatrix'
import TopProducts from './_components/TopProducts'
import AlertsPanel from './_components/AlertsPanel'
import CatalogSnapshot from './_components/CatalogSnapshot'
import ActivityFeed from './_components/ActivityFeed'
import QuickActions from './_components/QuickActions'
import type {
  CompareKey,
  CustomRange,
  OverviewPayload,
  WindowKey,
} from './_lib/types'

// DO.25 — initial custom range = last 14 days. Operator can adjust
// once they pick "Custom" from the window selector.
function defaultCustomRange(): CustomRange {
  const now = new Date()
  const start = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000)
  return {
    from: start.toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
  }
}

export default function OverviewClient() {
  const { t } = useTranslations()
  const [window, setWindow] = useState<WindowKey>('30d')
  const [compare, setCompare] = useState<CompareKey>('prev')
  const [customRange, setCustomRange] = useState<CustomRange>(
    defaultCustomRange,
  )
  // DO.16 — Live mode. When on, a second EventSource subscribes to
  // /api/dashboard/events and triggers a silent refetch on every
  // event (debounced 2s). When off, only the 60s polling and tab-
  // focus refresh apply. Default on — Command Center is the
  // operator's daily landing page; stale numbers there are worse
  // than a few extra fetches.
  const [liveMode, setLiveMode] = useState(true)
  const [data, setData] = useState<OverviewPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<number>(() => Date.now())

  const fetchPayload = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (opts.silent) setRefreshing(true)
      else setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({
          window,
          compare,
        })
        if (window === 'custom' && customRange.from && customRange.to) {
          params.set('from', customRange.from)
          params.set('to', customRange.to)
        }
        const res = await fetch(
          `${getBackendUrl()}/api/dashboard/overview?${params.toString()}`,
          { cache: 'no-store' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as OverviewPayload
        setData(json)
        setLastRefreshed(Date.now())
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [window, compare, customRange.from, customRange.to],
  )

  useEffect(() => {
    void fetchPayload()
  }, [fetchPayload])

  // Auto-refresh every 60s while tab is visible.
  useEffect(() => {
    const id = globalThis.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void fetchPayload({ silent: true })
    }, 60_000)
    return () => globalThis.clearInterval(id)
  }, [fetchPayload])

  // Refresh on tab focus.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible')
        void fetchPayload({ silent: true })
    }
    document.addEventListener('visibilitychange', onVis)
    globalThis.addEventListener('focus', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      globalThis.removeEventListener('focus', onVis)
    }
  }, [fetchPayload])

  // DO.16 — live-mode SSE: subscribe to /api/dashboard/events and
  // trigger a silent refetch on each event. Debounced 2s so a burst
  // (e.g., 20 listing.synced from one bulk publish) collapses into
  // a single refresh. ActivityFeed runs its own EventSource for the
  // event-stream UI; this one is a lightweight subscriber that
  // doesn't render anything — it just exists to keep the KPI strip
  // and channel grid honest with reality.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!liveMode) return
    if (typeof window === 'undefined' || typeof EventSource === 'undefined')
      return
    const url = `${getBackendUrl()}/api/dashboard/events`
    const source = new EventSource(url, { withCredentials: false })
    const onEvent = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        if (document.visibilityState === 'visible') {
          void fetchPayload({ silent: true })
        }
      }, 2_000)
    }
    // Listen on every named event the dashboard bus emits. Skip
    // 'ping' — that's keepalive only, not a real change signal.
    const names = [
      'order.created',
      'order.updated',
      'order.cancelled',
      'order.shipped',
      'return.created',
      'shipment.created',
      'shipment.updated',
      'shipment.deleted',
      'tracking.event',
      'listing.created',
      'listing.updated',
      'listing.deleted',
      'listing.synced',
      'wizard.submitted',
      'inbound.created',
      'inbound.updated',
      'inbound.received',
      'inbound.discrepancy',
      'inbound.cancelled',
    ]
    for (const n of names) source.addEventListener(n, onEvent)
    return () => {
      source.close()
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
    }
  }, [liveMode, fetchPayload])

  return (
    // PageHeader has its own `mb-5`. Keep the section-stack at
    // `space-y-6` but pull it into a sibling div so the header's
    // bottom margin doesn't compound with the stack gap above the
    // first section.
    <div>
      <Header
        t={t}
        currentWindow={window}
        onWindowChange={setWindow}
        currentCompare={compare}
        onCompareChange={setCompare}
        customRange={customRange}
        onCustomRangeChange={setCustomRange}
        liveMode={liveMode}
        onLiveModeChange={setLiveMode}
        lastRefreshed={lastRefreshed}
        refreshing={refreshing}
        onRefresh={() => void fetchPayload({ silent: true })}
      />

      <div className="space-y-6">
        {loading && !data && (
          <div className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 px-6 py-12 text-center text-md text-slate-500 dark:text-slate-400 inline-flex items-center justify-center gap-2 w-full">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('overview.loading')}
          </div>
        )}

        {error && !loading && (
          <div className="border border-rose-200 dark:border-rose-900 rounded-lg bg-rose-50 dark:bg-rose-950/30 px-4 py-3 text-md text-rose-700 dark:text-rose-400 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-semibold">{t('overview.error.title')}</div>
              <div className="text-sm text-rose-600 dark:text-rose-500">
                {error}
              </div>
            </div>
          </div>
        )}

        {data && (
          <>
            <KpiGrid t={t} totals={data.totals} currency={data.currency} />
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 space-y-4">
                <Sparkline
                  t={t}
                  points={data.sparkline}
                  currency={data.currency.primary}
                  windowKey={data.window.key as WindowKey}
                />
                <ChannelTrendChart
                  t={t}
                  points={data.sparkline}
                  channels={data.sparklineChannels}
                  currency={data.currency.primary}
                  windowKey={data.window.key as WindowKey}
                />
                <ChannelGrid
                  t={t}
                  byChannel={data.byChannel}
                  currency={data.currency.primary}
                />
                <MarketplaceMatrix
                  t={t}
                  matrix={data.byMarketplace}
                  currency={data.currency.primary}
                />
                <TopProducts
                  t={t}
                  items={data.topProducts}
                  currency={data.currency.primary}
                />
              </div>
              <div className="space-y-4">
                <AlertsPanel
                  t={t}
                  alerts={data.alerts}
                  catalog={data.catalog}
                />
                <CatalogSnapshot t={t} catalog={data.catalog} />
                <ActivityFeed t={t} items={data.recentActivity} />
                <QuickActions t={t} alerts={data.alerts} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
