'use client'

// F.5 — Smart Replenishment workspace.
//
// Reads from the F.4 forecast layer:
//   - urgency tiles (CRITICAL/HIGH/MEDIUM/LOW counts)
//   - upcoming retail events banner with prep deadlines
//   - virtualized table with forecast-driven velocity, lead-time-window
//     demand + 80% confidence band, ATP composition (on-hand + inbound),
//     lead time + supplier source
//   - row-click drawer with 90-day forecast chart, signal breakdown,
//     open inbound shipments
//   - multi-select → bulk-draft-PO flow (one POST creates one PO per
//     supplier, grouped automatically)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  Factory,
  FileText,
  FileWarning,
  Loader2,
  Mail,
  RefreshCw,
  ShoppingCart,
  Sparkles,
  X,
} from 'lucide-react'
import {
  Area,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

type Urgency = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

interface OpenShipmentRef {
  shipmentId: string
  type: string
  status: string
  expectedAt: string | null
  remainingUnits: number
  reference: string | null
}

interface Suggestion {
  productId: string
  sku: string
  name: string
  currentStock: number
  inboundWithinLeadTime: number
  totalOpenInbound: number
  effectiveStock: number
  openShipments: OpenShipmentRef[]
  unitsSold30d: number
  velocity: number
  trailingVelocity: number
  forecastedDemand30d: number | null
  forecastedDemandLeadTime: number | null
  forecastedDemandLower80: number | null
  forecastedDemandUpper80: number | null
  forecastSource: 'FORECAST' | 'TRAILING_VELOCITY'
  daysOfStockLeft: number | null
  reorderPoint: number
  reorderQuantity: number
  urgency: Urgency
  needsReorder: boolean
  isManufactured: boolean
  preferredSupplierId: string | null
  fulfillmentChannel: string | null
  leadTimeDays: number
  leadTimeSource: 'SUPPLIER_PRODUCT_OVERRIDE' | 'SUPPLIER_DEFAULT' | 'FALLBACK'
  // R.2 — multi-location stock breakdown
  byLocation?: Array<{
    locationId: string
    locationCode: string
    locationName: string
    locationType: string
    servesMarketplaces: string[]
    quantity: number
    reserved: number
    available: number
  }>
  totalAvailable?: number
  stockSource?: string
  channelCover?: Array<{
    channel: string
    marketplace: string
    velocityPerDay: number
    available: number
    locationCode: string | null
    source: string
    daysOfCover: number | null
  }>
  // R.3 — id of the persisted ReplenishmentRecommendation that
  // produced this suggestion. Sent back in PO creation so the audit
  // trail links rec → PO.
  recommendationId?: string | null
  // R.14 — urgency provenance. globalUrgency = aggregate signal;
  // urgency = max(global, worst-channel). urgencySource flags
  // whether a specific channel-marketplace promoted the headline.
  // R.13 added 'EVENT' for prep-deadline driven promotion.
  globalUrgency?: Urgency
  urgencySource?: 'GLOBAL' | 'CHANNEL' | 'EVENT'
  worstChannelKey?: string | null
  worstChannelDaysOfCover?: number | null
  // R.13 — event-prep recommendation
  prepEvent?: {
    eventId: string
    name: string
    startDate: string
    prepDeadline: string
    daysUntilStart: number
    daysUntilDeadline: number
    expectedLift: number
    extraUnitsRecommended: number
  } | null
  prepEventId?: string | null
  prepExtraUnits?: number | null
  // R.15 — FX context for cost basis
  unitCostCurrency?: string
  fxRateUsed?: number | null
  // R.4 — math snapshot for the drawer's "Reorder math" panel.
  safetyStockUnits?: number
  eoqUnits?: number
  constraintsApplied?: string[]
  unitCostCents?: number | null
  servicePercentEffective?: number
}

interface ReplenishmentResponse {
  suggestions: Suggestion[]
  counts: { critical: number; high: number; medium: number; low: number }
  window: number
  filter: { channel: string | null; marketplace: string | null }
}

interface UpcomingEvent {
  id: string
  name: string
  startDate: string
  endDate: string
  channel: string | null
  marketplace: string | null
  productType: string | null
  expectedLift: number
  prepLeadTimeDays: number
  prepDeadline: string
  daysUntilStart: number
  daysUntilDeadline: number
  description: string | null
}

const URGENCY_TONE: Record<string, string> = {
  CRITICAL: 'bg-rose-50 text-rose-700 border-rose-300',
  HIGH: 'bg-amber-50 text-amber-700 border-amber-300',
  MEDIUM: 'bg-blue-50 text-blue-700 border-blue-300',
  LOW: 'bg-slate-50 text-slate-600 border-slate-200',
}

// R.5 — sort keys for the table column headers. 'urgency' falls
// through to backend ordering (CRITICAL → HIGH → MEDIUM → LOW with
// daysOfStockLeft asc as tiebreaker); other keys re-sort the
// already-fetched array in JS.
type SortKey = 'urgency' | 'daysOfCover' | 'velocity' | 'qty' | 'stock' | 'sku' | 'name'

export default function ReplenishmentWorkspace() {
  // R.5 — URL-driven state. Filters / search / sort are bookmarkable
  // and shareable. Selection + bulk modal stay local (ephemeral).
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const filter = (searchParams.get('filter') ??
    'NEEDS_REORDER') as 'ALL' | 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'NEEDS_REORDER'
  const channelFilter = searchParams.get('channel') ?? ''
  const marketplaceFilter = searchParams.get('marketplace') ?? ''
  const urlSearch = searchParams.get('search') ?? ''
  const sortBy = (searchParams.get('sortBy') ?? 'urgency') as SortKey
  const sortDir = (searchParams.get('sortDir') ?? 'desc') as 'asc' | 'desc'
  const drawerProductId = searchParams.get('drawer')

  const [data, setData] = useState<ReplenishmentResponse | null>(null)
  const [events, setEvents] = useState<UpcomingEvent[] | null>(null)
  const [loading, setLoading] = useState(true)
  // searchInput is local + debounced; the URL param is the persisted value.
  const [searchInput, setSearchInput] = useState(urlSearch)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  // R.5 — auto-refresh interval persisted per-device via localStorage.
  const [autoRefreshMin, setAutoRefreshMin] = useState<0 | 5 | 15>(0)
  // R.5 — toast queue (~30 lines, no library).
  const [toasts, setToasts] = useState<Array<{ id: number; tone: 'ok' | 'error'; msg: string }>>([])
  const toastIdRef = useRef(0)
  const pushToast = useCallback((tone: 'ok' | 'error', msg: string) => {
    const id = ++toastIdRef.current
    setToasts((t) => [...t, { id, tone, msg }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500)
  }, [])

  const updateUrl = useCallback((patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }, [searchParams, pathname, router])

  const setFilter = (f: typeof filter) => updateUrl({ filter: f === 'NEEDS_REORDER' ? undefined : f })
  const setChannelFilter = (c: string) => updateUrl({ channel: c || undefined })
  const setMarketplaceFilter = (m: string) => updateUrl({ marketplace: m || undefined })
  const setDrawerProductId = (id: string | null) => updateUrl({ drawer: id ?? undefined })
  const setSort = (key: SortKey) => {
    if (key === sortBy) {
      updateUrl({ sortDir: sortDir === 'asc' ? 'desc' : 'asc' })
    } else {
      updateUrl({ sortBy: key === 'urgency' ? undefined : key, sortDir: undefined })
    }
  }

  // Debounced search input → URL
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (searchInput !== urlSearch) updateUrl({ search: searchInput || undefined })
    }, 250)
    return () => window.clearTimeout(t)
  }, [searchInput, urlSearch, updateUrl])

  // Restore auto-refresh preference
  useEffect(() => {
    const stored = window.localStorage.getItem('nexus-replenishment-autorefresh')
    const n = Number(stored)
    if (n === 5 || n === 15) setAutoRefreshMin(n)
  }, [])
  useEffect(() => {
    window.localStorage.setItem('nexus-replenishment-autorefresh', String(autoRefreshMin))
  }, [autoRefreshMin])

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ window: '30' })
      if (channelFilter) params.set('channel', channelFilter)
      if (marketplaceFilter) params.set('marketplace', marketplaceFilter)
      const [r1, r2] = await Promise.all([
        fetch(
          `${getBackendUrl()}/api/fulfillment/replenishment?${params.toString()}`,
          { cache: 'no-store' },
        ),
        fetch(
          `${getBackendUrl()}/api/fulfillment/replenishment/upcoming-events`,
          { cache: 'no-store' },
        ),
      ])
      if (r1.ok) setData(await r1.json())
      if (r2.ok) {
        const ev = await r2.json()
        setEvents(ev.events ?? [])
      }
    } finally {
      setLoading(false)
    }
  }, [channelFilter, marketplaceFilter])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // F.5 — Marketplace dropdown options. Suggestions don't carry
  // marketplace per row in v0; the active filter is the source of truth
  // (banner already shows what's filtered). Hardcoded list covers
  // Xavia's marketplaces; F.5.1 follow-up ships a /fulfillment/facets
  // endpoint to dynamically populate.
  const marketplaceOptions = ['IT', 'DE', 'FR', 'ES', 'UK', 'GLOBAL']

  const filtered = useMemo(() => {
    if (!data) return []
    let rows = data.suggestions
    if (filter === 'CRITICAL') rows = rows.filter((s) => s.urgency === 'CRITICAL')
    else if (filter === 'HIGH')
      rows = rows.filter((s) => s.urgency === 'HIGH' || s.urgency === 'CRITICAL')
    else if (filter === 'MEDIUM') rows = rows.filter((s) => s.urgency === 'MEDIUM')
    else if (filter === 'NEEDS_REORDER') rows = rows.filter((s) => s.needsReorder)
    if (urlSearch.trim()) {
      const q = urlSearch.trim().toLowerCase()
      rows = rows.filter(
        (r) =>
          r.sku.toLowerCase().includes(q) || r.name.toLowerCase().includes(q),
      )
    }
    // R.5 — client-side sort. urgency mode = backend ordering; other
    // keys re-sort the already-fetched array.
    const dir = sortDir === 'asc' ? 1 : -1
    if (sortBy !== 'urgency') {
      rows = [...rows].sort((a, b) => {
        let av: number | string
        let bv: number | string
        switch (sortBy) {
          case 'daysOfCover':
            av = a.daysOfStockLeft ?? Number.MAX_SAFE_INTEGER
            bv = b.daysOfStockLeft ?? Number.MAX_SAFE_INTEGER
            return (av - (bv as number)) * dir
          case 'velocity': return ((a.velocity ?? 0) - (b.velocity ?? 0)) * dir
          case 'qty':      return ((a.reorderQuantity ?? 0) - (b.reorderQuantity ?? 0)) * dir
          case 'stock':    return ((a.effectiveStock ?? 0) - (b.effectiveStock ?? 0)) * dir
          case 'sku':      return a.sku.localeCompare(b.sku) * dir
          case 'name':     return a.name.localeCompare(b.name) * dir
          default:         return 0
        }
      })
    }
    return rows
  }, [data, filter, urlSearch, sortBy, sortDir])

  // R.5 — auto-refresh. Pause when document is hidden so a backgrounded
  // tab doesn't burn requests.
  useEffect(() => {
    if (autoRefreshMin === 0) return
    const ms = autoRefreshMin * 60_000
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchData()
    }, ms)
    return () => window.clearInterval(id)
  }, [autoRefreshMin, fetchData])

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map((r) => r.productId)))
    }
  }
  const clearSelection = () => setSelectedIds(new Set())

  const draftSinglePo = async (s: Suggestion) => {
    if (s.isManufactured) {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/work-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: s.productId,
          quantity: s.reorderQuantity,
          notes: 'Replenishment auto-suggestion',
        }),
      })
      if (res.ok) {
        pushToast('ok', `Work order created for ${s.reorderQuantity} × ${s.sku}`)
        fetchData()
      } else pushToast('error', 'Work order create failed')
      return
    }
    const res = await fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/${s.productId}/draft-po`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quantity: s.reorderQuantity,
          supplierId: s.preferredSupplierId,
          // R.3 — link PO back to source recommendation
          recommendationId: s.recommendationId ?? undefined,
        }),
      },
    )
    if (res.ok) {
      const po = await res.json()
      pushToast('ok', `Draft PO ${po.poNumber} created`)
      fetchData()
    } else {
      pushToast('error', 'Draft PO failed')
    }
  }

  const drawerProduct = useMemo(
    () => filtered.find((s) => s.productId === drawerProductId) ?? null,
    [filtered, drawerProductId],
  )

  return (
    <div className="space-y-5">
      <PageHeader
        title="Smart Replenishment"
        description="Forecast-driven reorder suggestions. Click a row to see its 90-day forecast, signals, and inbound shipments."
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Replenishment' },
        ]}
      />

      {/* Upcoming-events banner — surfaces the next ≤3 events with prep deadlines */}
      {events && events.length > 0 && (
        <UpcomingEventsBanner events={events.slice(0, 3)} />
      )}

      {/* Urgency tiles */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <UrgencyTile
            label="Critical"
            value={data.counts.critical}
            tone="CRITICAL"
            onClick={() => setFilter('CRITICAL')}
          />
          <UrgencyTile
            label="High"
            value={data.counts.high}
            tone="HIGH"
            onClick={() => setFilter('HIGH')}
          />
          <UrgencyTile
            label="Medium"
            value={data.counts.medium}
            tone="MEDIUM"
            onClick={() => setFilter('MEDIUM')}
          />
          <UrgencyTile
            label="Low / OK"
            value={data.counts.low}
            tone="LOW"
            onClick={() => setFilter('ALL')}
          />
        </div>
      )}

      {/* R.1 — forecast health (aggregate MAPE + per-regime + trend).
          Renders only when accuracy data exists (post-cron / post-
          backfill); silent before the first run so the page doesn't
          show a noisy empty card. */}
      <ForecastHealthCard />

      {/* R.12 — stockout impact (events count + lost margin/revenue).
          Renders only when there are stockouts to report; silent
          pre-launch. */}
      <StockoutImpactCard />

      {/* R.16 — model A/B card. Silent unless a challenger is rolled
          out via the rollout endpoint. */}
      <ForecastModelsCard />

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5">
          {(['NEEDS_REORDER', 'CRITICAL', 'HIGH', 'MEDIUM', 'ALL'] as const).map(
            (t) => (
              <button
                key={t}
                onClick={() => setFilter(t)}
                className={cn(
                  'h-7 px-3 text-[12px] font-medium rounded transition-colors',
                  filter === t
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900',
                )}
              >
                {t === 'NEEDS_REORDER'
                  ? 'Needs reorder'
                  : t.charAt(0) + t.slice(1).toLowerCase()}
              </button>
            ),
          )}
        </div>
        <select
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value)}
          className="h-8 px-2 border border-slate-200 rounded-md text-[12px] bg-white"
        >
          <option value="">All channels</option>
          <option value="AMAZON">Amazon</option>
          <option value="EBAY">eBay</option>
          <option value="SHOPIFY">Shopify</option>
          <option value="WOOCOMMERCE">WooCommerce</option>
        </select>
        <select
          value={marketplaceFilter}
          onChange={(e) => setMarketplaceFilter(e.target.value)}
          className="h-8 px-2 border border-slate-200 rounded-md text-[12px] bg-white"
        >
          <option value="">All marketplaces</option>
          {marketplaceOptions.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <Input
            placeholder="Search SKU…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-44 sm:w-56"
          />
          {/* R.5 — auto-refresh dropdown. Pauses when tab is hidden. */}
          <select
            value={autoRefreshMin}
            onChange={(e) => setAutoRefreshMin(Number(e.target.value) as 0 | 5 | 15)}
            className="h-8 px-2 text-[11px] border border-slate-200 rounded-md bg-white"
            title="Auto-refresh interval (paused when tab hidden)"
          >
            <option value={0}>Auto-refresh: Off</option>
            <option value={5}>Auto-refresh: 5 min</option>
            <option value={15}>Auto-refresh: 15 min</option>
          </select>
          <button
            onClick={fetchData}
            className="h-8 px-3 text-[12px] border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5"
          >
            <RefreshCw size={12} /> Refresh
          </button>
          {/* R.5 — CSV export of currently filtered + sorted suggestions */}
          <button
            onClick={() => exportSuggestionsCsv(filtered)}
            className="h-8 px-3 text-[12px] border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5"
            title="Export the currently filtered + sorted suggestions to CSV"
            disabled={filtered.length === 0}
          >
            <Download size={12} /> Export CSV
          </button>
        </div>
      </div>

      {/* Bulk action bar — visible only when rows are selected */}
      {selectedIds.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-md px-3 py-2 flex items-center justify-between gap-3">
          <div className="text-[13px] text-slate-700">
            <span className="font-semibold">{selectedIds.size}</span>{' '}
            selected
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={clearSelection}
              className="h-7 px-2 text-[12px] border border-slate-200 rounded hover:bg-slate-50"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setBulkOpen(true)}
              className="h-7 px-3 text-[12px] bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1.5"
            >
              <ShoppingCart size={12} /> Bulk-create POs
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      {loading && !data ? (
        <Card>
          <div className="text-[13px] text-slate-500 py-8 text-center inline-flex items-center justify-center gap-2 w-full">
            <Loader2 className="w-4 h-4 animate-spin" />
            Reading forecast layer…
          </div>
        </Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Nothing to reorder"
          description="All products in this view have plenty of runway."
        />
      ) : (
        <>
        {/* R.5 — mobile: render each suggestion as a card. Desktop
            (lg+) keeps the dense table. The 13-column layout was an
            unusable horizontal scroll below ~1100px. */}
        <div className="lg:hidden space-y-2">
          {filtered.map((s) => (
            <MobileSuggestionCard
              key={s.productId}
              s={s}
              selected={selectedIds.has(s.productId)}
              onToggleSelect={() => toggleSelected(s.productId)}
              onOpenDrawer={() => setDrawerProductId(s.productId)}
              onDraftPo={() => draftSinglePo(s)}
            />
          ))}
        </div>
        <Card noPadding className="hidden lg:block">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left w-9">
                    <input
                      type="checkbox"
                      checked={
                        filtered.length > 0 &&
                        selectedIds.size === filtered.length
                      }
                      onChange={toggleSelectAll}
                      aria-label="Select all"
                    />
                  </th>
                  <SortableTh sortKey="name" current={sortBy} dir={sortDir} onSort={setSort} className={th()}>Product</SortableTh>
                  <SortableTh sortKey="urgency" current={sortBy} dir={sortDir} onSort={setSort} className={th()}>Urgency</SortableTh>
                  <SortableTh sortKey="stock" current={sortBy} dir={sortDir} onSort={setSort} className={thRight()}>On-hand</SortableTh>
                  <th className={thRight()}>Inbound (LT)</th>
                  <th className={thRight()}>ATP</th>
                  <SortableTh sortKey="velocity" current={sortBy} dir={sortDir} onSort={setSort} className={thRight()}>Velocity</SortableTh>
                  <SortableTh sortKey="daysOfCover" current={sortBy} dir={sortDir} onSort={setSort} className={thRight()}>Days left</SortableTh>
                  <th className={thRight()}>Lead time</th>
                  <th className={thRight()}>Forecast (LT)</th>
                  <SortableTh sortKey="qty" current={sortBy} dir={sortDir} onSort={setSort} className={thRight()}>Suggested qty</SortableTh>
                  <th className={thRight()}></th>
                  <th className={th()}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <SuggestionRow
                    key={s.productId}
                    suggestion={s}
                    selected={selectedIds.has(s.productId)}
                    onToggle={() => toggleSelected(s.productId)}
                    onOpenDrawer={() => setDrawerProductId(s.productId)}
                    onDraftPo={() => draftSinglePo(s)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        </>
      )}

      {/* R.5 — toast tray (top-right). Auto-dismisses after 4.5s. */}
      {toasts.length > 0 && (
        <div className="fixed top-4 right-4 z-50 space-y-2 max-w-sm">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={cn(
                'border rounded-lg shadow-md px-3 py-2 text-[12px] flex items-start gap-2',
                t.tone === 'ok'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-rose-50 border-rose-200 text-rose-800',
              )}
            >
              {t.tone === 'ok' ? <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" /> : <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />}
              <span className="flex-1">{t.msg}</span>
              <button onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))} className="opacity-60 hover:opacity-100">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Detail drawer */}
      {drawerProduct && (
        <ForecastDetailDrawer
          productId={drawerProduct.productId}
          marketplace={marketplaceFilter || null}
          channel={channelFilter || null}
          onClose={() => setDrawerProductId(null)}
        />
      )}

      {/* Bulk-PO modal */}
      {bulkOpen && (
        <BulkPoModal
          suggestions={filtered.filter((s) => selectedIds.has(s.productId))}
          onClose={() => setBulkOpen(false)}
          onSuccess={() => {
            setBulkOpen(false)
            clearSelection()
            fetchData()
          }}
        />
      )}
    </div>
  )
}

function th() {
  return 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700'
}
function thRight() {
  return 'px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700'
}

function UrgencyTile({
  label,
  value,
  tone,
  onClick,
}: {
  label: string
  value: number
  tone: string
  onClick: () => void
}) {
  return (
    <button onClick={onClick} className="text-left">
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[24px] font-semibold tabular-nums text-slate-900">
              {value}
            </div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 mt-1">
              {label}
            </div>
          </div>
          <span
            className={cn(
              'inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded',
              URGENCY_TONE[tone],
            )}
          >
            {tone}
          </span>
        </div>
      </Card>
    </button>
  )
}

function UpcomingEventsBanner({ events }: { events: UpcomingEvent[] }) {
  return (
    <div className="border border-violet-200 bg-violet-50/60 rounded-md p-3">
      <div className="flex items-center gap-2 mb-2">
        <CalendarClock className="w-4 h-4 text-violet-700" />
        <span className="text-[12px] uppercase tracking-wider text-violet-800 font-semibold">
          Upcoming retail events
        </span>
      </div>
      <div className="space-y-1.5">
        {events.map((e) => {
          const isPastDeadline = e.daysUntilDeadline <= 0
          return (
            <div
              key={e.id}
              className="flex items-center justify-between gap-3 text-[12px]"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-semibold text-slate-900 truncate">
                  {e.name}
                </span>
                <span className="text-slate-500">
                  {e.daysUntilStart > 0
                    ? `in ${e.daysUntilStart} day${e.daysUntilStart === 1 ? '' : 's'}`
                    : `started ${Math.abs(e.daysUntilStart)} day${Math.abs(e.daysUntilStart) === 1 ? '' : 's'} ago`}
                </span>
                <span className="text-slate-400">·</span>
                <span className="text-slate-600">
                  expected lift {e.expectedLift.toFixed(1)}×
                </span>
                {(e.channel || e.marketplace) && (
                  <span className="text-slate-400 font-mono text-[10px]">
                    {[e.channel, e.marketplace].filter(Boolean).join(':')}
                  </span>
                )}
              </div>
              <span
                className={cn(
                  'text-[11px] font-medium tabular-nums',
                  isPastDeadline ? 'text-rose-700' : 'text-amber-700',
                )}
              >
                {isPastDeadline ? (
                  <span className="inline-flex items-center gap-1">
                    <FileWarning className="w-3 h-3" /> prep window passed
                  </span>
                ) : (
                  <>last day to PO: {e.prepDeadline}</>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// R.5 — sortable column header. Click to set sort; click again to
// flip direction. Renders a small chevron next to the active column.
function SortableTh({
  sortKey,
  current,
  dir,
  onSort,
  className,
  children,
}: {
  sortKey: SortKey
  current: SortKey
  dir: 'asc' | 'desc'
  onSort: (k: SortKey) => void
  className: string
  children: React.ReactNode
}) {
  const active = current === sortKey
  return (
    <th className={className}>
      <button
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 hover:text-slate-900"
      >
        {children}
        {active && (dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
      </button>
    </th>
  )
}

// R.5 — mobile-card alternative to the 13-column table. Shows the
// most important fields stacked, with the row's actions accessible
// via tap. Renders below `lg:` breakpoint.
function MobileSuggestionCard({
  s,
  selected,
  onToggleSelect,
  onOpenDrawer,
  onDraftPo,
}: {
  s: Suggestion
  selected: boolean
  onToggleSelect: () => void
  onOpenDrawer: () => void
  onDraftPo: () => void
}) {
  const tone = URGENCY_TONE[s.urgency] ?? URGENCY_TONE.LOW
  return (
    <div className="border border-slate-200 rounded-lg bg-white p-3 space-y-2">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="mt-0.5"
          aria-label={`Select ${s.sku}`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[11px] text-slate-700">{s.sku}</span>
            <span className={cn('text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border', tone)}>
              {s.urgency}
            </span>
            {/* R.14 — channel badge on mobile too */}
            {s.urgencySource === 'CHANNEL' && s.worstChannelKey && (
              <span className="text-[9px] uppercase tracking-wider text-slate-500 font-mono">
                · {s.worstChannelKey.replace(':', '·')}
              </span>
            )}
          </div>
          <div className="text-[12px] text-slate-900 truncate mt-0.5">{s.name}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <div className="uppercase tracking-wider text-[9px] text-slate-500 font-semibold">Stock</div>
          <div className="tabular-nums font-semibold text-slate-900">{s.effectiveStock}</div>
        </div>
        <div>
          <div className="uppercase tracking-wider text-[9px] text-slate-500 font-semibold">Days left</div>
          <div className="tabular-nums font-semibold text-slate-900">
            {s.daysOfStockLeft == null ? '—' : `${s.daysOfStockLeft}d`}
          </div>
        </div>
        <div>
          <div className="uppercase tracking-wider text-[9px] text-slate-500 font-semibold">Reorder</div>
          <div className="tabular-nums font-semibold text-slate-900">{s.reorderQuantity}</div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1 border-t border-slate-100">
        <button
          onClick={onDraftPo}
          className="flex-1 h-8 text-[11px] bg-slate-900 text-white rounded hover:bg-slate-800 inline-flex items-center justify-center gap-1"
        >
          {s.isManufactured ? <><Factory size={11} /> WO</> : <><ShoppingCart size={11} /> PO</>}
        </button>
        <button
          onClick={onOpenDrawer}
          className="h-8 px-3 text-[11px] border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1"
        >
          Details <ChevronRight size={11} />
        </button>
      </div>
    </div>
  )
}

// R.5 — CSV export of currently filtered + sorted suggestions.
// Pure client-side: build the CSV string, trigger a download via
// <a download>. No new endpoint.
function exportSuggestionsCsv(suggestions: Suggestion[]): void {
  const rows: string[][] = [
    [
      'SKU', 'Name', 'Urgency', 'On-hand', 'Inbound (LT)', 'Effective stock',
      'Velocity (units/day)', 'Forecast 30d', 'Days of cover', 'Reorder point',
      'Reorder qty', 'Safety stock', 'EOQ', 'Constraints', 'Lead time (days)',
      'Supplier', 'Recommendation ID',
    ],
  ]
  for (const s of suggestions) {
    rows.push([
      s.sku,
      s.name,
      s.urgency,
      String(s.currentStock),
      String(s.inboundWithinLeadTime),
      String(s.effectiveStock),
      String(s.velocity),
      s.forecastedDemand30d != null ? String(s.forecastedDemand30d) : '',
      s.daysOfStockLeft != null ? String(s.daysOfStockLeft) : '',
      String(s.reorderPoint),
      String(s.reorderQuantity),
      s.safetyStockUnits != null ? String(s.safetyStockUnits) : '',
      s.eoqUnits != null ? String(s.eoqUnits) : '',
      (s.constraintsApplied ?? []).join('|'),
      String(s.leadTimeDays),
      s.preferredSupplierId ?? '',
      s.recommendationId ?? '',
    ])
  }
  const csv = rows
    .map((r) => r.map((cell) => {
      const needsQuote = /[",\n]/.test(cell)
      return needsQuote ? `"${cell.replace(/"/g, '""')}"` : cell
    }).join(','))
    .join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `replenishment-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function SuggestionRow({
  suggestion: s,
  selected,
  onToggle,
  onOpenDrawer,
  onDraftPo,
}: {
  suggestion: Suggestion
  selected: boolean
  onToggle: () => void
  onOpenDrawer: () => void
  onDraftPo: () => void
}) {
  const stockTone =
    s.effectiveStock === 0
      ? 'text-rose-600'
      : s.effectiveStock <= s.reorderPoint
      ? 'text-amber-600'
      : 'text-slate-900'
  const forecastBand =
    s.forecastSource === 'FORECAST' &&
    s.forecastedDemandLeadTime != null &&
    s.forecastedDemandLower80 != null &&
    s.forecastedDemandUpper80 != null
      ? `${Math.round(s.forecastedDemandLeadTime)} (${Math.round(
          s.forecastedDemandLower80,
        )}–${Math.round(s.forecastedDemandUpper80)})`
      : null
  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50">
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${s.sku}`}
        />
      </td>
      <td className="px-3 py-2">
        <Link
          href={`/products/${s.productId}/edit`}
          className="text-[13px] text-slate-900 hover:text-blue-600 truncate block max-w-md"
        >
          {s.name}
        </Link>
        <div className="text-[11px] text-slate-500 font-mono inline-flex items-center gap-1.5">
          {s.sku}
          {s.isManufactured && <Factory size={10} className="text-violet-600" />}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="inline-flex items-center gap-1 flex-wrap">
          <span
            className={cn(
              'inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded',
              URGENCY_TONE[s.urgency],
            )}
          >
            {s.urgency}
          </span>
          {/* R.14 — channel-driven urgency badge. Tooltip shows the
              specific channel and days-of-cover that promoted the
              headline above the global aggregate. */}
          {s.urgencySource === 'CHANNEL' && s.worstChannelKey && (
            <span
              className="text-[9px] uppercase tracking-wider text-slate-500 font-mono"
              title={`Promoted because of ${s.worstChannelKey} (${s.worstChannelDaysOfCover}d cover). Aggregate was ${s.globalUrgency ?? 'lower'}.`}
            >
              · {s.worstChannelKey.replace(':', '·')}
            </span>
          )}
          {/* R.13 — event-driven urgency badge. Tooltip shows the
              event name and prep deadline. Purple to distinguish from
              channel-driven (slate-grey) and global (no badge). */}
          {s.urgencySource === 'EVENT' && s.prepEvent && (
            <span
              className="text-[9px] uppercase tracking-wider text-violet-600 font-mono"
              title={`Promoted by ${s.prepEvent.name} prep deadline (${s.prepEvent.daysUntilDeadline}d to deadline, +${s.prepEvent.extraUnitsRecommended} extra units).`}
            >
              · {s.prepEvent.name.toUpperCase().slice(0, 12)}
            </span>
          )}
        </div>
      </td>
      <td
        className={cn(
          'px-3 py-2 text-right tabular-nums font-semibold',
          stockTone,
        )}
        title="On-hand stock"
      >
        {s.currentStock}
      </td>
      <td
        className="px-3 py-2 text-right tabular-nums text-slate-700"
        title={
          s.totalOpenInbound > s.inboundWithinLeadTime
            ? `${s.inboundWithinLeadTime} arrives within lead time · ${s.totalOpenInbound - s.inboundWithinLeadTime} more after`
            : 'Inbound arriving within lead time'
        }
      >
        {s.inboundWithinLeadTime > 0 ? (
          <span className="text-emerald-700">+{s.inboundWithinLeadTime}</span>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td
        className={cn('px-3 py-2 text-right tabular-nums font-medium', stockTone)}
        title="Available to promise = on-hand + inbound within lead time"
      >
        {s.effectiveStock}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
        {s.velocity}/d
        {s.forecastSource === 'TRAILING_VELOCITY' && (
          <span className="ml-1 text-[10px] text-slate-400">trailing</span>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
        {s.daysOfStockLeft != null ? `${s.daysOfStockLeft}d` : '∞'}
      </td>
      <td
        className="px-3 py-2 text-right tabular-nums text-slate-500"
        title={`source: ${s.leadTimeSource.toLowerCase().replace(/_/g, ' ')}`}
      >
        {s.leadTimeDays}d
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
        {forecastBand ?? <span className="text-slate-400">—</span>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">
        {s.reorderQuantity}
      </td>
      <td className="px-3 py-2 text-right">
        {s.needsReorder ? (
          <button
            onClick={onDraftPo}
            className="h-7 px-2 text-[11px] bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1"
          >
            {s.isManufactured ? (
              <>
                <Factory size={11} /> WO
              </>
            ) : (
              <>
                <ShoppingCart size={11} /> PO
              </>
            )}
          </button>
        ) : (
          <span className="text-[10px] text-slate-400">OK</span>
        )}
      </td>
      <td className="px-3 py-2">
        <button
          onClick={onOpenDrawer}
          className="text-slate-400 hover:text-slate-700"
          aria-label="Open detail"
        >
          <ChevronRight size={14} />
        </button>
      </td>
    </tr>
  )
}

interface DetailResponse {
  product: { id: string; sku: string; name: string; currentStock: number }
  atp: {
    leadTimeDays: number
    leadTimeSource: string
    inboundWithinLeadTime: number
    totalOpenInbound: number
    openShipments: OpenShipmentRef[]
    // R.2 — multi-location additions
    byLocation?: Array<{
      locationId: string
      locationCode: string
      locationName: string
      locationType: string
      servesMarketplaces: string[]
      quantity: number
      reserved: number
      available: number
    }>
    totalQuantity?: number
    totalAvailable?: number
    stockSource?: string
  } | null
  // R.2 — per-channel cover breakdown
  channelCover?: Array<{
    channel: string
    marketplace: string
    velocityPerDay: number
    available: number
    locationCode: string | null
    source: string
    daysOfCover: number | null
  }>
  // R.4 — math snapshot from the latest ACTIVE recommendation
  recommendation?: {
    id: string
    urgency: string
    reorderPoint: number
    reorderQuantity: number
    safetyStockUnits: number | null
    eoqUnits: number | null
    constraintsApplied: string[]
    unitCostCents: number | null
    velocity: number | string
    generatedAt: string
    // R.14 — urgency provenance
    urgencySource?: string | null
    worstChannelKey?: string | null
    worstChannelDaysOfCover?: number | null
    // R.11 — σ_LT applied
    leadTimeStdDevDays?: number | string | null
    // R.15 — FX context
    unitCostCurrency?: string | null
    fxRateUsed?: number | string | null
    // R.17 — substitution audit
    rawVelocity?: number | string | null
    substitutionAdjustedDelta?: number | string | null
  } | null
  model: string | null
  generationTag: string | null
  signals: any
  series: Array<{
    day: string
    actual: number | null
    forecast: number | null
    lower80: number | null
    upper80: number | null
  }>
  // R.17 — substitution links visible from this product (either side).
  substitutions?: Array<{
    id: string
    primaryProductId: string
    substituteProductId: string
    substitutionFraction: number | string
    primary?: { id: string; sku: string; name: string } | null
    substitute?: { id: string; sku: string; name: string } | null
  }>
}

function ForecastDetailDrawer({
  productId,
  marketplace,
  channel,
  onClose,
}: {
  productId: string
  marketplace: string | null
  channel: string | null
  onClose: () => void
}) {
  const [detail, setDetail] = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  // R.5 — error state. Pre-R.5 a fetch failure left the spinner
  // running indefinitely; now we render an error panel with retry.
  const [error, setError] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const params = new URLSearchParams()
    if (channel) params.set('channel', channel)
    if (marketplace) params.set('marketplace', marketplace)
    fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/${productId}/forecast-detail${
        params.toString() ? `?${params.toString()}` : ''
      }`,
      { cache: 'no-store' },
    )
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load (${r.status})`)
        return r.json()
      })
      .then((j) => {
        if (cancelled) return
        setDetail(j)
      })
      .catch((e: Error) => {
        if (cancelled) return
        setError(e.message)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [productId, channel, marketplace, retryTick])

  return (
    <div className="fixed inset-0 z-50 flex">
      <div
        className="flex-1 bg-slate-900/30 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="w-full max-w-2xl bg-white border-l border-slate-200 shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <div className="min-w-0">
            {detail ? (
              <>
                <div className="text-[14px] font-semibold text-slate-900 truncate">
                  {detail.product.name}
                </div>
                <div className="text-[11px] text-slate-500 font-mono">
                  {detail.product.sku}
                </div>
              </>
            ) : (
              <div className="text-[13px] text-slate-500">Loading detail…</div>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading && !error && (
            <div className="text-[13px] text-slate-500 inline-flex items-center gap-2 py-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading forecast…
            </div>
          )}
          {/* R.5 — error UI with retry. Pre-R.5 a fetch failure left
              the spinner running indefinitely. */}
          {!loading && error && (
            <div className="bg-rose-50 border border-rose-200 rounded p-4 text-[13px] text-rose-800">
              <div className="flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold mb-1">Couldn't load forecast detail</div>
                  <div className="text-[12px] mb-3">{error}</div>
                  <button
                    onClick={() => setRetryTick((n) => n + 1)}
                    className="h-7 px-2.5 text-[11px] bg-rose-600 text-white rounded hover:bg-rose-700 inline-flex items-center gap-1"
                  >
                    <RefreshCw size={11} /> Retry
                  </button>
                </div>
              </div>
            </div>
          )}
          {!loading && !error && detail && (
            <>
              {/* 90-day chart */}
              <div>
                <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
                  60-day actual + 90-day forecast
                </div>
                <div className="h-56 w-full">
                  <ResponsiveContainer>
                    <ComposedChart data={detail.series} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
                      <CartesianGrid stroke="#eef2f7" vertical={false} />
                      <XAxis
                        dataKey="day"
                        tick={{ fontSize: 10, fill: '#64748b' }}
                        tickFormatter={(v) => v.slice(5)}
                        minTickGap={24}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: '#64748b' }}
                        width={28}
                      />
                      <Tooltip
                        contentStyle={{ fontSize: 11 }}
                        formatter={(v: any) => (typeof v === 'number' ? v.toFixed(1) : v)}
                      />
                      <ReferenceLine
                        x={detail.series.find((p) => p.forecast != null)?.day}
                        stroke="#94a3b8"
                        strokeDasharray="4 4"
                        label={{
                          value: 'today',
                          fontSize: 10,
                          fill: '#64748b',
                          position: 'insideTopRight',
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="upper80"
                        stroke="none"
                        fill="#bfdbfe"
                        fillOpacity={0.3}
                      />
                      <Area
                        type="monotone"
                        dataKey="lower80"
                        stroke="none"
                        fill="#ffffff"
                        fillOpacity={1}
                      />
                      <Line
                        type="monotone"
                        dataKey="actual"
                        stroke="#0f172a"
                        strokeWidth={1.5}
                        dot={false}
                        connectNulls={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="forecast"
                        stroke="#3b82f6"
                        strokeWidth={1.5}
                        dot={false}
                        connectNulls={false}
                        strokeDasharray="3 3"
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-1 flex items-center gap-3 text-[11px] text-slate-500">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-3 h-px bg-slate-900" /> actual
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-3 h-px border-t border-dashed border-blue-500" /> forecast
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-3 h-2 bg-blue-200 rounded-sm" /> 80% interval
                  </span>
                  {detail.generationTag && (
                    <span className="ml-auto text-[10px] uppercase tracking-wider text-amber-700">
                      {detail.generationTag.replace(/_/g, ' ').toLowerCase()}
                    </span>
                  )}
                </div>
              </div>

              {/* R.2 — per-location stock breakdown + ATP totals */}
              {detail.atp && (
                <StockByLocationPanel atp={detail.atp} />
              )}

              {/* R.14 — channel-driven urgency banner. Renders only
                  when the worst channel pushed urgency above what the
                  global aggregate would have shown. Tells operators
                  why the headline is more severe than the totals
                  suggest. */}
              {detail.recommendation?.urgencySource === 'CHANNEL' &&
                detail.recommendation?.worstChannelKey && (
                <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-800">
                  <span className="font-semibold">{detail.recommendation.urgency}</span>{' '}
                  driven by{' '}
                  <span className="font-mono">
                    {detail.recommendation.worstChannelKey.replace(':', ' · ')}
                  </span>
                  {' '}({detail.recommendation.worstChannelDaysOfCover}d cover).
                  Aggregate stock looks fine, but this channel is at risk.
                </div>
              )}

              {/* R.2 — per-channel days-of-cover */}
              {detail.channelCover && detail.channelCover.length > 0 && (
                <ChannelCoverPanel
                  channelCover={detail.channelCover}
                  leadTimeDays={detail.atp?.leadTimeDays ?? 14}
                />
              )}

              {/* R.4 — reorder math snapshot. Shows EOQ, safety stock,
                  reorder point, and any MOQ/case-pack constraints
                  that bumped the final qty up. */}
              {detail.recommendation && (
                <ReorderMathPanel rec={detail.recommendation} />
              )}

              {/* R.17 — substitution links + raw-vs-adjusted velocity. */}
              <SubstitutionPanel
                productId={productId}
                rec={detail.recommendation}
                substitutions={detail.substitutions ?? []}
                onChanged={async () => {
                  const params = new URLSearchParams()
                  if (marketplace) params.set('marketplace', marketplace)
                  if (channel) params.set('channel', channel)
                  const r = await fetch(
                    `${getBackendUrl()}/api/fulfillment/replenishment/${productId}/forecast-detail${
                      params.toString() ? `?${params.toString()}` : ''
                    }`,
                  )
                  if (r.ok) setDetail(await r.json())
                }}
              />


              {/* Open shipments */}
              {detail.atp && detail.atp.openShipments.length > 0 && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2">
                    Open inbound shipments
                  </div>
                  <div className="border border-slate-200 rounded overflow-hidden">
                    {detail.atp.openShipments.map((sh) => (
                      <div
                        key={sh.shipmentId}
                        className="flex items-center justify-between px-3 py-1.5 text-[12px] border-b border-slate-100 last:border-0"
                      >
                        <div>
                          <span className="font-mono text-[11px] text-slate-700">
                            {sh.reference ?? sh.shipmentId.slice(-8)}
                          </span>
                          <span className="ml-2 text-[10px] uppercase tracking-wider text-slate-500">
                            {sh.type} · {sh.status}
                          </span>
                        </div>
                        <div className="text-slate-700 tabular-nums">
                          +{sh.remainingUnits} units
                          {sh.expectedAt && (
                            <span className="ml-2 text-[11px] text-slate-500">
                              {new Date(sh.expectedAt)
                                .toISOString()
                                .slice(0, 10)}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Signals breakdown */}
              {detail.signals && typeof detail.signals === 'object' && (
                <SignalsPanel signals={detail.signals} />
              )}

              {/* R.1 — Forecast accuracy. Below signals so the reading
                  flow is prediction → causal → retrospective. */}
              <ForecastAccuracyCard
                sku={detail.product?.sku ?? null}
                channel={null}
                marketplace={null}
              />

              {/* R.3 — Recommendation history. Audit trail of every
                  recommendation we've ever shown for this product +
                  the POs/WOs that came from them. Collapsed by
                  default; expand to load. */}
              <RecommendationHistoryCard productId={detail.product?.id ?? null} />

              {/* Model */}
              {detail.model && (
                <div className="text-[11px] text-slate-500">
                  Generated by{' '}
                  <span className="font-mono text-slate-700">{detail.model}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SignalsPanel({ signals }: { signals: any }) {
  const { combined, holiday, weather, retail, notes } = signals
  if (
    typeof combined !== 'number' ||
    (combined === 1 && holiday === 1 && weather === 1 && retail === 1)
  ) {
    return (
      <div>
        <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
          External signals
        </div>
        <div className="text-[12px] text-slate-500">
          Neutral — baseline forecast applies.
        </div>
      </div>
    )
  }
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2">
        External signals (combined ×
        <span className="font-mono text-slate-700 ml-1">
          {Number(combined).toFixed(2)}
        </span>
        )
      </div>
      <div className="grid grid-cols-3 gap-2 mb-2 text-[12px]">
        <SignalChip label="Holiday" factor={holiday} />
        <SignalChip label="Weather" factor={weather} />
        <SignalChip label="Retail" factor={retail} />
      </div>
      {Array.isArray(notes) && notes.length > 0 && (
        <ul className="text-[11px] text-slate-600 space-y-0.5">
          {notes.slice(0, 5).map((n: any, i: number) => (
            <li key={i} className="inline-flex items-center gap-1">
              <span className="text-slate-400 capitalize">{n.source}:</span>
              <span>{n.description}</span>
              <span className="ml-auto font-mono text-slate-500">
                ×{Number(n.factor).toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SignalChip({ label, factor }: { label: string; factor: number }) {
  const tone =
    factor > 1.05
      ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
      : factor < 0.95
      ? 'text-rose-700 bg-rose-50 border-rose-200'
      : 'text-slate-600 bg-slate-50 border-slate-200'
  return (
    <div className={cn('border rounded px-2 py-1 text-[11px]', tone)}>
      <div className="uppercase tracking-wider text-[9px] font-semibold opacity-70">
        {label}
      </div>
      <div className="tabular-nums font-semibold">
        ×{Number(factor).toFixed(2)}
      </div>
    </div>
  )
}

// R.2 — Per-location stock breakdown for the drawer. Replaces the
// old "On-hand / Inbound / ATP" 3-column block. Surfaces every
// StockLocation row for this product with quantity / reserved /
// available + the marketplaces it serves. Falls back to an amber
// warning when stockSource='PRODUCT_TOTAL_STOCK_FALLBACK' (legacy
// product without StockLevel rows yet).
function StockByLocationPanel({ atp }: { atp: any }) {
  const byLocation: Array<any> = atp.byLocation ?? []
  const totalAvailable: number = atp.totalAvailable ?? 0
  const inboundLT: number = atp.inboundWithinLeadTime ?? 0
  const stockSource: string = atp.stockSource ?? 'STOCK_LEVEL'
  const isFallback = stockSource === 'PRODUCT_TOTAL_STOCK_FALLBACK'

  return (
    <div className="border border-slate-200 rounded p-3 bg-slate-50/50">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
          Stock by location
        </div>
        <div className="text-[10px] text-slate-500">
          Lead time:{' '}
          <span className="font-semibold text-slate-700">{atp.leadTimeDays}d</span>{' '}
          <span className="font-mono text-[10px]">
            ({String(atp.leadTimeSource).toLowerCase().replace(/_/g, ' ')})
          </span>
        </div>
      </div>

      {isFallback && (
        <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mb-2">
          This product hasn't been migrated to per-location tracking yet.
          Totals below are inferred from <span className="font-mono">Product.totalStock</span>;
          reconcile via the Stock workspace for accurate numbers.
        </div>
      )}

      {byLocation.length === 0 ? (
        <div className="text-[12px] text-slate-500 italic py-2">
          No stock at any location. Receive inventory or update via Stock workspace.
        </div>
      ) : (
        <ul className="space-y-1.5 text-[12px]">
          {byLocation.map((loc: any) => (
            <li key={loc.locationId} className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[11px] text-slate-700 truncate">{loc.locationCode}</div>
                <div className="text-[10px] text-slate-500 truncate">
                  {String(loc.locationType).toLowerCase().replace('_', ' ')}
                  {loc.servesMarketplaces && loc.servesMarketplaces.length > 0 && (
                    <span> · {loc.servesMarketplaces.join(', ')}</span>
                  )}
                </div>
              </div>
              <div className="text-right tabular-nums flex-shrink-0">
                <div className="font-semibold text-slate-900">{loc.available}</div>
                {loc.reserved > 0 && (
                  <div className="text-[10px] text-slate-500">
                    {loc.quantity} − {loc.reserved} reserved
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 pt-2 border-t border-slate-200 grid grid-cols-3 gap-2 text-[12px]">
        <div>
          <div className="uppercase tracking-wider text-[9px] text-slate-500 font-semibold">Available</div>
          <div className="tabular-nums font-semibold text-slate-900">{totalAvailable}</div>
        </div>
        <div>
          <div className="uppercase tracking-wider text-[9px] text-slate-500 font-semibold">Inbound (LT)</div>
          <div className="tabular-nums font-semibold text-emerald-700">+{inboundLT}</div>
        </div>
        <div>
          <div className="uppercase tracking-wider text-[9px] text-slate-500 font-semibold">ATP</div>
          <div className="tabular-nums font-bold text-slate-900">{totalAvailable + inboundLT}</div>
        </div>
      </div>
    </div>
  )
}

// R.2 — Per-channel days-of-cover panel. For each (channel,
// marketplace) tuple this product sold on, shows velocity, the
// matching stock pool's available units, and the resulting days of
// cover. Tone follows urgency: red ≤ leadTime, amber ≤ 2×leadTime,
// slate beyond. Source pill flags fallback resolutions ("default
// warehouse" or "no location") so the operator knows which channels
// are running on inferred location mappings.
function ChannelCoverPanel({
  channelCover,
  leadTimeDays,
}: {
  channelCover: Array<any>
  leadTimeDays: number
}) {
  if (channelCover.length === 0) return null
  const maxBar = Math.max(...channelCover.map((c: any) => c.daysOfCover ?? 0), leadTimeDays * 4)

  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2">
        Days of cover by channel
      </div>
      <ul className="space-y-1.5 text-[12px]">
        {channelCover.map((c: any, i: number) => {
          const tone =
            c.daysOfCover == null
              ? 'bg-slate-50 border-slate-200 text-slate-500'
              : c.daysOfCover <= leadTimeDays
              ? 'bg-rose-50 border-rose-200 text-rose-700'
              : c.daysOfCover <= leadTimeDays * 2
              ? 'bg-amber-50 border-amber-200 text-amber-800'
              : 'bg-slate-50 border-slate-200 text-slate-700'
          const barWidth = c.daysOfCover != null
            ? Math.min(100, Math.round((c.daysOfCover / maxBar) * 100))
            : 0
          return (
            <li key={i} className={cn('border rounded px-2 py-1.5', tone)}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-mono text-[11px]">
                    {c.channel} · {c.marketplace}
                  </span>
                  {c.source !== 'EXACT_MATCH' && (
                    <span className="ml-1 text-[9px] uppercase tracking-wider opacity-70">
                      {c.source === 'WAREHOUSE_DEFAULT' ? '(default WH)' : '(no location)'}
                    </span>
                  )}
                </div>
                <div className="tabular-nums text-[11px] flex-shrink-0">
                  {c.available} ÷ {c.velocityPerDay}/d ={' '}
                  <span className="font-semibold">
                    {c.daysOfCover == null ? '—' : `${c.daysOfCover}d`}
                  </span>
                </div>
              </div>
              {c.daysOfCover != null && c.velocityPerDay > 0 && (
                <div className="mt-1 h-1 bg-white/60 rounded overflow-hidden">
                  <div
                    className={cn(
                      'h-full',
                      c.daysOfCover <= leadTimeDays ? 'bg-rose-500'
                        : c.daysOfCover <= leadTimeDays * 2 ? 'bg-amber-500'
                        : 'bg-slate-400',
                    )}
                    style={{ width: `${barWidth}%` }}
                  />
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// R.16 — Forecast model A/B card. Shows current champion + any
// rolled-out challengers with cohort sizes. Renders only when the
// system has a challenger active (silent until A/B testing is
// kicked off via the rollout endpoint).
function ForecastModelsCard() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/fulfillment/replenishment/forecast-models/active`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading || !data) return null
  const challengers: Array<{ modelId: string; skuCount: number }> = data.challengers ?? []
  if (challengers.length === 0) return null  // silent in champion-only state

  return (
    <Card>
      <div>
        <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
          Forecast model A/B
        </div>
        <div className="mt-1 flex items-baseline gap-3 flex-wrap">
          <span className="text-[12px] text-slate-700">
            Champion: <span className="font-mono">{data.champion?.modelId ?? data.defaultModelId}</span>
            <span className="text-slate-500 ml-1">({data.champion?.skuCount ?? 0} SKUs)</span>
          </span>
          {challengers.map((c) => (
            <span key={c.modelId} className="text-[12px] text-violet-700">
              Challenger: <span className="font-mono">{c.modelId}</span>
              <span className="text-violet-500 ml-1">({c.skuCount} SKUs)</span>
            </span>
          ))}
        </div>
        <div className="text-[10px] text-slate-500 mt-0.5">
          Compare MAPE per model in the Forecast Health card. Promote via
          <span className="font-mono"> POST /forecast-models/promote</span>.
        </div>
      </div>
    </Card>
  )
}

// R.12 — Stockout impact card. Workspace-level summary of YTD/30d
// stockouts + estimated lost margin/revenue. Renders only when there's
// data; silent during pre-launch when nothing's actually stocked out.
function StockoutImpactCard() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)
  useEffect(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/fulfillment/replenishment/stockouts/summary?windowDays=30`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [refreshTick])

  if (loading || !data) return null
  // Silent on no data — the page already has plenty of content.
  if (data.eventsInWindow === 0 && data.openCount === 0) return null

  const lostRev = data.totalLostRevenueCents / 100
  const lostMargin = data.totalLostMarginCents / 100

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
            Stockout impact (last {data.windowDays} days)
          </div>
          <div className="mt-1 flex items-baseline gap-3 flex-wrap">
            <span className="text-[20px] font-semibold tabular-nums text-rose-700">
              {lostMargin.toFixed(0)}€ lost margin
            </span>
            {data.openCount > 0 && (
              <span className="text-[11px] text-rose-700 font-semibold">
                {data.openCount} ongoing
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {data.eventsInWindow} event{data.eventsInWindow === 1 ? '' : 's'} ·{' '}
            {Number(data.totalDurationDays).toFixed(1)} days total ·{' '}
            {data.totalLostUnits} units lost ·{' '}
            {lostRev.toFixed(0)}€ lost revenue
          </div>
          {data.worstSku && (
            <div className="text-[11px] text-slate-500 mt-0.5">
              Worst: <span className="font-mono">{data.worstSku.sku}</span>
              {' '}({Number(data.worstSku.durationDays).toFixed(1)}d
              {data.worstSku.estimatedLostMargin != null
                ? `, ${(data.worstSku.estimatedLostMargin / 100).toFixed(0)}€ lost`
                : ''})
            </div>
          )}
        </div>
        <button
          onClick={() => setRefreshTick((n) => n + 1)}
          className="h-7 px-2 text-[11px] border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1"
          title="Refresh"
        >
          <RefreshCw size={11} /> Refresh
        </button>
      </div>
    </Card>
  )
}

// R.4 — Reorder math snapshot panel. Shows the four primitives
// (EOQ, safety stock, reorder point, recommended qty) plus the
// constraint annotations explaining why the final qty is what it
// is. Pulled from the latest ACTIVE ReplenishmentRecommendation.
function ReorderMathPanel({ rec }: { rec: NonNullable<DetailResponse['recommendation']> }) {
  const constraints = rec.constraintsApplied ?? []
  const hasMoq = constraints.includes('MOQ_APPLIED')
  const hasCasePack = constraints.includes('CASE_PACK_ROUNDED_UP')
  const hasEoqBelowMoq = constraints.includes('EOQ_BELOW_MOQ')

  return (
    <div className="border border-slate-200 rounded p-3 bg-slate-50/50">
      <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2">
        Reorder math
      </div>
      <div className="grid grid-cols-2 gap-y-1.5 gap-x-4 text-[12px]">
        <div className="flex items-center justify-between">
          <span className="text-slate-500">EOQ</span>
          <span className="tabular-nums font-semibold text-slate-900">
            {rec.eoqUnits != null ? rec.eoqUnits : '—'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-slate-500">Safety stock</span>
          <span className="tabular-nums font-semibold text-slate-900">
            {rec.safetyStockUnits != null ? rec.safetyStockUnits : '—'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-slate-500">Reorder point</span>
          <span className="tabular-nums font-semibold text-slate-900">
            {rec.reorderPoint}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-slate-500">Recommended qty</span>
          <span className="tabular-nums font-bold text-slate-900">
            {rec.reorderQuantity}
          </span>
        </div>
      </div>
      {(hasMoq || hasCasePack || hasEoqBelowMoq) && (
        <ul className="mt-2 pt-2 border-t border-slate-200 space-y-0.5 text-[11px] text-slate-600">
          {hasEoqBelowMoq && (
            <li>↑ EOQ was below supplier MOQ — ordering more than the math optimum</li>
          )}
          {hasMoq && <li>↑ rounded up to supplier MOQ</li>}
          {hasCasePack && <li>↑ rounded up to case-pack multiple</li>}
        </ul>
      )}
      {rec.unitCostCents != null && (
        <div className="mt-2 pt-2 border-t border-slate-200 text-[10px] text-slate-500">
          {/* R.15 — show native currency + EUR conversion when supplier
              quotes in something other than EUR. */}
          {rec.unitCostCurrency && rec.unitCostCurrency !== 'EUR' && rec.fxRateUsed ? (
            <>
              Cost basis: <span className="font-mono">
                {(rec.unitCostCents / 100).toFixed(2)} {rec.unitCostCurrency}/unit
              </span>
              <span className="text-slate-400 ml-1">
                (≈{(rec.unitCostCents / 100 / Number(rec.fxRateUsed)).toFixed(2)} EUR
                @ 1 EUR = {Number(rec.fxRateUsed).toFixed(4)} {rec.unitCostCurrency})
              </span>
            </>
          ) : (
            <>
              Cost basis: <span className="font-mono">
                {(rec.unitCostCents / 100).toFixed(2)} EUR/unit
              </span>
            </>
          )}
        </div>
      )}
      {/* R.11 — supplier lead-time variance applied. Renders only when
          σ_LT > 0 (the supplier has ≥3 PO observations); otherwise the
          formula collapses to deterministic-LT and there's nothing to
          show. */}
      {rec.leadTimeStdDevDays != null && Number(rec.leadTimeStdDevDays) > 0 && (
        <div className="mt-1 text-[10px] text-slate-500">
          Lead-time variance: <span className="font-mono">σ_LT = {Number(rec.leadTimeStdDevDays).toFixed(2)}d</span>
          <span className="text-slate-400"> · safety stock includes σ_LT term</span>
        </div>
      )}
    </div>
  )
}

// R.17 — Substitution panel. Shows raw vs adjusted velocity and the
// list of products this SKU substitutes for (or is substituted by),
// with inline fraction edit + add/delete.
function SubstitutionPanel({
  productId,
  rec,
  substitutions,
  onChanged,
}: {
  productId: string
  rec: DetailResponse['recommendation']
  substitutions: NonNullable<DetailResponse['substitutions']>
  onChanged: () => void | Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [newSku, setNewSku] = useState('')
  const [newRole, setNewRole] = useState<'PRIMARY' | 'SUBSTITUTE'>('PRIMARY')
  const [newFraction, setNewFraction] = useState('0.5')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const raw = rec?.rawVelocity != null ? Number(rec.rawVelocity) : null
  const delta = rec?.substitutionAdjustedDelta != null ? Number(rec.substitutionAdjustedDelta) : null
  const adjusted = raw != null && delta != null ? raw + delta : null

  async function handleAdd() {
    setBusy(true); setError(null)
    try {
      const fraction = Number(newFraction)
      if (!(fraction > 0 && fraction <= 1)) throw new Error('fraction must be in (0, 1]')
      const otherSku = newSku.trim()
      if (!otherSku) throw new Error('SKU required')
      const body = newRole === 'PRIMARY'
        ? { primarySku: otherSku, substituteProductId: productId, substitutionFraction: fraction }
        : { primaryProductId: productId, substituteSku: otherSku, substitutionFraction: fraction }
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/replenishment/substitutions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      setNewSku(''); setNewFraction('0.5'); setAdding(false)
      await onChanged()
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleUpdateFraction(id: string, fraction: number) {
    if (!(fraction > 0 && fraction <= 1)) return
    setBusy(true)
    try {
      await fetch(`${getBackendUrl()}/api/fulfillment/replenishment/substitutions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ substitutionFraction: fraction }),
      })
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(id: string) {
    setBusy(true)
    try {
      await fetch(`${getBackendUrl()}/api/fulfillment/replenishment/substitutions/${id}`, {
        method: 'DELETE',
      })
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-900">Substitution-aware demand</h4>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="text-xs text-indigo-600 hover:underline"
        >
          {adding ? 'cancel' : '+ link'}
        </button>
      </div>

      {raw != null && adjusted != null && (
        <div className="mb-3 grid grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-slate-500">Raw velocity</div>
            <div className="font-mono text-slate-900">{raw.toFixed(2)}/d</div>
          </div>
          <div>
            <div className="text-slate-500">Adjusted</div>
            <div className="font-mono text-slate-900">{adjusted.toFixed(2)}/d</div>
          </div>
          <div>
            <div className="text-slate-500">Δ</div>
            <div className={`font-mono ${delta! > 0 ? 'text-emerald-700' : delta! < 0 ? 'text-amber-700' : 'text-slate-700'}`}>
              {delta! > 0 ? '+' : ''}{delta!.toFixed(2)}
            </div>
          </div>
        </div>
      )}

      {adding && (
        <div className="mb-3 rounded border border-slate-200 bg-slate-50 p-2 text-xs">
          <div className="mb-2 grid grid-cols-3 gap-2">
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as any)}
              className="rounded border border-slate-300 px-1 py-0.5"
            >
              <option value="PRIMARY">Primary is…</option>
              <option value="SUBSTITUTE">Substitute is…</option>
            </select>
            <input
              type="text"
              placeholder="other SKU"
              value={newSku}
              onChange={(e) => setNewSku(e.target.value)}
              className="rounded border border-slate-300 px-1 py-0.5 font-mono"
            />
            <input
              type="number"
              step="0.05"
              min="0.05"
              max="1"
              value={newFraction}
              onChange={(e) => setNewFraction(e.target.value)}
              className="rounded border border-slate-300 px-1 py-0.5"
            />
          </div>
          {error && <div className="mb-2 text-rose-600">{error}</div>}
          <button
            type="button"
            onClick={handleAdd}
            disabled={busy || !newSku.trim()}
            className="rounded bg-indigo-600 px-2 py-1 text-white disabled:opacity-50"
          >
            Save
          </button>
        </div>
      )}

      {substitutions.length === 0 ? (
        <p className="text-xs text-slate-500">
          No substitution links. Add one when stockouts on this SKU drive customers to a related product (or vice versa).
        </p>
      ) : (
        <ul className="space-y-1.5">
          {substitutions.map((s) => {
            const isSubstituteSide = s.substituteProductId === productId
            const other = isSubstituteSide ? s.primary : s.substitute
            return (
              <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
                <div className="flex-1 truncate">
                  <span className="text-slate-500">
                    {isSubstituteSide ? 'substitutes for' : 'substituted by'}
                  </span>{' '}
                  <span className="font-mono">{other?.sku ?? '(missing)'}</span>{' '}
                  <span className="text-slate-400">— {other?.name ?? ''}</span>
                </div>
                <input
                  type="number"
                  step="0.05"
                  min="0.05"
                  max="1"
                  defaultValue={Number(s.substitutionFraction)}
                  onBlur={(e) => {
                    const v = Number(e.target.value)
                    if (v !== Number(s.substitutionFraction)) handleUpdateFraction(s.id, v)
                  }}
                  className="w-16 rounded border border-slate-300 px-1 py-0.5 text-right font-mono"
                />
                <button
                  type="button"
                  onClick={() => handleDelete(s.id)}
                  className="text-rose-600 hover:underline"
                >
                  delete
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// R.3 — Recommendation history audit trail for the drawer. Shows a
// chronological list of every recommendation we've ever shown for
// this product, with status pills (ACTIVE / SUPERSEDED / ACTED) +
// urgency + qty + the resulting PO/WO when ACTED. Lazy-loaded on
// expand so closed drawers don't fire the request.
function RecommendationHistoryCard({ productId }: { productId: string | null }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !productId || data) return
    setLoading(true)
    fetch(`${getBackendUrl()}/api/fulfillment/replenishment/${productId}/history?limit=50`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [open, productId, data])

  if (!productId) return null

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold inline-flex items-center gap-1 hover:text-slate-700"
      >
        History {open ? '▾' : '▸'}
        {data?.history && (
          <span className="text-slate-400 normal-case font-normal">
            ({data.history.length})
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2">
          {loading && <div className="text-[12px] text-slate-400">Loading…</div>}
          {!loading && data?.history?.length === 0 && (
            <div className="text-[11px] text-slate-500 italic">
              No history yet — recommendations are persisted starting from this commit.
            </div>
          )}
          {!loading && data?.history?.length > 0 && (
            <ul className="space-y-1 text-[11px]">
              {data.history.slice(0, 5).map((h: any) => {
                const tone =
                  h.status === 'ACTIVE' ? 'bg-blue-50 border-blue-200 text-blue-700'
                  : h.status === 'ACTED' ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  : h.status === 'DISMISSED' ? 'bg-slate-100 border-slate-200 text-slate-500'
                  : 'bg-slate-50 border-slate-200 text-slate-600'
                return (
                  <li key={h.id} className="flex items-start gap-2 border border-slate-100 rounded px-2 py-1">
                    <span className="text-slate-500 tabular-nums w-28 flex-shrink-0">
                      {new Date(h.generatedAt).toISOString().slice(0, 16).replace('T', ' ')}
                    </span>
                    <span className={cn('text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border w-20 text-center flex-shrink-0', tone)}>
                      {h.status === 'SUPERSEDED' ? 'SUPER.' : h.status}
                    </span>
                    <span className="text-slate-700 flex-shrink-0">{h.urgency}</span>
                    <span className="text-slate-600 tabular-nums flex-shrink-0">qty {h.reorderQuantity}</span>
                    <span className="text-slate-500 tabular-nums flex-shrink-0">stock {h.effectiveStock}</span>
                    {h.actedAt && (h.resultingPoId || h.resultingWorkOrderId) && (
                      <span className="text-emerald-700 truncate">
                        → {h.resultingPoId ? 'PO ' : 'WO '}{(h.resultingPoId ?? h.resultingWorkOrderId).slice(-8)}
                        {h.overrideQuantity != null && h.overrideQuantity !== h.reorderQuantity && (
                          <span className="text-slate-500"> (override {h.reorderQuantity}→{h.overrideQuantity})</span>
                        )}
                      </span>
                    )}
                  </li>
                )
              })}
              {data.history.length > 5 && (
                <li className="text-[10px] text-slate-400 italic">
                  +{data.history.length - 5} more rows · paginated UI coming in R.5
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// R.1 — Forecast accuracy mini-card for the drawer. Shows rolling
// 30-day MAPE / MAE / 80%-band calibration plus a per-regime split
// (so we can see whether HOLT_WINTERS is actually beating the
// fallbacks for this SKU). Suppresses noisy numbers when sample
// count is too low to be statistically meaningful.
function ForecastAccuracyCard({
  sku,
  channel,
  marketplace,
}: {
  sku: string | null
  channel: string | null
  marketplace: string | null
}) {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    if (!sku) return
    setLoading(true)
    const qs = new URLSearchParams({ sku, windowDays: '30' })
    if (channel) qs.set('channel', channel)
    if (marketplace) qs.set('marketplace', marketplace)
    fetch(`${getBackendUrl()}/api/fulfillment/replenishment/forecast-accuracy?${qs.toString()}`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [sku, channel, marketplace])

  if (!sku) return null
  if (loading) {
    return (
      <div>
        <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Forecast accuracy (last 30d)</div>
        <div className="text-[12px] text-slate-400">Loading…</div>
      </div>
    )
  }
  if (!data) return null

  const sampleCount = data.sampleCount ?? 0
  if (sampleCount < 7) {
    return (
      <div>
        <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Forecast accuracy (last 30d)</div>
        <div className="text-[12px] text-slate-500 italic">
          Not enough history yet (n={sampleCount}). Need ≥7 days.
        </div>
      </div>
    )
  }

  const mape = data.mape == null ? '—' : `${Number(data.mape).toFixed(1)}%`
  const mae = data.mae == null ? '—' : `${Number(data.mae).toFixed(2)}`
  const cal = data.bandCalibration == null ? '—' : `${Number(data.bandCalibration).toFixed(0)}%`
  const regimes = Object.entries((data.byRegime ?? {}) as Record<string, any>)
    .filter(([, s]) => (s as any).sampleCount >= 3)
    .sort((a: any, b: any) => b[1].sampleCount - a[1].sampleCount)

  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
        Forecast accuracy (last 30d)
      </div>
      <div className="grid grid-cols-3 gap-2 text-[12px] mb-2">
        <div className="border border-slate-200 rounded px-2 py-1 bg-slate-50">
          <div className="uppercase tracking-wider text-[9px] text-slate-500 font-semibold">MAPE</div>
          <div className="tabular-nums font-semibold text-slate-900">{mape}</div>
        </div>
        <div className="border border-slate-200 rounded px-2 py-1 bg-slate-50">
          <div className="uppercase tracking-wider text-[9px] text-slate-500 font-semibold">MAE</div>
          <div className="tabular-nums font-semibold text-slate-900">{mae}</div>
        </div>
        <div className="border border-slate-200 rounded px-2 py-1 bg-slate-50">
          <div className="uppercase tracking-wider text-[9px] text-slate-500 font-semibold">Calibration</div>
          <div className="tabular-nums font-semibold text-slate-900">{cal} <span className="text-[9px] text-slate-500 font-normal">/ 80%</span></div>
        </div>
      </div>
      <div className="text-[10px] text-slate-500">n = {sampleCount} days</div>
      {regimes.length > 1 && (
        <div className="mt-2">
          <div className="uppercase tracking-wider text-[9px] text-slate-500 font-semibold mb-1">By regime</div>
          <ul className="space-y-0.5">
            {regimes.map(([key, s]: any) => (
              <li key={key} className="flex items-center justify-between text-[11px]">
                <span className="font-mono text-slate-700">{key}</span>
                <span className="tabular-nums text-slate-700">
                  {s.mape == null ? '—' : `${Number(s.mape).toFixed(1)}%`} <span className="text-slate-400">(n={s.sampleCount})</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// R.1 — workspace-level "Forecast health" card. Aggregate MAPE +
// per-regime breakdown + a tiny daily-MAPE trend sparkline. Sits
// alongside the urgency tiles so operators can spot model drift at
// a glance. Suppresses entirely when there's no data yet (cron
// hasn't run or pre-deploy state).
function ForecastHealthCard() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)
  useEffect(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/fulfillment/replenishment/forecast-accuracy/aggregate?windowDays=30&groupBy=regime`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [refreshTick])

  if (loading || !data?.overall) return null
  const sampleCount = data.overall.sampleCount ?? 0
  if (sampleCount === 0) return null

  const mape = data.overall.mape == null ? '—' : `${Number(data.overall.mape).toFixed(1)}%`
  const cal = data.overall.bandCalibration == null ? '—' : `${Number(data.overall.bandCalibration).toFixed(0)}%`
  const groups: Array<{ key: string; mape: number | null; sampleCount: number }> = data.groups ?? []
  const trend: Array<{ day: string; mape: number | null }> = data.trend ?? []
  const sparkPoints = trend.filter((t) => t.mape != null).map((t) => Number(t.mape))
  const sparkMax = sparkPoints.length > 0 ? Math.max(...sparkPoints, 1) : 1

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
            Forecast health (last 30d)
          </div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="text-[20px] font-semibold tabular-nums text-slate-900">{mape}</span>
            <span className="text-[11px] text-slate-500">MAPE · n={sampleCount}</span>
            <span className="text-[11px] text-slate-500">Calibration {cal} / 80%</span>
          </div>
          {data.worstSku && (
            <div className="text-[11px] text-slate-500 mt-0.5">
              Worst: <span className="font-mono">{data.worstSku.sku}</span> ({Number(data.worstSku.mape).toFixed(1)}% MAPE, n={data.worstSku.sampleCount})
            </div>
          )}
        </div>
        <button
          onClick={() => setRefreshTick((n) => n + 1)}
          className="h-7 px-2 text-[11px] border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1"
          title="Refresh"
        >
          <RefreshCw size={11} /> Refresh
        </button>
      </div>
      {groups.length > 0 && (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
          {groups.map((g) => (
            <div key={g.key} className="border border-slate-200 rounded px-2 py-1.5">
              <div className="uppercase tracking-wider text-[9px] text-slate-500 font-semibold">
                {g.key}
              </div>
              <div className="tabular-nums font-semibold text-slate-900 mt-0.5">
                {g.mape == null ? '—' : `${Number(g.mape).toFixed(1)}%`}
              </div>
              <div className="text-[10px] text-slate-500">n={g.sampleCount}</div>
            </div>
          ))}
        </div>
      )}
      {sparkPoints.length > 1 && (
        <div className="mt-3">
          <div className="uppercase tracking-wider text-[9px] text-slate-500 font-semibold mb-1">
            Daily MAPE trend
          </div>
          <svg viewBox={`0 0 ${sparkPoints.length * 8} 24`} className="w-full h-6">
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-blue-600"
              points={sparkPoints
                .map((p, i) => `${i * 8},${24 - (p / sparkMax) * 20}`)
                .join(' ')}
            />
          </svg>
        </div>
      )}
    </Card>
  )
}

function BulkPoModal({
  suggestions,
  onClose,
  onSuccess,
}: {
  suggestions: Suggestion[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      suggestions.map((s) => [s.productId, s.reorderQuantity]),
    ),
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // F.6 — After successful submit, hold the created POs locally so we can
  // render a results screen with per-PO "Download factory PDF" links
  // instead of the previous alert+close flow.
  const [createdPos, setCreatedPos] = useState<
    Array<{
      id: string
      poNumber: string
      supplierId: string | null
      supplierName: string | null
      supplierEmail: string | null
      itemCount: number
      totalUnits: number
    }> | null
  >(null)
  const [createdWorkOrders, setCreatedWorkOrders] = useState<
    Array<{ id: string; productId: string; quantity: number }> | null
  >(null)

  // Group by supplier so the user sees how many POs will get created.
  const grouped = useMemo(() => {
    const m = new Map<string, Suggestion[]>()
    for (const s of suggestions) {
      const key = s.preferredSupplierId ?? '__no_supplier__'
      const arr = m.get(key) ?? []
      arr.push(s)
      m.set(key, arr)
    }
    return m
  }, [suggestions])

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      // R.3 — link each PO line back to its source recommendation +
      // audit any quantity override (when user changed qty from the
      // suggested value).
      const items = suggestions.map((s) => {
        const finalQty = quantities[s.productId] ?? s.reorderQuantity
        const overridden = finalQty !== s.reorderQuantity
        return {
          productId: s.productId,
          quantity: finalQty,
          supplierId: s.preferredSupplierId,
          recommendationId: s.recommendationId ?? null,
          quantityOverride: overridden ? finalQty : null,
          overrideNotes: overridden
            ? `Operator override: ${s.reorderQuantity} → ${finalQty} via bulk PO modal`
            : null,
        }
      })
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/bulk-draft-po`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err?.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json()
      setCreatedPos(json.createdPos)
      setCreatedWorkOrders(json.createdWorkOrders ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const finishAndClose = () => {
    onSuccess()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative bg-white border border-slate-200 rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <div>
            <div className="text-[14px] font-semibold text-slate-900">
              {createdPos
                ? `Created ${createdPos.length} draft PO${createdPos.length === 1 ? '' : 's'}`
                : 'Bulk-create draft POs'}
            </div>
            <div className="text-[12px] text-slate-500 mt-0.5">
              {createdPos
                ? 'Review each PO and download the factory-ready PDF.'
                : `${suggestions.length} item${suggestions.length === 1 ? '' : 's'} · ${grouped.size} supplier${grouped.size === 1 ? '' : 's'} → one PO per supplier`}
            </div>
          </div>
          <button
            onClick={createdPos ? finishAndClose : onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* F.6 + Constraint #2/#5 — Success state with download links per
            PO, email-to-supplier mailto: action, and Work Order separation. */}
        {createdPos ? (
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            <div className="text-[12px] text-emerald-700 inline-flex items-center gap-1.5">
              <CheckCircle2 size={14} />
              <span>
                All POs land as DRAFT. Open each PDF, review with the factory,
                and submit when you're ready.
              </span>
            </div>

            {createdPos.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
                  Purchase orders
                </div>
                <div className="space-y-1.5">
                  {createdPos.map((po) => (
                    <PoSuccessRow key={po.id} po={po} />
                  ))}
                </div>
              </div>
            )}

            {createdWorkOrders && createdWorkOrders.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-violet-700 font-semibold mb-1.5 inline-flex items-center gap-1">
                  <Factory size={10} /> Work orders (manufactured items)
                </div>
                <div className="space-y-1.5">
                  {createdWorkOrders.map((wo) => (
                    <div
                      key={wo.id}
                      className="border border-violet-200 bg-violet-50/40 rounded px-3 py-2 flex items-center justify-between gap-3"
                    >
                      <div>
                        <div className="text-[12px] font-mono text-slate-900">
                          WO {wo.id.slice(-10)}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {wo.quantity} units · status PLANNED
                        </div>
                      </div>
                      <span className="text-[10px] uppercase tracking-wider font-semibold text-violet-700 bg-violet-100 border border-violet-200 px-1.5 py-0.5 rounded">
                        Manufacturing
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {Array.from(grouped.entries()).map(([supplierKey, items]) => (
            <div key={supplierKey} className="mb-3 last:mb-0">
              <div
                className={cn(
                  'text-[11px] uppercase tracking-wider font-semibold mb-1.5',
                  supplierKey === '__no_supplier__'
                    ? 'text-amber-700'
                    : 'text-slate-500',
                )}
              >
                {supplierKey === '__no_supplier__' ? (
                  <span className="inline-flex items-center gap-1">
                    <AlertCircle size={11} /> No supplier set —
                    grouped into a single PO you'll need to assign before submit
                  </span>
                ) : (
                  <>Supplier {supplierKey.slice(-8)} · {items.length} item{items.length === 1 ? '' : 's'}</>
                )}
              </div>
              <div className="border border-slate-200 rounded">
                {items.map((s) => (
                  <div
                    key={s.productId}
                    className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-slate-100 last:border-0 text-[12px]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-slate-800 truncate">{s.name}</div>
                      <div className="text-[10px] text-slate-500 font-mono">
                        {s.sku}
                      </div>
                    </div>
                    <input
                      type="number"
                      min={1}
                      value={quantities[s.productId] ?? s.reorderQuantity}
                      onChange={(e) =>
                        setQuantities((prev) => ({
                          ...prev,
                          [s.productId]:
                            parseInt(e.target.value, 10) || s.reorderQuantity,
                        }))
                      }
                      className="w-20 h-7 px-2 border border-slate-200 rounded text-[12px] tabular-nums text-right"
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        )}

        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between">
          {error ? (
            <span className="text-[12px] text-rose-700 inline-flex items-center gap-1">
              <AlertCircle size={12} /> {error}
            </span>
          ) : createdPos ? (
            <span className="text-[12px] text-slate-500 inline-flex items-center gap-1">
              <CheckCircle2 size={12} /> Done — close to refresh the workspace
            </span>
          ) : (
            <span className="text-[12px] text-slate-500 inline-flex items-center gap-1">
              <CheckCircle2 size={12} /> All POs land as DRAFT — review before
              submitting
            </span>
          )}
          <div className="flex items-center gap-2">
            {createdPos ? (
              <button
                onClick={finishAndClose}
                className="h-8 px-3 text-[12px] bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1.5"
              >
                <CheckCircle2 size={12} /> Close
              </button>
            ) : (
              <>
                <button
                  onClick={onClose}
                  disabled={submitting}
                  className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={submit}
                  disabled={submitting}
                  className="h-8 px-3 text-[12px] bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" /> Creating…
                    </>
                  ) : (
                    <>
                      <ShoppingCart size={12} /> Create {grouped.size} draft PO
                      {grouped.size === 1 ? '' : 's'}
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Constraint #2 — Per-PO success row with Factory PDF + Email supplier
// actions. Email path uses mailto: with subject + body pre-filled and a
// link to the PDF endpoint; user attaches the actual PDF manually
// (mailto: doesn't support attachments). Email button is disabled with
// a clear "no email on supplier" tooltip when supplier.email is missing.
function PoSuccessRow({
  po,
}: {
  po: {
    id: string
    poNumber: string
    supplierId: string | null
    supplierName: string | null
    supplierEmail: string | null
    itemCount: number
    totalUnits: number
  }
}) {
  const pdfUrl = `${getBackendUrl()}/api/fulfillment/purchase-orders/${po.id}/factory.pdf`
  const mailtoUrl = po.supplierEmail
    ? buildSupplierMailto({
        to: po.supplierEmail,
        supplierName: po.supplierName,
        poNumber: po.poNumber,
        itemCount: po.itemCount,
        totalUnits: po.totalUnits,
        pdfUrl,
      })
    : null
  const copyEmail = po.supplierEmail
    ? () => navigator.clipboard?.writeText(po.supplierEmail!)
    : null
  return (
    <div className="border border-slate-200 rounded px-3 py-2 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13px] font-mono font-medium text-slate-900">
          {po.poNumber}
        </div>
        <div className="text-[11px] text-slate-500">
          {po.itemCount} item{po.itemCount === 1 ? '' : 's'} · {po.totalUnits} units
          {po.supplierName ? (
            <> · {po.supplierName}</>
          ) : (
            <span className="text-amber-700"> · no supplier assigned</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {mailtoUrl ? (
          <a
            href={mailtoUrl}
            className="h-7 px-2.5 text-[12px] border border-slate-200 text-slate-700 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
            title={`Email ${po.supplierEmail}`}
          >
            <Mail size={12} /> Email
          </a>
        ) : (
          <button
            type="button"
            disabled
            className="h-7 px-2.5 text-[12px] border border-slate-200 text-slate-400 rounded cursor-not-allowed inline-flex items-center gap-1.5"
            title={
              po.supplierId
                ? 'Supplier has no email on file — set it in Suppliers'
                : 'No supplier assigned'
            }
          >
            <Mail size={12} /> Email
          </button>
        )}
        {copyEmail && (
          <button
            type="button"
            onClick={copyEmail}
            className="h-7 px-2 text-[12px] border border-slate-200 text-slate-500 rounded hover:bg-slate-50"
            title="Copy supplier email to clipboard"
          >
            <Copy size={12} />
          </button>
        )}
        <a
          href={pdfUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="h-7 px-3 text-[12px] bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1.5"
        >
          <FileText size={12} /> Factory PDF
        </a>
      </div>
    </div>
  )
}

// Builds a mailto: URL with subject + body pre-filled. Body includes a
// direct link to the PDF endpoint as a fallback for users who don't
// notice the manual-attach instruction. Encoding via encodeURIComponent
// per RFC 6068 — whitespace, line breaks, and special chars all valid.
function buildSupplierMailto(args: {
  to: string
  supplierName: string | null
  poNumber: string
  itemCount: number
  totalUnits: number
  pdfUrl: string
}): string {
  const subject = `Purchase Order ${args.poNumber}`
  const greeting = args.supplierName ? `Hi ${args.supplierName},` : 'Hello,'
  const body = [
    greeting,
    '',
    `Please find attached our purchase order ${args.poNumber} (${args.itemCount} line item${args.itemCount === 1 ? '' : 's'}, ${args.totalUnits} units total).`,
    '',
    `If the PDF didn't attach, you can also download it here:`,
    args.pdfUrl,
    '',
    'Please confirm receipt and the expected delivery date at your earliest convenience.',
    '',
    'Thank you,',
  ].join('\r\n')
  return (
    `mailto:${encodeURIComponent(args.to)}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`
  )
}
