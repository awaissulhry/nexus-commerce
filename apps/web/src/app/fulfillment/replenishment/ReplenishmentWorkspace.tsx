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

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Factory,
  FileWarning,
  Loader2,
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

export default function ReplenishmentWorkspace() {
  const [data, setData] = useState<ReplenishmentResponse | null>(null)
  const [events, setEvents] = useState<UpcomingEvent[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<
    'ALL' | 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'NEEDS_REORDER'
  >('NEEDS_REORDER')
  const [search, setSearch] = useState('')
  const [marketplaceFilter, setMarketplaceFilter] = useState<string>('')
  const [channelFilter, setChannelFilter] = useState<string>('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [drawerProductId, setDrawerProductId] = useState<string | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)

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
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      rows = rows.filter(
        (r) =>
          r.sku.toLowerCase().includes(q) || r.name.toLowerCase().includes(q),
      )
    }
    return rows
  }, [data, filter, search])

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
        alert(`Work order created for ${s.reorderQuantity} × ${s.sku}`)
        fetchData()
      } else alert('Work order create failed')
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
        }),
      },
    )
    if (res.ok) {
      const po = await res.json()
      alert(`Draft PO ${po.poNumber} created`)
      fetchData()
    } else {
      alert('Draft PO failed')
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
        <div className="ml-auto flex items-center gap-2">
          <Input
            placeholder="Search SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56"
          />
          <button
            onClick={fetchData}
            className="h-8 px-3 text-[12px] border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5"
          >
            <RefreshCw size={12} /> Refresh
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
        <Card noPadding>
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
                  <th className={th()}>Product</th>
                  <th className={th()}>Urgency</th>
                  <th className={thRight()}>On-hand</th>
                  <th className={thRight()}>Inbound (LT)</th>
                  <th className={thRight()}>ATP</th>
                  <th className={thRight()}>Velocity</th>
                  <th className={thRight()}>Days left</th>
                  <th className={thRight()}>Lead time</th>
                  <th className={thRight()}>Forecast (LT)</th>
                  <th className={thRight()}>Suggested qty</th>
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
        <span
          className={cn(
            'inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded',
            URGENCY_TONE[s.urgency],
          )}
        >
          {s.urgency}
        </span>
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

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams()
    if (channel) params.set('channel', channel)
    if (marketplace) params.set('marketplace', marketplace)
    fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/${productId}/forecast-detail${
        params.toString() ? `?${params.toString()}` : ''
      }`,
      { cache: 'no-store' },
    )
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        setDetail(j)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [productId, channel, marketplace])

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
          {loading && (
            <div className="text-[13px] text-slate-500 inline-flex items-center gap-2 py-6">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading forecast…
            </div>
          )}
          {!loading && detail && (
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

              {/* ATP composition */}
              {detail.atp && (
                <div className="border border-slate-200 rounded p-3 bg-slate-50/50">
                  <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2">
                    Available to promise
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-[12px]">
                    <Stat
                      label="On-hand"
                      value={detail.product.currentStock.toString()}
                    />
                    <Stat
                      label="Inbound (within lead time)"
                      value={`+${detail.atp.inboundWithinLeadTime}`}
                      tone="emerald"
                    />
                    <Stat
                      label="ATP"
                      value={(
                        detail.product.currentStock +
                        detail.atp.inboundWithinLeadTime
                      ).toString()}
                      bold
                    />
                  </div>
                  <div className="mt-2 text-[11px] text-slate-500">
                    Lead time:{' '}
                    <span className="font-semibold text-slate-700">
                      {detail.atp.leadTimeDays}d
                    </span>{' '}
                    <span className="font-mono text-[10px]">
                      ({detail.atp.leadTimeSource.toLowerCase().replace(/_/g, ' ')})
                    </span>
                  </div>
                </div>
              )}

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

function Stat({
  label,
  value,
  tone,
  bold,
}: {
  label: string
  value: string
  tone?: 'emerald' | 'rose'
  bold?: boolean
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div
        className={cn(
          'tabular-nums',
          bold ? 'text-[16px] font-semibold' : 'text-[14px]',
          tone === 'emerald'
            ? 'text-emerald-700'
            : tone === 'rose'
            ? 'text-rose-700'
            : 'text-slate-900',
        )}
      >
        {value}
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
      const items = suggestions.map((s) => ({
        productId: s.productId,
        quantity: quantities[s.productId] ?? s.reorderQuantity,
        supplierId: s.preferredSupplierId,
      }))
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
      const message =
        `Created ${json.createdPos.length} draft PO${json.createdPos.length === 1 ? '' : 's'} ` +
        `(${json.createdPos.map((p: any) => p.poNumber).join(', ')}). ` +
        `${json.itemsAccepted} items accepted` +
        (json.skipped.length ? `, ${json.skipped.length} skipped` : '') +
        '.'
      alert(message)
      onSuccess()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
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
              Bulk-create draft POs
            </div>
            <div className="text-[12px] text-slate-500 mt-0.5">
              {suggestions.length} item
              {suggestions.length === 1 ? '' : 's'} ·{' '}
              {grouped.size} supplier{grouped.size === 1 ? '' : 's'} → one PO
              per supplier
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
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
        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between">
          {error ? (
            <span className="text-[12px] text-rose-700 inline-flex items-center gap-1">
              <AlertCircle size={12} /> {error}
            </span>
          ) : (
            <span className="text-[12px] text-slate-500 inline-flex items-center gap-1">
              <CheckCircle2 size={12} /> All POs land as DRAFT — review before
              submitting
            </span>
          )}
          <div className="flex items-center gap-2">
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
          </div>
        </div>
      </div>
    </div>
  )
}
