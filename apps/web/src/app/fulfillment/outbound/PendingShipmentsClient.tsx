'use client'

// O.4 — Pending-shipment aggregation. THE cornerstone outbound surface:
// "what do I ship today, across all channels?" Renders orders that need
// a shipment created (status ∈ PENDING|PROCESSING, no active shipment),
// grouped by ship-by urgency, filterable by channel + marketplace,
// bulk-create-able. Drawer (per-order detail) lands in O.5.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Truck, Search, RefreshCw, Crown, AlertTriangle, Clock, Package, X, Plus,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'

type Urgency = 'OVERDUE' | 'TODAY' | 'TOMORROW' | 'THIS_WEEK' | 'LATER' | 'UNKNOWN'

type PendingOrder = {
  id: string
  channel: string
  marketplace: string | null
  channelOrderId: string
  status: string
  customerName: string
  customerEmail: string
  shippingAddress: { city?: string; country?: string; countryCode?: string } | any
  purchaseDate: string | null
  shipByDate: string | null
  earliestShipDate: string | null
  latestDeliveryDate: string | null
  fulfillmentLatency: number | null
  isPrime: boolean | null
  totalPrice: number
  currencyCode: string | null
  createdAt: string
  itemCount: number
  totalQuantity: number
  urgency: Urgency
  items: Array<{ id: string; sku: string; quantity: number; productId: string | null; price: number }>
}

type Counts = {
  overdue: number
  today: number
  tomorrow: number
  thisWeek: number
  later: number
  unknown: number
  byChannel: Record<string, number>
}

type Response = {
  items: PendingOrder[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  counts: Counts
}

const URGENCY_TONE: Record<Urgency, { tint: string; label: string; icon: typeof Clock }> = {
  OVERDUE: { tint: 'text-rose-700 bg-rose-50 border-rose-200', label: 'Overdue', icon: AlertTriangle },
  TODAY: { tint: 'text-amber-700 bg-amber-50 border-amber-200', label: 'Today', icon: Clock },
  TOMORROW: { tint: 'text-yellow-700 bg-yellow-50 border-yellow-200', label: 'Tomorrow', icon: Clock },
  THIS_WEEK: { tint: 'text-slate-700 bg-slate-50 border-slate-200', label: 'This week', icon: Clock },
  LATER: { tint: 'text-slate-500 bg-slate-50 border-slate-200', label: 'Later', icon: Clock },
  UNKNOWN: { tint: 'text-slate-500 bg-slate-50 border-slate-200', label: 'No deadline', icon: Clock },
}

const CHANNEL_LABEL: Record<string, string> = {
  AMAZON: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'Woo',
  ETSY: 'Etsy',
  MANUAL: 'Manual',
}

const URGENCY_FILTERS: Array<{ key: Urgency | 'ALL'; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'OVERDUE', label: 'Overdue' },
  { key: 'TODAY', label: 'Today' },
  { key: 'TOMORROW', label: 'Tomorrow' },
  { key: 'THIS_WEEK', label: 'This week' },
  { key: 'LATER', label: 'Later' },
  { key: 'UNKNOWN', label: 'No deadline' },
]

function formatRelative(d: string | null): string {
  if (!d) return '—'
  const t = new Date(d).getTime()
  const now = Date.now()
  const diffH = (t - now) / 3_600_000
  if (Math.abs(diffH) < 1) return 'now'
  if (diffH < 0) {
    const past = -diffH
    if (past < 24) return `${Math.round(past)}h late`
    return `${Math.round(past / 24)}d late`
  }
  if (diffH < 24) return `in ${Math.round(diffH)}h`
  if (diffH < 24 * 14) return `in ${Math.round(diffH / 24)}d`
  return new Date(d).toLocaleDateString()
}

function formatMoney(v: number, currency: string | null): string {
  const c = currency || 'EUR'
  try {
    return new Intl.NumberFormat('it-IT', { style: 'currency', currency: c }).format(v)
  } catch {
    return `${v.toFixed(2)} ${c}`
  }
}

export default function PendingShipmentsClient() {
  const router = useRouter()
  const params = useSearchParams()
  const { toast } = useToast()

  // URL-state-backed filters so a refresh / bookmark survives.
  const channelFilter = (params.get('channel') ?? '').split(',').filter(Boolean)
  const urgencyFilter = (params.get('urgency') as Urgency | 'ALL' | null) ?? 'ALL'
  const search = params.get('q') ?? ''
  const sort = (params.get('sort') as 'ship-by-asc' | 'value-desc' | 'age-desc' | null) ?? 'ship-by-asc'

  const [data, setData] = useState<Response | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [searchInput, setSearchInput] = useState(search)

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString())
      if (value == null || value === '' || value === 'ALL') next.delete(key)
      else next.set(key, value)
      router.replace(`?${next.toString()}`, { scroll: false })
    },
    [params, router],
  )

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (channelFilter.length) qs.set('channel', channelFilter.join(','))
      if (urgencyFilter && urgencyFilter !== 'ALL') qs.set('urgency', urgencyFilter)
      if (search) qs.set('search', search)
      if (sort) qs.set('sort', sort)
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/outbound/pending-orders?${qs.toString()}`,
        { cache: 'no-store' },
      )
      if (res.ok) setData(await res.json())
      else toast.error('Failed to load pending orders')
    } catch (e) {
      toast.error('Failed to load pending orders')
    } finally {
      setLoading(false)
    }
  }, [channelFilter.join(','), urgencyFilter, search, sort, toast])

  useEffect(() => { fetchData() }, [fetchData])

  // Debounced search → URL on Enter only (avoids URL-thrash while typing).
  const submitSearch = () => setParam('q', searchInput || null)

  const toggleChannel = (code: string) => {
    const next = new Set(channelFilter)
    next.has(code) ? next.delete(code) : next.add(code)
    setParam('channel', next.size ? Array.from(next).join(',') : null)
  }

  const toggleSelect = (id: string) => {
    const next = new Set(selected)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelected(next)
  }
  const toggleSelectAll = () => {
    if (!data) return
    if (data.items.every((o) => selected.has(o.id))) setSelected(new Set())
    else setSelected(new Set(data.items.map((o) => o.id)))
  }

  const bulkCreateShipments = async () => {
    if (selected.size === 0) {
      toast.error('Select orders first')
      return
    }
    setCreating(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/bulk-create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds: Array.from(selected) }),
      })
      const out = await res.json()
      if (!res.ok) {
        toast.error(out.error ?? 'Bulk create failed')
        return
      }
      const { created = 0, errors = [] } = out
      if (created === selected.size) {
        toast.success(`Created ${created} shipment${created === 1 ? '' : 's'}`)
      } else if (created > 0) {
        toast.warning(`Created ${created} of ${selected.size} (${errors.length} skipped)`)
      } else {
        toast.error(`No shipments created (${errors.length} errors)`)
      }
      setSelected(new Set())
      fetchData()
    } catch (e) {
      toast.error('Bulk create failed')
    } finally {
      setCreating(false)
    }
  }

  // Channel set we render as filter chips — derived from the response so
  // we only show channels that actually have pending orders.
  const channelChips = useMemo(() => {
    if (!data) return []
    return Object.entries(data.counts.byChannel).sort((a, b) => b[1] - a[1])
  }, [data])

  const allSelected = data && data.items.length > 0 && data.items.every((o) => selected.has(o.id))

  return (
    <div className="space-y-3">
      {/* ── Urgency filter row + counts ─────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        {URGENCY_FILTERS.map((f) => {
          const count =
            f.key === 'ALL'
              ? data?.total ?? 0
              : f.key === 'OVERDUE' ? data?.counts.overdue
              : f.key === 'TODAY' ? data?.counts.today
              : f.key === 'TOMORROW' ? data?.counts.tomorrow
              : f.key === 'THIS_WEEK' ? data?.counts.thisWeek
              : f.key === 'LATER' ? data?.counts.later
              : f.key === 'UNKNOWN' ? data?.counts.unknown
              : 0
          const isActive = urgencyFilter === f.key
          const isOverdue = f.key === 'OVERDUE' && (count ?? 0) > 0
          return (
            <button
              key={f.key}
              onClick={() => setParam('urgency', f.key === 'ALL' ? null : f.key)}
              className={`h-7 px-3 text-base border rounded-full inline-flex items-center gap-1.5 transition-colors ${
                isActive
                  ? 'bg-slate-900 text-white border-slate-900'
                  : isOverdue && !isActive
                  ? 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'
                  : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
              }`}
            >
              {f.label}
              {count != null && (
                <span className={`tabular-nums ${isActive ? 'text-slate-300' : 'text-slate-400'}`}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder="Order #, customer, SKU"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSearch()
                if (e.key === 'Escape') {
                  setSearchInput('')
                  setParam('q', null)
                }
              }}
              className="pl-7 w-64"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setParam('sort', e.target.value === 'ship-by-asc' ? null : e.target.value)}
            className="h-8 px-2 text-base border border-slate-200 rounded-md bg-white"
          >
            <option value="ship-by-asc">Ship by · soonest</option>
            <option value="value-desc">Value · highest</option>
            <option value="age-desc">Age · oldest</option>
          </select>
          <button
            onClick={fetchData}
            className="h-8 px-3 text-base border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      {/* ── Channel filter chips ────────────────────────────────────────── */}
      {channelChips.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-slate-500 uppercase tracking-wider">Channel</span>
          {channelChips.map(([code, count]) => {
            const isActive = channelFilter.includes(code)
            return (
              <button
                key={code}
                onClick={() => toggleChannel(code)}
                className={`h-6 px-2.5 text-sm border rounded-full inline-flex items-center gap-1 transition-colors ${
                  isActive
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
                }`}
              >
                {CHANNEL_LABEL[code] ?? code}
                <span className={`tabular-nums ${isActive ? 'text-blue-100' : 'text-slate-400'}`}>
                  {count}
                </span>
              </button>
            )
          })}
          {channelFilter.length > 0 && (
            <button
              onClick={() => setParam('channel', null)}
              className="h-6 px-2 text-sm text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
            >
              <X size={11} /> Clear
            </button>
          )}
        </div>
      )}

      {/* ── Bulk action bar ─────────────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-20">
          <Card>
            <div className="flex items-center gap-3">
              <span className="text-base font-semibold text-slate-700">
                {selected.size} selected
              </span>
              <div className="h-4 w-px bg-slate-200" />
              <button
                onClick={bulkCreateShipments}
                disabled={creating}
                className="h-7 px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Plus size={12} /> Create shipments ({selected.size})
              </button>
              <button
                onClick={() => setSelected(new Set())}
                className="ml-auto h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded"
              >
                <X size={14} />
              </button>
            </div>
          </Card>
        </div>
      )}

      {/* ── List ────────────────────────────────────────────────────────── */}
      {loading && !data ? (
        <Card>
          <div className="text-md text-slate-500 py-8 text-center">Loading pending orders…</div>
        </Card>
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No pending shipments"
          description={
            urgencyFilter !== 'ALL' || channelFilter.length > 0 || search
              ? 'No orders match your filters. Try clearing them.'
              : 'All caught up — every paid order has a shipment in flight.'
          }
        />
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-md">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={!!allSelected}
                      onChange={toggleSelectAll}
                      aria-label="Select all"
                    />
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                    Order
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                    Channel
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                    Customer
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                    Items
                  </th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700">
                    Value
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">
                    Ship by
                  </th>
                  <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((o) => {
                  const tone = URGENCY_TONE[o.urgency]
                  const Icon = tone.icon
                  const ship = o.shippingAddress as any
                  const country = ship?.countryCode ?? ship?.country ?? null
                  // O.5: clicking the row anywhere except the checkbox
                  // and the action button opens the order drawer.
                  const openDrawer = () => setParam('drawer', o.id)
                  return (
                    <tr
                      key={o.id}
                      className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                      onClick={openDrawer}
                    >
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(o.id)}
                          onChange={() => toggleSelect(o.id)}
                          aria-label={`Select order ${o.channelOrderId}`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="text-base font-mono text-blue-600 hover:underline"
                          onClick={(e) => { e.stopPropagation(); openDrawer() }}
                        >
                          {o.channelOrderId.length > 18
                            ? `${o.channelOrderId.slice(0, 18)}…`
                            : o.channelOrderId}
                        </button>
                        {o.isPrime && (
                          <span
                            title="Amazon Prime SFP"
                            className="ml-1.5 inline-flex items-center gap-0.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5"
                          >
                            <Crown size={10} /> Prime
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-base text-slate-700">
                        <Badge variant="info" size="sm">
                          {CHANNEL_LABEL[o.channel] ?? o.channel}
                          {o.marketplace ? ` · ${o.marketplace}` : ''}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-base text-slate-900 truncate max-w-[180px]">
                          {o.customerName || '—'}
                        </div>
                        <div className="text-sm text-slate-500 truncate max-w-[180px]">
                          {country ?? o.customerEmail}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-base text-slate-700">
                        <span className="tabular-nums">{o.totalQuantity}</span> units ·{' '}
                        {o.itemCount} SKU{o.itemCount === 1 ? '' : 's'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-base text-slate-900">
                        {formatMoney(o.totalPrice, o.currencyCode)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex items-center gap-1 h-6 px-2 text-sm border rounded ${tone.tint}`}
                        >
                          <Icon size={11} />
                          {formatRelative(o.shipByDate)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => {
                            setSelected(new Set([o.id]))
                            // Single-row create — defer to the bulk
                            // path so we share retry/error handling.
                            void (async () => {
                              await new Promise((r) => setTimeout(r, 0))
                              bulkCreateShipments()
                            })()
                          }}
                          className="h-6 px-2 text-sm bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 inline-flex items-center gap-1"
                        >
                          <Package size={11} /> Create shipment
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
