// ZZ — Command Center overview, multi-channel + multi-marketplace.
//
// Single-page operational dashboard backed by /api/dashboard/overview.
// Sections:
//   - Window selector (Today / 7d / 30d / 90d / YTD)
//   - 4 KPIs with vs-previous delta pills
//   - Sparkline (revenue + orders, 30 days, side-by-side)
//   - Channel performance grid (Amazon / eBay / Shopify / Woo / Etsy)
//     showing revenue, orders, AOV, listings (live / draft / failed)
//   - (Channel × Marketplace) matrix table
//   - Operational alerts (low stock, draft / failed listings,
//     pending orders, disconnected channels) with deep-links
//   - Top SKUs by revenue in window
//   - Recent activity feed (BulkOperation + AuditLog)
//   - Quick actions row (Add product, bulk edit, run wizard,
//     settings)
// Auto-refresh every 60s while the tab is visible.

'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  ChevronRight,
  ExternalLink,
  Loader2,
  Package,
  PackagePlus,
  RefreshCw,
  ShoppingCart,
  Sparkles,
  TableProperties,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface OverviewPayload {
  window: { from: string; to: string; label: string; key: string }
  // DO.1 — backend reports the primary currency (highest-revenue
  // currency in the window, EUR fallback) plus a per-currency
  // breakdown. The KPI strip renders headline numbers in `primary`
  // and surfaces a secondary line when more than one currency
  // contributed real revenue.
  currency: {
    primary: string
    breakdown: Array<{ code: string; current: number; previous: number }>
  }
  totals: {
    revenue: TotalEntry
    orders: TotalEntry
    aov: TotalEntry
    units: TotalEntry
  }
  byChannel: Array<{
    channel: string
    revenue: number
    orders: number
    units: number
    aov: number
    listings: { total: number; live: number; draft: number; failed: number }
  }>
  byMarketplace: Array<{
    channel: string
    marketplace: string
    listings: number
  }>
  topProducts: Array<{
    sku: string
    productId: string | null
    units: number
    revenue: number
  }>
  sparkline: Array<{ date: string; revenue: number; orders: number }>
  recentActivity: Array<{ type: string; ts: string; summary: string }>
  catalog: {
    totalProducts: number
    totalParents: number
    totalVariants: number
    liveListings: number
    draftListings: number
    failedListings: number
    lowStockCount: number
    outOfStockCount: number
  }
  alerts: {
    lowStock: number
    outOfStock: number
    failedListings: number
    draftListings: number
    pendingOrders: number
    ebayConnected: boolean
    channelConnections: Array<{
      channelType: string
      isActive: boolean
      lastSyncStatus: string | null
    }>
  }
}

interface TotalEntry {
  current: number
  previous: number
  deltaPct: number | null
}

const WINDOWS = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'ytd', label: 'YTD' },
] as const

type WindowKey = (typeof WINDOWS)[number]['id']

const CHANNEL_TONES: Record<string, { bg: string; text: string }> = {
  AMAZON: { bg: 'bg-orange-50 border-orange-200', text: 'text-orange-700' },
  EBAY: { bg: 'bg-blue-50 border-blue-200', text: 'text-blue-700' },
  SHOPIFY: { bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700' },
  WOOCOMMERCE: { bg: 'bg-violet-50 border-violet-200', text: 'text-violet-700' },
  ETSY: { bg: 'bg-rose-50 border-rose-200', text: 'text-rose-700' },
}

const CHANNEL_LABELS: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  ETSY: 'Etsy',
}

// DO.1 — currency formatting is now driven by the active currency
// code. Italian locale ('it-IT') is the default operator locale —
// gives "€936" instead of "$936" for the Xavia / Amazon-IT case and
// the right thousand/decimal separator regardless of currency.
//
// Cache one formatter per currency code to avoid the per-render
// Intl.NumberFormat allocation cost when the dashboard re-renders.
const PCT_FMT = new Intl.NumberFormat('it-IT', {
  style: 'percent',
  maximumFractionDigits: 1,
})
const NUM_FMT = new Intl.NumberFormat('it-IT')

const currencyFormatters = new Map<string, Intl.NumberFormat>()
function currencyFormatter(code: string): Intl.NumberFormat {
  const cached = currencyFormatters.get(code)
  if (cached) return cached
  const fresh = new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency: code,
    maximumFractionDigits: 0,
  })
  currencyFormatters.set(code, fresh)
  return fresh
}

function formatCurrency(n: number, code: string): string {
  return currencyFormatter(code).format(Math.round(n))
}

function formatDelta(pct: number | null): {
  label: string
  tone: 'pos' | 'neg' | 'flat' | 'na'
} {
  if (pct === null) return { label: 'n/a', tone: 'na' }
  if (Math.abs(pct) < 0.5) return { label: 'flat', tone: 'flat' }
  return {
    label: PCT_FMT.format(pct / 100),
    tone: pct > 0 ? 'pos' : 'neg',
  }
}

export default function OverviewClient() {
  const [window, setWindow] = useState<WindowKey>('30d')
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
        const res = await fetch(
          `${getBackendUrl()}/api/dashboard/overview?window=${window}`,
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
    [window],
  )

  useEffect(() => {
    void fetchPayload()
  }, [fetchPayload])

  // Auto-refresh every 60s while tab is visible.
  useEffect(() => {
    const t = globalThis.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void fetchPayload({ silent: true })
    }, 60_000)
    return () => globalThis.clearInterval(t)
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

  return (
    <div className="space-y-6">
      <Header
        currentWindow={window}
        onWindowChange={setWindow}
        lastRefreshed={lastRefreshed}
        refreshing={refreshing}
        onRefresh={() => void fetchPayload({ silent: true })}
      />

      {loading && !data && (
        <div className="border border-slate-200 rounded-lg bg-white px-6 py-12 text-center text-md text-slate-500 inline-flex items-center justify-center gap-2 w-full">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading overview…
        </div>
      )}

      {error && !loading && (
        <div className="border border-rose-200 rounded-lg bg-rose-50 px-4 py-3 text-md text-rose-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-semibold">Couldn't load overview</div>
            <div className="text-sm text-rose-600">{error}</div>
          </div>
        </div>
      )}

      {data && (
        <>
          <KpiGrid totals={data.totals} currency={data.currency} />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 space-y-4">
              <Sparkline
                points={data.sparkline}
                currency={data.currency.primary}
              />
              <ChannelGrid
                byChannel={data.byChannel}
                currency={data.currency.primary}
              />
              <MarketplaceMatrix matrix={data.byMarketplace} />
              <TopProducts
                items={data.topProducts}
                currency={data.currency.primary}
              />
            </div>
            <div className="space-y-4">
              <AlertsPanel alerts={data.alerts} catalog={data.catalog} />
              <CatalogSnapshot catalog={data.catalog} />
              <ActivityFeed items={data.recentActivity} />
              <QuickActions />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── Header ───────────────────────────────────────────────────────────

function Header({
  currentWindow,
  onWindowChange,
  lastRefreshed,
  refreshing,
  onRefresh,
}: {
  currentWindow: WindowKey
  onWindowChange: (w: WindowKey) => void
  lastRefreshed: number
  refreshing: boolean
  onRefresh: () => void
}) {
  return (
    <div className="flex items-end justify-between gap-3 flex-wrap">
      <div>
        <h1 className="text-[24px] font-semibold text-slate-900">
          Command Center
        </h1>
        <p className="text-md text-slate-600 mt-0.5">
          Real-time operations across every channel and marketplace.
        </p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <div className="inline-flex items-center border border-slate-200 rounded-md p-0.5 bg-white">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => onWindowChange(w.id)}
              className={cn(
                'h-6 px-2.5 text-sm rounded transition-colors',
                w.id === currentWindow
                  ? 'bg-slate-900 text-white font-semibold'
                  : 'text-slate-600 hover:text-slate-900',
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 text-sm font-medium text-slate-700 border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          Refresh
        </button>
        <RelativeTimestamp at={lastRefreshed} />
      </div>
    </div>
  )
}

// ── KPI grid ─────────────────────────────────────────────────────────

function KpiGrid({
  totals,
  currency,
}: {
  totals: OverviewPayload['totals']
  currency: OverviewPayload['currency']
}) {
  // DO.1 — render the headline KPI in the primary currency. If
  // multiple currencies contributed real revenue (>0.5 / 1 / 1
  // depending on smallest unit), show a "+ $X USD · £Y GBP"
  // secondary line so the operator sees the breakdown without
  // losing the headline glanceability.
  const primary = currency.primary
  const secondaries = currency.breakdown.filter(
    (b) => b.code !== primary && b.current >= 1,
  )
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Revenue"
          value={formatCurrency(totals.revenue.current, primary)}
          delta={formatDelta(totals.revenue.deltaPct)}
          prevValue={formatCurrency(totals.revenue.previous, primary)}
        />
        <KpiCard
          label="Orders"
          value={NUM_FMT.format(totals.orders.current)}
          delta={formatDelta(totals.orders.deltaPct)}
          prevValue={NUM_FMT.format(totals.orders.previous)}
        />
        <KpiCard
          label="AOV"
          value={formatCurrency(totals.aov.current, primary)}
          delta={formatDelta(totals.aov.deltaPct)}
          prevValue={formatCurrency(totals.aov.previous, primary)}
        />
        <KpiCard
          label="Units sold"
          value={NUM_FMT.format(totals.units.current)}
          delta={formatDelta(totals.units.deltaPct)}
          prevValue={NUM_FMT.format(totals.units.previous)}
        />
      </div>
      {secondaries.length > 0 && (
        <div className="text-xs text-slate-500 pl-1">
          incl.{' '}
          {secondaries.map((s, i) => (
            <span key={s.code}>
              {i > 0 && ' · '}
              <span className="tabular-nums">
                {formatCurrency(s.current, s.code)}
              </span>{' '}
              {s.code}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function KpiCard({
  label,
  value,
  delta,
  prevValue,
}: {
  label: string
  value: string
  delta: { label: string; tone: 'pos' | 'neg' | 'flat' | 'na' }
  prevValue: string
}) {
  return (
    <div className="border border-slate-200 rounded-lg bg-white px-4 py-3">
      <div className="text-sm text-slate-500 uppercase tracking-wide font-medium">
        {label}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2 flex-wrap">
        <div className="text-[22px] font-semibold text-slate-900 tabular-nums">
          {value}
        </div>
        <DeltaPill delta={delta} />
      </div>
      <div className="mt-1 text-xs text-slate-400">
        prev: <span className="tabular-nums">{prevValue}</span>
      </div>
    </div>
  )
}

function DeltaPill({
  delta,
}: {
  delta: { label: string; tone: 'pos' | 'neg' | 'flat' | 'na' }
}) {
  const tone =
    delta.tone === 'pos'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : delta.tone === 'neg'
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : 'bg-slate-50 text-slate-500 border-slate-200'
  const Icon =
    delta.tone === 'pos'
      ? ArrowUpRight
      : delta.tone === 'neg'
      ? ArrowDownRight
      : null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-xs font-medium tabular-nums',
        tone,
      )}
    >
      {Icon && <Icon className="w-3 h-3" />}
      {delta.label}
    </span>
  )
}

// ── Sparkline ────────────────────────────────────────────────────────

function Sparkline({
  points,
  currency,
}: {
  points: OverviewPayload['sparkline']
  currency: string
}) {
  const totalRev = points.reduce((s, p) => s + p.revenue, 0)
  const totalOrders = points.reduce((s, p) => s + p.orders, 0)
  return (
    <div className="border border-slate-200 rounded-lg bg-white px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-md font-semibold text-slate-900">
          30-day trend
        </h2>
        <div className="text-sm text-slate-500 tabular-nums">
          {formatCurrency(totalRev, currency)} ·{' '}
          {NUM_FMT.format(totalOrders)} orders
        </div>
      </div>
      <SvgLineChart points={points} />
    </div>
  )
}

function SvgLineChart({ points }: { points: OverviewPayload['sparkline'] }) {
  const w = 600
  const h = 100
  const pad = 4
  const maxRev = Math.max(1, ...points.map((p) => p.revenue))
  const maxOrd = Math.max(1, ...points.map((p) => p.orders))
  const xStep = (w - pad * 2) / Math.max(1, points.length - 1)
  const yScaleRev = (v: number) =>
    h - pad - ((h - pad * 2) * v) / maxRev
  const yScaleOrd = (v: number) =>
    h - pad - ((h - pad * 2) * v) / maxOrd
  const revPath = points
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'} ${pad + i * xStep},${yScaleRev(p.revenue)}`,
    )
    .join(' ')
  const ordPath = points
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'} ${pad + i * xStep},${yScaleOrd(p.orders)}`,
    )
    .join(' ')
  return (
    <div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-[100px]"
        role="img"
        aria-label="30-day revenue and orders trend"
      >
        <path
          d={revPath}
          fill="none"
          stroke="rgb(16 185 129)"
          strokeWidth="1.5"
        />
        <path
          d={ordPath}
          fill="none"
          stroke="rgb(59 130 246)"
          strokeWidth="1.5"
          strokeDasharray="2 2"
          opacity="0.6"
        />
      </svg>
      <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2 h-0.5 bg-emerald-500" />
          Revenue
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block w-2 h-0.5 bg-blue-500 opacity-60" />
          Orders
        </span>
      </div>
    </div>
  )
}

// ── Channel grid ─────────────────────────────────────────────────────

function ChannelGrid({
  byChannel,
  currency,
}: {
  byChannel: OverviewPayload['byChannel']
  currency: string
}) {
  const visible = byChannel.filter(
    (c) => c.orders > 0 || c.listings.total > 0,
  )
  if (visible.length === 0) {
    return (
      <div className="border border-slate-200 rounded-lg bg-white px-4 py-3">
        <h2 className="text-md font-semibold text-slate-900 mb-2">
          Channels
        </h2>
        <div className="text-base text-slate-500 italic">
          No channel activity in this window.
        </div>
      </div>
    )
  }
  return (
    <div>
      <h2 className="text-md font-semibold text-slate-900 mb-2">
        Channels
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {visible.map((c) => {
          const tone = CHANNEL_TONES[c.channel] ?? {
            bg: 'bg-slate-50 border-slate-200',
            text: 'text-slate-700',
          }
          return (
            <div
              key={c.channel}
              className={cn(
                'border rounded-lg px-3 py-2.5',
                tone.bg,
              )}
            >
              <div className="flex items-center justify-between">
                <span className={cn('text-base font-semibold', tone.text)}>
                  {CHANNEL_LABELS[c.channel] ?? c.channel}
                </span>
                <span className="text-xs text-slate-500 tabular-nums">
                  {NUM_FMT.format(c.listings.total)} listing
                  {c.listings.total === 1 ? '' : 's'}
                </span>
              </div>
              <div className="mt-1 flex items-baseline gap-3 flex-wrap">
                <div className="text-2xl font-semibold text-slate-900 tabular-nums">
                  {formatCurrency(c.revenue, currency)}
                </div>
                <div className="text-sm text-slate-600 tabular-nums">
                  {NUM_FMT.format(c.orders)} order
                  {c.orders === 1 ? '' : 's'} · AOV{' '}
                  {formatCurrency(c.aov, currency)}
                </div>
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-xs">
                <Pill tone="emerald">{c.listings.live} live</Pill>
                <Pill tone="amber">{c.listings.draft} draft</Pill>
                {c.listings.failed > 0 && (
                  <Pill tone="rose">{c.listings.failed} failed</Pill>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Marketplace matrix ───────────────────────────────────────────────

function MarketplaceMatrix({
  matrix,
}: {
  matrix: OverviewPayload['byMarketplace']
}) {
  const channels = Array.from(new Set(matrix.map((m) => m.channel))).sort()
  const marketplaces = Array.from(
    new Set(matrix.map((m) => m.marketplace)),
  ).sort()
  const lookup = new Map<string, number>()
  for (const m of matrix) lookup.set(`${m.channel}:${m.marketplace}`, m.listings)
  if (channels.length === 0) return null
  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
        <h2 className="text-md font-semibold text-slate-900">
          Listings by channel × marketplace
        </h2>
        <Link
          href="/bulk-operations"
          className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
        >
          Open <ChevronRight className="w-3 h-3" />
        </Link>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-base">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-3 py-2 text-left text-xs uppercase tracking-wide text-slate-500 font-semibold">
                Channel
              </th>
              {marketplaces.map((m) => (
                <th
                  key={m}
                  className="px-3 py-2 text-right text-xs uppercase tracking-wide text-slate-500 font-semibold font-mono"
                >
                  {m}
                </th>
              ))}
              <th className="px-3 py-2 text-right text-xs uppercase tracking-wide text-slate-500 font-semibold">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {channels.map((c) => {
              const total = marketplaces.reduce(
                (s, m) => s + (lookup.get(`${c}:${m}`) ?? 0),
                0,
              )
              return (
                <tr
                  key={c}
                  className="border-t border-slate-100 hover:bg-slate-50/40"
                >
                  <td className="px-3 py-1.5 font-medium text-slate-900">
                    {CHANNEL_LABELS[c] ?? c}
                  </td>
                  {marketplaces.map((m) => {
                    const v = lookup.get(`${c}:${m}`) ?? 0
                    return (
                      <td
                        key={m}
                        className={cn(
                          'px-3 py-1.5 text-right tabular-nums',
                          v === 0 ? 'text-slate-300' : 'text-slate-700',
                        )}
                      >
                        {v > 0 ? (
                          <Link
                            href={`/listings/${c.toLowerCase()}?marketplace=${m}`}
                            className="hover:text-blue-600 hover:underline"
                          >{v}</Link>
                        ) : v}
                      </td>
                    )
                  })}
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-900">
                    {total}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Top products ─────────────────────────────────────────────────────

function TopProducts({
  items,
  currency,
}: {
  items: OverviewPayload['topProducts']
  currency: string
}) {
  if (items.length === 0) return null
  const max = Math.max(1, ...items.map((i) => i.revenue))
  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <div className="px-4 py-3 border-b border-slate-100">
        <h2 className="text-md font-semibold text-slate-900">
          Top SKUs by revenue
        </h2>
      </div>
      <ul>
        {items.map((it) => {
          const pct = (it.revenue / max) * 100
          return (
            <li
              key={it.sku}
              className="px-4 py-2 border-b border-slate-100 last:border-b-0"
            >
              <div className="flex items-center justify-between gap-3">
                {it.productId ? (
                  <Link
                    href={`/products/${it.productId}/edit`}
                    className="font-mono text-base text-blue-600 hover:underline truncate"
                  >
                    {it.sku}
                  </Link>
                ) : (
                  <span className="font-mono text-base text-slate-700 truncate">
                    {it.sku}
                  </span>
                )}
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-sm text-slate-500 tabular-nums">
                    {NUM_FMT.format(it.units)} units
                  </span>
                  <span className="text-base font-semibold text-slate-900 tabular-nums">
                    {formatCurrency(it.revenue, currency)}
                  </span>
                </div>
              </div>
              <div className="mt-1 h-1 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full bg-emerald-400"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ── Alerts ───────────────────────────────────────────────────────────

function AlertsPanel({
  alerts,
  catalog,
}: {
  alerts: OverviewPayload['alerts']
  catalog: OverviewPayload['catalog']
}) {
  const items: Array<{
    label: string
    count: number
    href: string
    tone: 'rose' | 'amber' | 'slate'
  }> = []
  if (alerts.outOfStock > 0)
    items.push({
      label: 'Out of stock',
      count: alerts.outOfStock,
      href: '/products?stock=out',
      tone: 'rose',
    })
  if (alerts.lowStock > 0)
    items.push({
      label: 'Low stock (≤10)',
      count: alerts.lowStock,
      href: '/products?stock=low',
      tone: 'amber',
    })
  if (alerts.failedListings > 0)
    items.push({
      label: 'Failed listings',
      count: alerts.failedListings,
      // C.4 — link to the master /listings filtered by status, not a
      // hardcoded /listings/amazon. Failures can be on any channel and
      // the master view shows them all with channel/marketplace chips
      // ready to drill down further.
      href: '/listings?listingStatus=ERROR',
      tone: 'rose',
    })
  if (alerts.draftListings > 0)
    items.push({
      label: 'Draft listings',
      count: alerts.draftListings,
      href: '/listings?listingStatus=DRAFT',
      tone: 'amber',
    })
  if (alerts.pendingOrders > 0)
    items.push({
      label: 'Pending orders',
      count: alerts.pendingOrders,
      href: '/orders',
      tone: 'amber',
    })
  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
        <h2 className="text-md font-semibold text-slate-900">Alerts</h2>
        <span className="text-xs text-slate-500">
          {items.length === 0 ? 'all clear' : `${items.length} active`}
        </span>
      </div>
      <div className="px-4 py-3 space-y-2">
        {items.length === 0 && (
          <div className="text-sm text-slate-500 italic">
            Nothing requires attention right now.
          </div>
        )}
        {items.map((it) => (
          <Link
            key={it.label}
            href={it.href}
            className={cn(
              'flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-md border text-base hover:bg-slate-50',
              it.tone === 'rose'
                ? 'border-rose-200 bg-rose-50/40'
                : it.tone === 'amber'
                ? 'border-amber-200 bg-amber-50/40'
                : 'border-slate-200',
            )}
          >
            <span className="text-slate-800">{it.label}</span>
            <span className="font-semibold tabular-nums text-slate-900">
              {NUM_FMT.format(it.count)}
            </span>
          </Link>
        ))}

        {/* Channel connectivity */}
        {alerts.channelConnections.length > 0 && (
          <div className="border-t border-slate-100 pt-2 mt-2">
            <div className="text-xs uppercase tracking-wide text-slate-500 font-semibold mb-1">
              Channel connections
            </div>
            <ul className="space-y-1">
              {alerts.channelConnections.map((c, idx) => (
                <li
                  key={idx}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-slate-700">
                    {CHANNEL_LABELS[c.channelType] ?? c.channelType}
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-xs',
                      c.isActive
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : 'border-slate-200 text-slate-500',
                    )}
                  >
                    {c.isActive ? (
                      <Wifi className="w-2.5 h-2.5" />
                    ) : (
                      <WifiOff className="w-2.5 h-2.5" />
                    )}
                    {c.isActive ? 'connected' : 'disconnected'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* Catalog touchpoints */}
        <div className="border-t border-slate-100 pt-2 mt-2 grid grid-cols-2 gap-2 text-sm text-slate-700">
          <div>
            <div className="text-slate-500 text-xs">Live listings</div>
            <div className="font-semibold tabular-nums">
              {NUM_FMT.format(catalog.liveListings)}
            </div>
          </div>
          <div>
            <div className="text-slate-500 text-xs">Variants</div>
            <div className="font-semibold tabular-nums">
              {NUM_FMT.format(catalog.totalVariants)}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Catalog snapshot ────────────────────────────────────────────────

function CatalogSnapshot({
  catalog,
}: {
  catalog: OverviewPayload['catalog']
}) {
  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <div className="px-4 py-3 border-b border-slate-100">
        <h2 className="text-md font-semibold text-slate-900">
          Catalog snapshot
        </h2>
      </div>
      <div className="px-4 py-3 grid grid-cols-2 gap-3 text-base">
        <SnapshotCell
          label="Products"
          value={NUM_FMT.format(catalog.totalProducts)}
        />
        <SnapshotCell
          label="Parents"
          value={NUM_FMT.format(catalog.totalParents)}
        />
        <SnapshotCell
          label="Variants"
          value={NUM_FMT.format(catalog.totalVariants)}
        />
        <SnapshotCell
          label="Live listings"
          value={NUM_FMT.format(catalog.liveListings)}
        />
        <SnapshotCell
          label="Draft listings"
          value={NUM_FMT.format(catalog.draftListings)}
        />
        <SnapshotCell
          label="Failed listings"
          value={NUM_FMT.format(catalog.failedListings)}
          tone={catalog.failedListings > 0 ? 'rose' : 'slate'}
        />
      </div>
    </div>
  )
}

function SnapshotCell({
  label,
  value,
  tone = 'slate',
}: {
  label: string
  value: string
  tone?: 'slate' | 'rose' | 'amber'
}) {
  const valueClass =
    tone === 'rose'
      ? 'text-rose-700'
      : tone === 'amber'
      ? 'text-amber-700'
      : 'text-slate-900'
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500 font-medium">
        {label}
      </div>
      <div className={cn('mt-0.5 text-xl font-semibold tabular-nums', valueClass)}>
        {value}
      </div>
    </div>
  )
}

// ── Activity feed ────────────────────────────────────────────────────

function ActivityFeed({
  items,
}: {
  items: OverviewPayload['recentActivity']
}) {
  if (items.length === 0) return null
  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <div className="px-4 py-3 border-b border-slate-100">
        <h2 className="text-md font-semibold text-slate-900">
          Recent activity
        </h2>
      </div>
      <ul className="max-h-[260px] overflow-y-auto">
        {items.map((a, idx) => (
          <li
            key={idx}
            className="px-4 py-2 border-b border-slate-100 last:border-b-0 flex items-start justify-between gap-3"
          >
            <div className="text-sm text-slate-700 break-words flex-1">
              {a.summary}
            </div>
            <RelativeTimestamp at={Date.parse(a.ts)} compact />
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Quick actions ────────────────────────────────────────────────────

function QuickActions() {
  const actions = [
    { label: 'Add product', href: '/products/new', icon: PackagePlus },
    { label: 'Bulk operations', href: '/bulk-operations', icon: TableProperties },
    { label: 'Generate AI content', href: '/products', icon: Sparkles },
    { label: 'Channel settings', href: '/settings/channels', icon: Wifi },
  ]
  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <div className="px-4 py-3 border-b border-slate-100">
        <h2 className="text-md font-semibold text-slate-900">
          Quick actions
        </h2>
      </div>
      <div className="px-2 py-2">
        {actions.map((a) => {
          const Icon = a.icon
          return (
            <Link
              key={a.label}
              href={a.href}
              className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50 text-base text-slate-700"
            >
              <Icon className="w-3.5 h-3.5 text-slate-500" />
              <span className="flex-1">{a.label}</span>
              <ExternalLink className="w-3 h-3 text-slate-300" />
            </Link>
          )
        })}
      </div>
    </div>
  )
}

// ── Tiny helpers ─────────────────────────────────────────────────────

function Pill({
  tone,
  children,
}: {
  tone: 'emerald' | 'amber' | 'rose'
  children: React.ReactNode
}) {
  const cls =
    tone === 'emerald'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : tone === 'amber'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-rose-50 text-rose-700 border-rose-200'
  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded border text-xs tabular-nums',
        cls,
      )}
    >
      {children}
    </span>
  )
}

function RelativeTimestamp({
  at,
  compact = false,
}: {
  at: number
  compact?: boolean
}) {
  const [, force] = useState(0)
  useEffect(() => {
    const t = globalThis.setInterval(() => force((n) => n + 1), 5_000)
    return () => globalThis.clearInterval(t)
  }, [])
  if (!Number.isFinite(at)) return null
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000))
  const label =
    seconds < 5
      ? 'just now'
      : seconds < 60
      ? `${seconds}s ago`
      : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : `${Math.floor(seconds / 3600)}h ago`
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs tabular-nums whitespace-nowrap',
        seconds < 30
          ? 'text-emerald-600'
          : seconds < 120
          ? 'text-slate-500'
          : 'text-amber-600',
      )}
      title={`${new Date(at).toLocaleString()}`}
    >
      {!compact && (
        <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70" />
      )}
      {label}
    </span>
  )
}

// Suppress unused-warning for an icon imported above for symmetry.
void Boxes
void ShoppingCart
void Package
