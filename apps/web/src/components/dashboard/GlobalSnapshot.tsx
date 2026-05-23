'use client'

/**
 * GS.2 — collapsed Global Snapshot strip. Mirrors Amazon Seller
 * Central's home-page widget: Sales · Open Orders · Buyer Messages
 * with a chevron on each tile that opens a detail panel.
 *
 * Designed to mount on multiple surfaces (top of /orders + the
 * standalone /dashboard route) with no per-surface knobs. One data
 * fetch, three tiles, click-to-expand.
 *
 * Expand panels (Sales / Open Orders detail tables) land in GS.3+GS.4.
 * For GS.2, expanding shows a placeholder so the interaction is wired
 * but the heavy table layout doesn't block this commit.
 */

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, ShoppingCart, Package, Mail, RefreshCw, X } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { AnchoredPopover } from '@/app/_shared/grid-lens/AnchoredPopover'
import { Skeleton } from '@/components/ui/Skeleton'
import { getBackendUrl } from '@/lib/backend-url'

type SalesRow = {
  marketplace: string
  region: string
  currency: string
  valueCents: number
  units: number
  orderCount: number
  // GS-RT.1 — per-marketplace pending estimate. Populated when the
  // marketplace has at least one PENDING+€0 order with a price that
  // ChannelListing / Product.basePrice can supply. The table cell
  // renders `€X * (incl. estimated)` so the row total matches the
  // tile headline — fixes the FR-row-shows-€0-but-tile-shows-€651.99
  // split-brain that GS-RT.1 was built to close.
  pendingEstimateCents?: number
  pendingCount?: number
}

type OpenOrdersRow = {
  marketplace: string
  region: string
  fbmUnshipped: number
  fbmPending: number
  fbaPending: number
}

type Snapshot = {
  period: { key: string; from: string; to: string; timezone: string }
  // SA.3 — current marketplace scope + available marketplaces for dropdown
  marketplace: string | null
  availableMarketplaces: string[]
  sales: {
    total: {
      valueCents: number
      currency: string
      units: number
      // GS.7 — same-day-last-week comparison fields
      comparePrevValueCents?: number | null
      compareDeltaPct?: number | null
      compareLabel?: string | null
      // SA.1 — Amazon-withheld PENDING orders in the window
      pending?: {
        count: number
        oldestAt: string | null
        // SR.1 — estimated value from ChannelListing.price
        estimateCents?: number
      }
      // MS.3 — orders ingested in currencies other than EUR
      additionalCurrencies?: Array<{
        currency: string
        valueCents: number
        units: number
        orderCount: number
      }>
    }
    sparkline: Array<{ date: string; valueCents: number }>
    byMarketplace: SalesRow[]
  }
  openOrders: {
    total: number
    fbmUnshipped: number
    fbmPending: number
    fbaPending: number
    byMarketplace: OpenOrdersRow[]
  }
  lastUpdatedAt: string
}

type TileKey = 'sales' | 'openOrders' | 'messages'

// MS.3 — render any currency in its native unit. Used for non-EUR
// chips beside the EUR headline (UK GBP, SE SEK, PL PLN, TR TRY).
const CURRENCY_SYMBOL: Record<string, string> = {
  EUR: '€', GBP: '£', USD: '$', SEK: 'kr', PLN: 'zł', TRY: '₺', CHF: 'CHF', JPY: '¥',
}
function formatCurrencyCents(cents: number, currency: string): string {
  const sym = CURRENCY_SYMBOL[currency] ?? ''
  const amount = (cents / 100).toFixed(2)
  return sym ? `${sym}${amount}` : `${amount} ${currency}`
}

function formatEur(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`
}

function freshness(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  return `${h}h ago`
}

// GS.7 — persist the last-expanded tile across reloads so the
// operator's preferred default panel sticks.
const EXPANDED_STORAGE_KEY = 'nexus.snapshot.expanded.v1'

const MARKETPLACE_STORAGE_KEY = 'nexus.snapshot.marketplace.v1'
const PERIOD_STORAGE_KEY = 'nexus.snapshot.period.v1'

const VALID_PERIODS = ['today', 'yesterday', '7d', '30d', '90d'] as const
type SnapshotPeriod = (typeof VALID_PERIODS)[number]

const PERIOD_LABELS_TILE: Record<SnapshotPeriod, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
}

/**
 * SR.2 — derive default period from the parent page's filter when
 * possible. On /orders, the toolbar's DateRangePicker writes
 * ?dateRange=24h|7d|30d|90d. We pick that up so the snapshot stays
 * in sync without operator effort. Custom date ranges (explicit
 * dateFrom/dateTo) fall back to Today since the tile doesn't have a
 * custom-date UI.
 */
function readInheritedPeriod(): SnapshotPeriod | null {
  if (typeof window === 'undefined') return null
  try {
    const url = new URL(window.location.href)
    const dr = url.searchParams.get('dateRange')
    if (dr === '24h' || dr === 'today') return 'today'
    if (dr === '7d') return '7d'
    if (dr === '30d') return '30d'
    if (dr === '90d') return '90d'
  } catch {}
  return null
}

export function GlobalSnapshot() {
  const [data, setData] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<TileKey | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY)
      return raw === 'sales' || raw === 'openOrders' || raw === 'messages' ? raw : null
    } catch {
      return null
    }
  })
  // SR.2 — tile-level period. Order of precedence on first render:
  //   1. Page URL (?dateRange= written by /orders DateRangePicker)
  //   2. localStorage saved selection
  //   3. 'today' default
  const [period, setPeriodState] = useState<SnapshotPeriod>(() => {
    if (typeof window === 'undefined') return 'today'
    const inherited = readInheritedPeriod()
    if (inherited) return inherited
    try {
      const raw = window.localStorage.getItem(PERIOD_STORAGE_KEY)
      if (raw && (VALID_PERIODS as readonly string[]).includes(raw)) return raw as SnapshotPeriod
    } catch {}
    return 'today'
  })
  const setPeriod = (next: SnapshotPeriod) => {
    setPeriodState(next)
    try { window.localStorage.setItem(PERIOD_STORAGE_KEY, next) } catch {}
  }

  // SA.3 — marketplace scope. Persists in localStorage so the
  // selection survives navigation between /orders top + /dashboard top.
  const [marketplace, setMarketplaceState] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      return window.localStorage.getItem(MARKETPLACE_STORAGE_KEY) || null
    } catch {
      return null
    }
  })
  const setMarketplace = (next: string | null) => {
    setMarketplaceState(next)
    try {
      if (next) window.localStorage.setItem(MARKETPLACE_STORAGE_KEY, next)
      else window.localStorage.removeItem(MARKETPLACE_STORAGE_KEY)
    } catch {}
  }
  const [tick, setTick] = useState(0)

  const fetchSnapshot = async () => {
    try {
      const qs = new URLSearchParams({ period })
      if (marketplace) qs.set('marketplace', marketplace)
      const res = await fetch(`${getBackendUrl()}/api/dashboard/global-snapshot?${qs.toString()}`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      setData(await res.json())
      setError(null)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchSnapshot() }, [marketplace, period])

  // Re-tick the "Xs ago" label every 5s without re-fetching.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [])

  // AR.2 — keep fetchSnapshot fresh inside the SSE handler. The
  // useEffect for SSE has empty deps (we only want one EventSource
  // per mount), but the handler must always call the latest
  // fetchSnapshot — otherwise it captures a stale closure over the
  // initial `marketplace` and silently re-fetches with the wrong
  // scope after the operator changes the dropdown.
  const fetchSnapshotRef = useRef(fetchSnapshot)
  useEffect(() => { fetchSnapshotRef.current = fetchSnapshot })
  // AR.4 — keep current marketplace + data accessible to the SSE
  // handler so optimistic increments can decide whether the new
  // order falls inside the current scope.
  const marketplaceRef = useRef(marketplace)
  useEffect(() => { marketplaceRef.current = marketplace }, [marketplace])

  // GS.7 — SSE auto-refresh on order events. The /orders SSE bus
  // already broadcasts order.created/updated/cancelled — piggyback so
  // the snapshot's "Today so far" tile moves the instant a new order
  // lands without operator-triggered refresh.
  useEffect(() => {
    if (typeof window === 'undefined') return
    let es: EventSource | null = null
    try {
      es = new EventSource(`${getBackendUrl()}/api/orders/events`)
      // AR.4 — optimistic update on order.created: bump tile total
      // immediately, then reconcile with the server fetch ~50-200ms
      // later. Only applies when the payload carries the price + the
      // marketplace matches the current scope (avoid showing a spike
      // when scope=IT and an order lands in DE).
      const createHandler = (ev: MessageEvent) => {
        try {
          const payload = JSON.parse(ev.data) as {
            type: string
            marketplace?: string | null
            totalPriceCents?: number
            currencyCode?: string | null
          }
          const currentMarket = marketplaceRef.current
          const matchesScope = !currentMarket || payload.marketplace === currentMarket
          if (
            matchesScope
            && payload.totalPriceCents
            && payload.totalPriceCents > 0
            && (payload.currencyCode === 'EUR' || !payload.currencyCode)
          ) {
            setData((prev) => {
              if (!prev) return prev
              return {
                ...prev,
                sales: {
                  ...prev.sales,
                  total: {
                    ...prev.sales.total,
                    valueCents: prev.sales.total.valueCents + payload.totalPriceCents!,
                    units: prev.sales.total.units + 1,
                  },
                },
              }
            })
          }
        } catch {
          /* malformed payload — fall through to fetch */
        }
        fetchSnapshotRef.current()
      }
      const refreshOnly = () => fetchSnapshotRef.current()
      es.addEventListener('order.created', createHandler)
      es.addEventListener('order.updated', refreshOnly)
      es.addEventListener('order.cancelled', refreshOnly)
    } catch {
      /* SSE unsupported — fall back to the 5s tick / manual refresh */
    }
    return () => { try { es?.close() } catch {} }
  }, [])

  const onToggle = (key: TileKey) =>
    setExpanded((cur) => {
      const next = cur === key ? null : key
      try { window.localStorage.setItem(EXPANDED_STORAGE_KEY, next ?? '') } catch {}
      return next
    })

  // PV-RT.1 — per-tile refs for AnchoredPopover. Each ref attaches to
  // the tile's <button> so the popover positions itself directly under
  // the clicked tile (matches Amazon Seller Central's pattern). The
  // popover renders via portal to document.body so it layers above
  // sticky headers / sidebars / any ancestor stacking context.
  const salesTileRef = useRef<HTMLButtonElement>(null)
  const openOrdersTileRef = useRef<HTMLButtonElement>(null)
  const messagesTileRef = useRef<HTMLButtonElement>(null)

  if (loading && !data) {
    return (
      <Card title="Global snapshot">
        <Skeleton lines={3} />
      </Card>
    )
  }
  if (error && !data) {
    return (
      <Card title="Global snapshot">
        <div className="text-sm text-rose-600 dark:text-rose-400">Failed to load: {error}</div>
      </Card>
    )
  }
  if (!data) return null

  return (
    <Card
      title="Global snapshot"
      action={
        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 flex-wrap">
          {/* SR.2 — tile-level period dropdown */}
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as SnapshotPeriod)}
            className="h-7 px-2 text-xs border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
            title="Scope every tile to this period (Open Orders count stays right-now)"
          >
            {VALID_PERIODS.map((p) => (
              <option key={p} value={p}>{PERIOD_LABELS_TILE[p]}</option>
            ))}
          </select>
          {/* SA.3 — marketplace scope dropdown */}
          {data.availableMarketplaces.length > 1 && (
            <select
              value={data.marketplace ?? ''}
              onChange={(e) => setMarketplace(e.target.value || null)}
              className="h-7 px-2 text-xs border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
              title="Filter every tile by marketplace"
            >
              <option value="">All marketplaces</option>
              {data.availableMarketplaces.map((m) => (
                <option key={m} value={m}>
                  {MARKETPLACE_NAMES_GS[m as keyof typeof MARKETPLACE_NAMES_GS] ?? m} ({m})
                </option>
              ))}
            </select>
          )}
          <span title={new Date(data.lastUpdatedAt).toLocaleString()}>
            Updated {freshness(data.lastUpdatedAt)}
            <span aria-hidden="true">&nbsp;·&nbsp;{tick === 0 ? '' : ''}</span>
          </span>
          <button
            type="button"
            onClick={fetchSnapshot}
            className="h-7 w-7 inline-flex items-center justify-center border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
            aria-label="Refresh snapshot"
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      }
      noPadding
    >
      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-200 dark:divide-slate-700">
        <SnapshotTile
          icon={ShoppingCart}
          label="Sales"
          expanded={expanded === 'sales'}
          onToggle={() => onToggle('sales')}
          buttonRef={salesTileRef}
        >
          <div className="space-y-1">
            {/* SR.1 — combined headline matches Amazon Seller Central
                when there's pending value to estimate. Asterisk + sub-
                line explain the estimate. */}
            {(() => {
              const pending = data.sales.total.pending
              const estCents = pending?.estimateCents ?? 0
              const showCombined = pending && pending.count > 0 && estCents > 0
              const headlineCents = showCombined
                ? data.sales.total.valueCents + estCents
                : data.sales.total.valueCents
              return (
                <PulseOnChange value={headlineCents}>
                  <div className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100 inline-flex items-baseline gap-2">
                    {formatEur(headlineCents)}
                    {showCombined && (
                      <span
                        className="text-base text-amber-600 dark:text-amber-400"
                        title="Includes an estimate for pending orders Amazon hasn't priced yet — see annotation below."
                      >
                        *
                      </span>
                    )}
                    {data.sales.total.compareDeltaPct != null && (
                      <SalesDelta deltaPct={data.sales.total.compareDeltaPct} />
                    )}
                  </div>
                </PulseOnChange>
              )
            })()}
            <div
              className="text-xs text-slate-500 dark:text-slate-400"
              title="Gross sales (Amazon Seller Central 'Sales' semantic) — includes the original order amount even after cancellation or refund. Refunds appear as a separate financial line, not as negative sales."
            >
              {data.period.key === 'today' ? 'Today so far' : data.period.key}
              {' · '}
              <span>{data.sales.total.units} units</span>
              {data.sales.total.compareLabel && (
                <span className="ml-1 text-slate-400 dark:text-slate-500"> · {data.sales.total.compareLabel}</span>
              )}
            </div>
            {/* SA.1 + SR.1 + GS-RT.6 — surface the awaiting-price
                estimate breakdown. Broadened from "pending verification"
                to "awaiting price" because the scope now includes
                SHIPPED+€0 orders (long-tail Amazon-withheld OrderTotal),
                not just PENDING. The GS-RT.7 backfill recovers most
                of these via OrderItem.price summation; this annotation
                is the operator's "honest about what's still estimated"
                marker. */}
            {data.sales.total.pending && data.sales.total.pending.count > 0 && (
              <div
                className="text-xs text-amber-700 dark:text-amber-300 font-medium"
                title={
                  data.sales.total.pending.oldestAt
                    ? `Amazon withholds OrderTotal for some orders via SP-API. The estimate uses ChannelListing.price (falls back to Product.basePrice). Real values land via the GS-RT.7 backfill (OrderItem.price summation) or when Amazon releases OrderTotal. Oldest awaiting: ${new Date(data.sales.total.pending.oldestAt).toLocaleString()}.`
                    : 'Amazon withholds OrderTotal for some orders.'
                }
              >
                * includes ~{formatEur(data.sales.total.pending.estimateCents ?? 0)} estimated for{' '}
                {data.sales.total.pending.count} awaiting price
              </div>
            )}
            {/* MS.3 — non-EUR currency chips. Stays close to the
                headline so the EUR total isn't read as "everything". */}
            {data.sales.total.additionalCurrencies && data.sales.total.additionalCurrencies.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap pt-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
                  Also:
                </span>
                {data.sales.total.additionalCurrencies.map((c) => (
                  <span
                    key={c.currency}
                    className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 tabular-nums"
                    title={`${c.units} unit${c.units === 1 ? '' : 's'} in ${c.orderCount} order${c.orderCount === 1 ? '' : 's'} (native currency, not converted to EUR)`}
                  >
                    {formatCurrencyCents(c.valueCents, c.currency)}
                  </span>
                ))}
              </div>
            )}
            <Sparkline data={data.sales.sparkline} />
          </div>
        </SnapshotTile>

        <SnapshotTile
          icon={Package}
          label="Open Orders"
          expanded={expanded === 'openOrders'}
          onToggle={() => onToggle('openOrders')}
          buttonRef={openOrdersTileRef}
        >
          <div className="space-y-1.5">
            <PulseOnChange value={data.openOrders.total}>
              <div className="text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100">
                {data.openOrders.total}
              </div>
            </PulseOnChange>
            <div className="text-xs text-slate-500 dark:text-slate-400">Total count</div>
            <ul className="text-xs pt-2 mt-2 border-t border-slate-200 dark:border-slate-700 space-y-0.5">
              <SubLine label="FBM unshipped" value={data.openOrders.fbmUnshipped} href="/orders?fulfillment=FBM&status=PROCESSING,ON_HOLD" />
              <SubLine label="FBM pending" value={data.openOrders.fbmPending} href="/orders?fulfillment=FBM&status=PENDING,AWAITING_PAYMENT" />
              <SubLine label="FBA pending" value={data.openOrders.fbaPending} href="/orders?fulfillment=FBA&status=PENDING,AWAITING_PAYMENT" />
            </ul>
          </div>
        </SnapshotTile>

        <SnapshotTile
          icon={Mail}
          label="Buyer Messages"
          expanded={expanded === 'messages'}
          onToggle={() => onToggle('messages')}
          buttonRef={messagesTileRef}
        >
          <div className="space-y-1">
            <div className="text-2xl font-bold tabular-nums text-slate-400 dark:text-slate-500">—</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Not ingested yet</div>
          </div>
        </SnapshotTile>
      </div>

      {/* PV-RT.1 — AnchoredPopover-based detail panels (Amazon Seller
          Central pattern). Each popover positions directly beneath
          the clicked tile (anchored), with no darkened backdrop. ESC
          + click-outside dismiss via AnchoredPopover; left-aligned to
          the trigger so the popover edge lines up with the tile edge.
          Width 960px (~3 tile columns) so the per-marketplace table +
          chart get the room Amazon gives them. */}
      {expanded === 'sales' && (
        <AnchoredPopover
          anchorRef={salesTileRef}
          onClose={() => onToggle('sales')}
          align="left"
          ariaLabel="Sales detail"
          className="w-[960px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden"
        >
          <PopoverHeader
            icon={ShoppingCart}
            label="Sales"
            onClose={() => onToggle('sales')}
          />
          <div className="p-4 max-h-[70vh] overflow-y-auto">
            <SalesPanelPlaceholder data={data} onSelectMarketplace={setMarketplace} />
          </div>
        </AnchoredPopover>
      )}

      {expanded === 'openOrders' && (
        <AnchoredPopover
          anchorRef={openOrdersTileRef}
          onClose={() => onToggle('openOrders')}
          align="left"
          ariaLabel="Open orders detail"
          className="w-[960px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden"
        >
          <PopoverHeader
            icon={Package}
            label="Open Orders"
            onClose={() => onToggle('openOrders')}
          />
          <div className="p-4 max-h-[70vh] overflow-y-auto">
            <OpenOrdersPanelPlaceholder data={data} onSelectMarketplace={setMarketplace} />
          </div>
        </AnchoredPopover>
      )}

      {expanded === 'messages' && (
        <AnchoredPopover
          anchorRef={messagesTileRef}
          onClose={() => onToggle('messages')}
          align="left"
          ariaLabel="Buyer messages detail"
          className="w-[400px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden"
        >
          <PopoverHeader
            icon={Mail}
            label="Buyer Messages"
            onClose={() => onToggle('messages')}
          />
          <div className="p-4">
            <MessagesPanelPlaceholder />
          </div>
        </AnchoredPopover>
      )}
    </Card>
  )
}

// PV-RT.1 — popover header strip. Tile icon + label on the left so
// the operator visually links the popover back to the tile they
// clicked; close X on the right (AnchoredPopover handles ESC + click-
// outside but explicit X is the expected affordance).
function PopoverHeader({
  icon: Icon,
  label,
  onClose,
}: {
  icon: any
  label: string
  onClose: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
      <div className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
        <Icon size={14} className="text-slate-500 dark:text-slate-400" aria-hidden="true" />
        {label}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={`Close ${label} detail`}
        className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

/**
 * GS.7 — same-day-last-week delta indicator. Green arrow if revenue
 * is up, rose if down, slate if even/zero baseline.
 */
function SalesDelta({ deltaPct }: { deltaPct: number }) {
  const rounded = Math.round(deltaPct * 10) / 10
  const sign = rounded > 0 ? '▲' : rounded < 0 ? '▼' : '·'
  const tone =
    rounded > 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : rounded < 0
      ? 'text-rose-600 dark:text-rose-400'
      : 'text-slate-400 dark:text-slate-500'
  return (
    <span
      className={`text-xs font-semibold tabular-nums ${tone}`}
      title={`Sales delta vs same day last week: ${rounded > 0 ? '+' : ''}${rounded}%`}
    >
      {sign} {Math.abs(rounded).toFixed(1)}%
    </span>
  )
}

/**
 * AR.3 — visual pulse on number changes. Wraps a child whose visual
 * representation should flash when its driving value changes. Emerald
 * for up, rose for down. ~700ms fade so operators visibly see the
 * snapshot is alive — no more "is this actually updating?" mystery.
 *
 * Tracks previous value via ref so first render doesn't trigger a
 * pulse (we'd flash on every mount otherwise, which is noisy).
 */
function PulseOnChange({ value, children }: { value: number; children: React.ReactNode }) {
  const [tone, setTone] = useState<'emerald' | 'rose' | null>(null)
  const prevRef = useRef<number>(value)
  useEffect(() => {
    if (prevRef.current === value) return
    const next = value > prevRef.current ? 'emerald' : 'rose'
    prevRef.current = value
    setTone(next)
    const t = setTimeout(() => setTone(null), 700)
    return () => clearTimeout(t)
  }, [value])
  const ring =
    tone === 'emerald'
      ? 'ring-2 ring-emerald-400 ring-offset-1 dark:ring-emerald-500 dark:ring-offset-slate-900 bg-emerald-50/40 dark:bg-emerald-950/30'
      : tone === 'rose'
      ? 'ring-2 ring-rose-400 ring-offset-1 dark:ring-rose-500 dark:ring-offset-slate-900 bg-rose-50/40 dark:bg-rose-950/30'
      : ''
  return (
    <span className={`inline-block rounded transition-all duration-300 ${ring}`}>
      {children}
    </span>
  )
}

function SnapshotTile({
  icon: Icon,
  label,
  expanded,
  onToggle,
  children,
  buttonRef,
}: {
  icon: any
  label: string
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
  // PV-RT.1 — forward ref to the underlying button. Used by the
  // parent AnchoredPopover to position itself directly beneath the
  // clicked tile (Amazon Seller Central pattern). React.Ref instead
  // of RefObject so the prop accepts both object refs and callback
  // refs without compile-time mismatch.
  buttonRef?: React.Ref<HTMLButtonElement>
}) {
  // GP-RT.1 — tile is a button that OPENS A POPOVER. aria-haspopup
  // "dialog" communicates the pattern to AT users; aria-expanded
  // reflects open/closed. The arrow-up-right icon signals "opens
  // detail" without implying inline expansion.
  return (
    <div className="p-4">
      <button
        ref={buttonRef}
        type="button"
        onClick={onToggle}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        title={`Open ${label} detail`}
        className="w-full flex items-start justify-between gap-2 text-left group hover:opacity-90 transition-opacity"
      >
        <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <Icon size={13} className="text-slate-500 dark:text-slate-400" aria-hidden="true" />
          {label}
        </div>
        <span className="text-slate-400 dark:text-slate-500 group-hover:text-slate-600 dark:group-hover:text-slate-300 transition-colors">
          <ArrowUpRight size={14} aria-hidden="true" />
        </span>
      </button>
      <div className="mt-2">{children}</div>
    </div>
  )
}

function SubLine({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <li className="flex items-baseline justify-between gap-2">
      <span className="text-slate-600 dark:text-slate-400">{label}</span>
      <Link
        href={href}
        className={`tabular-nums font-semibold ${value > 0 ? 'text-blue-600 dark:text-blue-400 hover:underline' : 'text-slate-400 dark:text-slate-500'}`}
        onClick={(e) => { if (value === 0) e.preventDefault() }}
      >
        {value}
      </Link>
    </li>
  )
}

/**
 * Inline SVG sparkline — 7 days ending today. Hover any point to see
 * the per-day total in a dark tooltip (matches Amazon Seller Central).
 * The expanded Sales panel has a richer full-width chart (GS.3).
 */
function Sparkline({ data }: { data: Array<{ date: string; valueCents: number }> }) {
  const [hover, setHover] = useState<number | null>(null)
  if (data.length === 0) return null
  const W = 180
  const H = 40
  const PAD = 6
  const max = Math.max(1, ...data.map((d) => d.valueCents))
  const min = 0
  const xStep = (W - 2 * PAD) / Math.max(1, data.length - 1)
  const yScale = (v: number) => H - PAD - ((v - min) / (max - min)) * (H - 2 * PAD)
  const xFor = (i: number) => PAD + i * xStep
  const points = data.map((d, i) => `${xFor(i)},${yScale(d.valueCents)}`)
  const path = `M ${points.join(' L ')}`

  // Track which point is nearest the cursor as it moves over the SVG.
  // Pointer events fire on the invisible hit-target rect; we
  // translate the local x coordinate to the closest data index.
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const svg = e.currentTarget.ownerSVGElement
    if (!svg) return
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return
    const local = pt.matrixTransform(ctm.inverse())
    const idx = Math.round((local.x - PAD) / xStep)
    if (idx >= 0 && idx < data.length) setHover(idx)
  }

  const hovered = hover != null ? data[hover] : null
  const hoveredX = hover != null ? xFor(hover) : 0
  // Position the HTML tooltip absolutely using the percentage of the
  // SVG viewBox the point sits at; works inside `overflow-visible`.
  const tipLeftPct = (hoveredX / W) * 100
  const fmtDate = (iso: string) =>
    new Date(iso + 'T00:00:00').toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })

  return (
    <div className="relative mt-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        className="overflow-visible block"
        aria-label="7-day sales sparkline"
      >
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-slate-700 dark:text-slate-300"
        />
        {data.map((d, i) => {
          const isHovered = hover === i
          const isLast = i === data.length - 1
          return (
            <circle
              key={d.date}
              cx={xFor(i)}
              cy={yScale(d.valueCents)}
              r={isHovered ? 4 : isLast ? 3 : 1.5}
              className={
                isHovered
                  ? 'fill-slate-900 dark:fill-slate-100 stroke-white dark:stroke-slate-950'
                  : isLast
                  ? 'fill-slate-900 dark:fill-slate-100'
                  : 'fill-slate-400 dark:fill-slate-500'
              }
              strokeWidth={isHovered ? 1.5 : 0}
            />
          )
        })}
        {hovered && (
          <line
            x1={hoveredX}
            x2={hoveredX}
            y1={PAD}
            y2={H - PAD}
            className="stroke-slate-300 dark:stroke-slate-600"
            strokeWidth="1"
            strokeDasharray="2 2"
          />
        )}
        {/* Invisible hit target — covers the full viewBox so the cursor
            picks up the nearest data point even between markers. */}
        <rect
          x={0}
          y={0}
          width={W}
          height={H}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          style={{ cursor: 'pointer' }}
        />
      </svg>
      {hovered && (
        <div
          className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-slate-900 dark:bg-slate-100 px-2.5 py-1.5 text-white dark:text-slate-900 shadow-lg"
          style={{ left: `${tipLeftPct}%` }}
        >
          <div className="text-[10px] uppercase tracking-wider opacity-80">
            {fmtDate(hovered.date)}
          </div>
          <div className="text-sm font-bold tabular-nums">
            €{(hovered.valueCents / 100).toFixed(2)}
          </div>
        </div>
      )}
    </div>
  )
}

// GS.3 — Sales panel. Period dropdown, Table/Graph toggle, per-
// marketplace flagged table grouped by region (Europe / Middle East /
// etc.) with country names + sales + units columns. Re-fetches with
// the panel's own period state so the tile keeps Today's number
// stable while the panel can show 7d/30d/90d.
const MARKETPLACE_FLAGS_GS: Record<string, string> = {
  IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', UK: '🇬🇧', GB: '🇬🇧',
  NL: '🇳🇱', PL: '🇵🇱', SE: '🇸🇪', IE: '🇮🇪', BE: '🇧🇪', SA: '🇸🇦',
  AE: '🇦🇪', TR: '🇹🇷', US: '🇺🇸', CA: '🇨🇦', JP: '🇯🇵', MX: '🇲🇽',
}
// Re-exported under a public name for the SA.3 dropdown in the
// toolbar above; same map, kept as one source of truth.
const MARKETPLACE_NAMES_GS = {
  IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', UK: 'United Kingdom',
  GB: 'United Kingdom', NL: 'Netherlands', PL: 'Poland', SE: 'Sweden',
  IE: 'Ireland', BE: 'Belgium', TR: 'Turkey', AE: 'United Arab Emirates',
  SA: 'Saudi Arabia', US: 'United States', CA: 'Canada', JP: 'Japan', MX: 'Mexico',
}

type PeriodKey = 'today' | 'yesterday' | '7d' | '30d' | '90d'
const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: 'Today so far',
  yesterday: 'Yesterday',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
}

function SalesPanelPlaceholder({ data, onSelectMarketplace }: { data: Snapshot; onSelectMarketplace: (m: string | null) => void }) {
  const [period, setPeriod] = useState<PeriodKey>('today')
  const [view, setView] = useState<'table' | 'graph'>('table')
  const [panelData, setPanelData] = useState<Snapshot>(data)
  const [loading, setLoading] = useState(false)
  // SA.5 — yesterday's sales reconciliation vs Amazon's T+1 report.
  // GS-RT.3 — 'partial' status added: both data sources may agree
  // at €0 for PENDING+€0 orders, which the old code labelled "match"
  // and showed a misleading ✓ banner. 'partial' surfaces the awaiting-
  // price count so the operator knows the reconciliation isn't really
  // done.
  const [recon, setRecon] = useState<{
    status: 'match' | 'drift' | 'partial' | 'no-report' | 'no-orders'
    label: string
    deltaCents: number
    awaitingPriceCount?: number
  } | null>(null)
  useEffect(() => {
    const qs = new URLSearchParams()
    if (data.marketplace) qs.set('marketplace', data.marketplace)
    fetch(`${getBackendUrl()}/api/dashboard/sales-reconciliation?${qs.toString()}`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setRecon(d) })
      .catch(() => {})
  }, [data.marketplace])

  useEffect(() => {
    if (period === 'today') {
      setPanelData(data)
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(`${getBackendUrl()}/api/dashboard/global-snapshot?period=${period}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`)
        return r.json()
      })
      .then((d) => { if (!cancelled) setPanelData(d) })
      .catch(() => { if (!cancelled) setPanelData(data) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [period, data])

  // Group rows by region for the table layout, with a synthetic
  // region row containing the regional rollup that's collapsible.
  const grouped = panelData.sales.byMarketplace.reduce<Record<string, SalesRow[]>>((acc, r) => {
    ;(acc[r.region] = acc[r.region] ?? []).push(r)
    return acc
  }, {})
  const regions = Object.keys(grouped)

  return (
    <div className="space-y-3">
      {/* SA.5 — reconciliation banner for yesterday.
          GS-RT.3 — 'partial' tone is amber (intermediate signal: neither
          green ✓ nor red ⚠; awaiting prices). */}
      {recon && recon.status !== 'no-orders' && (
        <div
          className={`text-xs px-3 py-1.5 rounded border inline-flex items-center gap-2 ${
            recon.status === 'match'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/40 dark:border-emerald-900 dark:text-emerald-300'
              : recon.status === 'drift'
              ? 'bg-rose-50 border-rose-200 text-rose-800 dark:bg-rose-950/40 dark:border-rose-900 dark:text-rose-300'
              : recon.status === 'partial'
              ? 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/40 dark:border-amber-900 dark:text-amber-300'
              : 'bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300'
          }`}
        >
          <span aria-hidden="true">
            {recon.status === 'match'
              ? '✓'
              : recon.status === 'drift'
              ? '⚠'
              : recon.status === 'partial'
              ? '⏳'
              : '·'}
          </span>
          <span className="font-medium">Yesterday:</span>
          <span>{recon.label}</span>
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {/* PV-RT.2 — Amazon-parity controls cluster: Period | Currency
            | Table/Graph. No "Period" label — Amazon's dropdown
            ("Today so far ▼") communicates its own role. */}
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as PeriodKey)}
          aria-label="Period"
          className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
        >
          {(['today', 'yesterday', '7d', '30d', '90d'] as PeriodKey[]).map((p) => (
            <option key={p} value={p}>{PERIOD_LABELS[p]}</option>
          ))}
        </select>
        {/* PV-RT.2 — Currency dropdown placeholder. EUR-only today;
            FX conversion (GA-RT.4) will add native + EUR-equivalent
            options. Disabled state communicates the stub honestly
            instead of pretending the dropdown does something. */}
        <select
          value="EUR"
          disabled
          aria-label="Currency"
          title="FX conversion coming soon — multi-currency rollup deferred to GA-RT.4. Headline + table currently EUR only; non-EUR sales surface as chips beside the tile total."
          className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-500 cursor-not-allowed opacity-70"
        >
          <option value="EUR">EUR</option>
        </select>
        <div className="inline-flex items-center bg-slate-100 dark:bg-slate-800 rounded p-0.5">
          {(['table', 'graph'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`h-6 px-2.5 text-xs font-medium rounded ${view === v ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-600 dark:text-slate-400'}`}
            >
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        {loading && <span className="text-xs text-slate-400">Loading…</span>}
        <div className="ml-auto text-xs tabular-nums text-slate-500 dark:text-slate-400">
          {(() => {
            // Match the tile-level combined headline (SR.1) so the
            // panel and tile don't disagree. Asterisk + sub-line on
            // the tile is the trust marker; here we just sum.
            const pend = panelData.sales.total.pending
            const est = pend?.estimateCents ?? 0
            const combined =
              pend && pend.count > 0 && est > 0
                ? panelData.sales.total.valueCents + est
                : panelData.sales.total.valueCents
            return (
              <>
                Total:{' '}
                <span className="text-slate-900 dark:text-slate-100 font-semibold">
                  {formatEur(combined)}
                  {pend && pend.count > 0 && est > 0 && (
                    <span className="text-amber-600 dark:text-amber-400 ml-0.5" title={`Includes ~${formatEur(est)} estimated for ${pend.count} pending verification`}>
                      *
                    </span>
                  )}
                </span>
                {' · '}
                <span className="text-slate-700 dark:text-slate-300">{panelData.sales.total.units} units</span>
              </>
            )
          })()}
        </div>
      </div>

      {view === 'table' ? (
        panelData.sales.byMarketplace.length === 0 ? (
          <div className="text-sm text-slate-500 dark:text-slate-400 italic py-4 text-center">
            No sales in this period.
          </div>
        ) : (
          <div className="border border-slate-200 dark:border-slate-700 rounded overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-900 text-white dark:bg-slate-700">
                <tr>
                  <th className="text-left px-3 py-2 text-xs uppercase tracking-wider font-semibold">Stores</th>
                  <th className="text-left px-3 py-2 text-xs uppercase tracking-wider font-semibold">Ordered product sales</th>
                  <th className="text-left px-3 py-2 text-xs uppercase tracking-wider font-semibold">Units</th>
                </tr>
              </thead>
              <tbody>
                {regions.map((region) => {
                  const rows = grouped[region]
                  // GS-RT.9 — regional rollup folds the per-row pending
                  // estimate too. Without this fix, Europe shows
                  // €441.99 but its sub-rows include €X * estimates →
                  // sum doesn't match what's visible below. Matches the
                  // headline construction (sales total + estimate
                  // total). Also tracks whether any row contributed an
                  // estimate so the region row gets the * annotation.
                  const regionConfirmed = rows.reduce((s, r) => s + r.valueCents, 0)
                  const regionEstimate = rows.reduce((s, r) => s + (r.pendingEstimateCents ?? 0), 0)
                  const regionTotal = regionConfirmed + regionEstimate
                  const regionPendingCount = rows.reduce((s, r) => s + (r.pendingCount ?? 0), 0)
                  const regionUnits = rows.reduce((s, r) => s + r.units, 0)
                  return (
                    <RegionGroup key={region} region={region} rowCount={rows.length}>
                      <tr className="bg-slate-50 dark:bg-slate-900 font-semibold">
                        <td className="px-3 py-1.5 text-slate-900 dark:text-slate-100">▾ {region}</td>
                        <td className="px-3 py-1.5 text-slate-900 dark:text-slate-100 tabular-nums">
                          {formatEur(regionTotal)}
                          {regionEstimate > 0 && regionPendingCount > 0 && (
                            <span
                              className="text-amber-600 dark:text-amber-400 ml-0.5"
                              title={`Includes ~${formatEur(regionEstimate)} estimated across ${regionPendingCount} order${regionPendingCount === 1 ? '' : 's'} awaiting price (see asterisks on individual rows).`}
                            >
                              *
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-slate-900 dark:text-slate-100 tabular-nums">{regionUnits}</td>
                      </tr>
                      {rows.map((r) => (
                        <tr
                          key={r.marketplace}
                          className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                          onClick={(e) => {
                            // SA.4 — Cmd/Ctrl-click drills into /orders;
                            // plain click re-scopes the snapshot itself.
                            if (e.metaKey || e.ctrlKey) {
                              window.open(`/orders?marketplace=${encodeURIComponent(r.marketplace)}`, '_blank')
                              return
                            }
                            onSelectMarketplace(r.marketplace)
                          }}
                          title="Click to scope the snapshot to this marketplace · Cmd/Ctrl-click to open /orders"
                        >
                          <td className="px-3 py-1.5 text-slate-700 dark:text-slate-300">
                            <span className="inline-flex items-center gap-2">
                              <span aria-hidden="true">{MARKETPLACE_FLAGS_GS[r.marketplace] ?? '🏳️'}</span>
                              <span>{MARKETPLACE_NAMES_GS[r.marketplace as keyof typeof MARKETPLACE_NAMES_GS] ?? r.marketplace}</span>
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-blue-600 dark:text-blue-400 tabular-nums">
                            {/* GS-RT.1 — combine confirmed + estimated
                                for the row total so the table sums to
                                the tile headline. Annotate with the
                                same `*` marker the headline uses so the
                                operator knows the value is estimated
                                (ChannelListing.price → Product.basePrice
                                fallback). Tooltip explains the source. */}
                            {(() => {
                              const est = r.pendingEstimateCents ?? 0
                              const cnt = r.pendingCount ?? 0
                              const combined = r.valueCents + est
                              const showAsterisk = est > 0 && cnt > 0
                              return (
                                <>
                                  {formatEur(combined)}
                                  {showAsterisk && (
                                    <span
                                      className="text-amber-600 dark:text-amber-400 ml-0.5"
                                      title={`Includes ~${formatEur(est)} estimated for ${cnt} pending order${cnt === 1 ? '' : 's'}. Amazon withholds OrderTotal for PENDING orders; we estimate from ChannelListing.price (fallback to Product.basePrice). Real value lands within minutes of the order leaving PENDING.`}
                                    >
                                      *
                                    </span>
                                  )}
                                </>
                              )
                            })()}
                          </td>
                          <td className="px-3 py-1.5 text-blue-600 dark:text-blue-400 tabular-nums">
                            {r.units}
                          </td>
                        </tr>
                      ))}
                    </RegionGroup>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <SalesGraph data={panelData.sales.sparkline} />
      )}

      <Link href="/insights/sales" className="inline-flex items-center text-sm text-blue-600 dark:text-blue-400 hover:underline">
        Go to Sales Dashboard →
      </Link>
    </div>
  )
}

function RegionGroup({ children }: { region: string; rowCount: number; children: React.ReactNode }) {
  // Reserved for future collapse state; currently always-expanded so
  // operators see every country immediately.
  return <>{children}</>
}

function SalesGraph({ data }: { data: Array<{ date: string; valueCents: number }> }) {
  const W = 600
  const H = 200
  const PAD = 30
  const max = Math.max(1, ...data.map((d) => d.valueCents))
  const xStep = (W - 2 * PAD) / Math.max(1, data.length - 1)
  const yScale = (v: number) => H - PAD - (v / max) * (H - 2 * PAD)
  const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${PAD + i * xStep} ${yScale(d.valueCents)}`).join(' ')
  const fmtAxis = (cents: number) => {
    if (cents >= 100000) return `€${Math.round(cents / 100000)}K`
    if (cents >= 10000) return `€${Math.round(cents / 10000)}K`
    return `€${(cents / 100).toFixed(0)}`
  }
  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded p-3">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" aria-label="Sales sparkline">
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} className="stroke-slate-300 dark:stroke-slate-600" strokeWidth="1" />
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} className="stroke-slate-300 dark:stroke-slate-600" strokeWidth="1" />
        <text x={PAD - 6} y={PAD + 4} textAnchor="end" className="fill-slate-500 dark:fill-slate-400 text-[10px]">{fmtAxis(max)}</text>
        <text x={PAD - 6} y={H - PAD + 4} textAnchor="end" className="fill-slate-500 dark:fill-slate-400 text-[10px]">€0</text>
        <path d={path} fill="none" strokeWidth="2" className="stroke-slate-900 dark:stroke-slate-100" />
        {data.map((d, i) => (
          <g key={d.date}>
            <circle cx={PAD + i * xStep} cy={yScale(d.valueCents)} r="3" className="fill-white stroke-slate-900 dark:fill-slate-900 dark:stroke-slate-100" strokeWidth="1.5" />
            <text x={PAD + i * xStep} y={H - PAD + 14} textAnchor="middle" className="fill-slate-500 dark:fill-slate-400 text-[10px]">{d.date.slice(8)}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}

// GS.4 — Open orders breakdown table. Per-marketplace rows grouped
// by region (Europe / Middle East / etc.) with country flags + names.
// Every cell is a drill-through link to /orders with marketplace +
// fulfillment + status filters pre-applied.
function OpenOrdersPanelPlaceholder({ data, onSelectMarketplace }: { data: Snapshot; onSelectMarketplace: (m: string | null) => void }) {
  const grouped = data.openOrders.byMarketplace.reduce<Record<string, OpenOrdersRow[]>>((acc, r) => {
    ;(acc[r.region] = acc[r.region] ?? []).push(r)
    return acc
  }, {})
  const regions = Object.keys(grouped)

  const cellLink = (
    marketplace: string,
    fulfillment: 'FBM' | 'FBA',
    statuses: string,
    value: number,
  ) => {
    if (value === 0) {
      return <span className="text-slate-400 dark:text-slate-500 tabular-nums">0</span>
    }
    const params = new URLSearchParams({
      marketplace,
      fulfillment,
      status: statuses,
    })
    return (
      <Link
        href={`/orders?${params.toString()}`}
        className="text-blue-600 dark:text-blue-400 hover:underline tabular-nums font-semibold"
      >
        {value}
      </Link>
    )
  }

  return (
    <div className="space-y-3">
      <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
        Open orders breakdown
      </div>
      {data.openOrders.byMarketplace.length === 0 ? (
        <div className="text-sm text-slate-500 dark:text-slate-400 italic py-4 text-center">
          No open orders.
        </div>
      ) : (
        <div className="border border-slate-200 dark:border-slate-700 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-white dark:bg-slate-700">
              <tr>
                <th className="text-left px-3 py-2 text-xs uppercase tracking-wider font-semibold">Stores</th>
                <th className="text-left px-3 py-2 text-xs uppercase tracking-wider font-semibold">FBM unshipped</th>
                <th className="text-left px-3 py-2 text-xs uppercase tracking-wider font-semibold">FBM pending</th>
                <th className="text-left px-3 py-2 text-xs uppercase tracking-wider font-semibold">FBA pending</th>
              </tr>
            </thead>
            <tbody>
              {regions.map((region) => {
                const rows = grouped[region]
                const sumFbmU = rows.reduce((s, r) => s + r.fbmUnshipped, 0)
                const sumFbmP = rows.reduce((s, r) => s + r.fbmPending, 0)
                const sumFbaP = rows.reduce((s, r) => s + r.fbaPending, 0)
                return (
                  <RegionGroup key={region} region={region} rowCount={rows.length}>
                    <tr className="bg-slate-50 dark:bg-slate-900 font-semibold">
                      <td className="px-3 py-1.5 text-slate-900 dark:text-slate-100">▾ {region}</td>
                      <td className="px-3 py-1.5 tabular-nums text-slate-900 dark:text-slate-100">{sumFbmU}</td>
                      <td className="px-3 py-1.5 tabular-nums text-slate-900 dark:text-slate-100">{sumFbmP}</td>
                      <td className="px-3 py-1.5 tabular-nums text-slate-900 dark:text-slate-100">{sumFbaP}</td>
                    </tr>
                    {rows.map((r) => (
                      <tr
                        key={r.marketplace}
                        className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        <td
                          className="px-3 py-1.5 text-slate-700 dark:text-slate-300 cursor-pointer"
                          onClick={(e) => {
                            // SA.4 — country-cell click re-scopes the
                            // snapshot. The per-status cells stay as
                            // deep-links into /orders so operators can
                            // still drill into a specific status bucket.
                            if (e.metaKey || e.ctrlKey) {
                              window.open(`/orders?marketplace=${encodeURIComponent(r.marketplace)}`, '_blank')
                              return
                            }
                            onSelectMarketplace(r.marketplace)
                          }}
                          title="Click to scope the snapshot to this marketplace · Cmd/Ctrl-click to open /orders"
                        >
                          <span className="inline-flex items-center gap-2">
                            <span aria-hidden="true">{MARKETPLACE_FLAGS_GS[r.marketplace] ?? '🏳️'}</span>
                            <span>{MARKETPLACE_NAMES_GS[r.marketplace as keyof typeof MARKETPLACE_NAMES_GS] ?? r.marketplace}</span>
                          </span>
                        </td>
                        <td className="px-3 py-1.5">
                          {cellLink(r.marketplace, 'FBM', 'PROCESSING,ON_HOLD', r.fbmUnshipped)}
                        </td>
                        <td className="px-3 py-1.5">
                          {cellLink(r.marketplace, 'FBM', 'PENDING,AWAITING_PAYMENT', r.fbmPending)}
                        </td>
                        <td className="px-3 py-1.5">
                          {cellLink(r.marketplace, 'FBA', 'PENDING,AWAITING_PAYMENT', r.fbaPending)}
                        </td>
                      </tr>
                    ))}
                  </RegionGroup>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Link
        href="/orders"
        className="inline-flex items-center text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        Go to open orders →
      </Link>
    </div>
  )
}

// GS.5 — Buyer Messages placeholder. Full ingest would build a
// BuyerMessage table + Messaging API cron + count tile + UI thread.
// Out of scope for the snapshot rebuild; for now we surface the
// Seller Central messaging inbox per marketplace so operators have
// a one-click path to the canonical inbox.
function MessagesPanelPlaceholder() {
  const inboxes = [
    { code: 'IT', label: 'Italy', tld: 'it' },
    { code: 'DE', label: 'Germany', tld: 'de' },
    { code: 'FR', label: 'France', tld: 'fr' },
    { code: 'ES', label: 'Spain', tld: 'es' },
    { code: 'UK', label: 'United Kingdom', tld: 'co.uk' },
  ]
  return (
    <div className="space-y-3">
      <div className="text-sm text-slate-600 dark:text-slate-400">
        Buyer messages aren't ingested into Nexus yet. Open the Seller Central messaging
        inbox for the marketplace you want to check:
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {inboxes.map((m) => (
          <a
            key={m.code}
            href={`https://sellercentral.amazon.${m.tld}/messaging/inbox`}
            target="_blank"
            rel="noopener noreferrer"
            className="h-8 px-3 text-sm border border-slate-200 dark:border-slate-700 rounded inline-flex items-center gap-1.5 bg-white dark:bg-slate-950 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200"
          >
            <span aria-hidden="true">{MARKETPLACE_FLAGS_GS[m.code] ?? '🏳️'}</span>
            <span>{m.label}</span>
          </a>
        ))}
      </div>
    </div>
  )
}
