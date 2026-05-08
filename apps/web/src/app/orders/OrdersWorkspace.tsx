'use client'

// ORDERS REBUILD — universal command center.
// Lenses: Grid · Customer · Financials · Returns · Reviews.
// Inline quick-edit, bulk action toolbar (3 priorities), URL-driven state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  ShoppingCart, Search, RefreshCw, Filter, X, ChevronDown, ChevronRight,
  Truck, Package, Star, Settings2, User, DollarSign, Undo2,
  Sparkles,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { useToast } from '@/components/ui/Toast'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { COUNTRY_NAMES } from '@/lib/country-names'
import { getBackendUrl } from '@/lib/backend-url'
import { CustomerLens } from './_lenses/CustomerLens'
import { FinancialsLens } from './_lenses/FinancialsLens'
import { ReturnsLens } from './_lenses/ReturnsLens'

type Lens = 'grid' | 'customer' | 'financials' | 'returns' | 'reviews'

type Tag = { id: string; name: string; color: string | null }

type ReviewRequest = {
  id: string
  channel: string
  status: 'ELIGIBLE' | 'SCHEDULED' | 'SENT' | 'SUPPRESSED' | 'FAILED' | 'SKIPPED'
  sentAt: string | null
  scheduledFor: string | null
}

type Order = {
  id: string
  channel: string
  marketplace: string | null
  channelOrderId: string
  status: string
  fulfillmentMethod: string | null
  totalPrice: number
  currencyCode: string | null
  customerName: string
  customerEmail: string
  shippingAddress: any
  purchaseDate: string | null
  paidAt: string | null
  shippedAt: string | null
  deliveredAt: string | null
  cancelledAt: string | null
  createdAt: string
  itemCount: number
  shipmentCount: number
  returnCount: number
  hasActiveReturn: boolean
  hasRefund: boolean
  customerOrderCount: number
  tags: Tag[]
  reviewRequests: ReviewRequest[]
  items: Array<{ id: string; sku: string; quantity: number; price: number; productId: string | null }>
}

type Facets = {
  channels: Array<{ value: string; count: number }>
  marketplaces: Array<{ value: string; count: number }>
  fulfillment: Array<{ value: string; count: number }>
}

type Stats = { total: number; pending: number; shipped: number; cancelled: number; delivered: number; lastOrderAt: string | null }

const ALL_COLUMNS: Array<{ key: string; label: string; width: number; locked?: boolean }> = [
  { key: 'select', label: '', width: 32, locked: true },
  { key: 'channel', label: 'Channel', width: 100, locked: true },
  { key: 'orderId', label: 'Order ID', width: 160, locked: true },
  { key: 'date', label: 'Date', width: 110 },
  { key: 'customer', label: 'Customer', width: 200 },
  { key: 'items', label: 'Items', width: 70 },
  { key: 'total', label: 'Total', width: 110 },
  { key: 'status', label: 'Status', width: 110 },
  { key: 'fulfillment', label: 'FBA/FBM', width: 80 },
  { key: 'returnRefund', label: 'R/R', width: 80 },
  { key: 'review', label: 'Review', width: 100 },
  { key: 'repeat', label: 'Repeat', width: 70 },
  { key: 'tags', label: 'Tags', width: 140 },
  { key: 'actions', label: '', width: 90, locked: true },
]
const DEFAULT_VISIBLE = ['select', 'channel', 'orderId', 'date', 'customer', 'items', 'total', 'status', 'fulfillment', 'returnRefund', 'review', 'actions']

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'default' | 'info'> = {
  PENDING: 'warning',
  SHIPPED: 'info',
  DELIVERED: 'success',
  CANCELLED: 'default',
}

const REVIEW_STATUS_TONE: Record<string, string> = {
  SENT: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  SCHEDULED: 'bg-blue-50 text-blue-700 border-blue-200',
  ELIGIBLE: 'bg-amber-50 text-amber-700 border-amber-200',
  SUPPRESSED: 'bg-slate-50 text-slate-500 border-slate-200',
  FAILED: 'bg-rose-50 text-rose-700 border-rose-200',
  SKIPPED: 'bg-slate-50 text-slate-500 border-slate-200',
}

const CHANNEL_TONE: Record<string, string> = {
  AMAZON: 'bg-orange-50 text-orange-700 border-orange-200',
  EBAY: 'bg-blue-50 text-blue-700 border-blue-200',
  SHOPIFY: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  WOOCOMMERCE: 'bg-violet-50 text-violet-700 border-violet-200',
  ETSY: 'bg-rose-50 text-rose-700 border-rose-200',
  MANUAL: 'bg-slate-50 text-slate-700 border-slate-200',
}

export default function OrdersWorkspace() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const lens = (searchParams.get('lens') as Lens) || 'grid'
  const page = parseInt(searchParams.get('page') ?? '1', 10) || 1
  const pageSize = Math.min(500, parseInt(searchParams.get('pageSize') ?? '50', 10) || 50)
  const search = searchParams.get('search') ?? ''
  const sortBy = searchParams.get('sortBy') ?? 'purchaseDate'
  const sortDir = (searchParams.get('sortDir') ?? 'desc') as 'asc' | 'desc'

  const channelFilters = searchParams.get('channel')?.split(',').filter(Boolean) ?? []
  const marketplaceFilters = searchParams.get('marketplace')?.split(',').filter(Boolean) ?? []
  const statusFilters = searchParams.get('status')?.split(',').filter(Boolean) ?? []
  const fulfillmentFilters = searchParams.get('fulfillment')?.split(',').filter(Boolean) ?? []
  const reviewStatusFilters = searchParams.get('reviewStatus')?.split(',').filter(Boolean) ?? []
  const hasReturn = searchParams.get('hasReturn')
  const hasRefund = searchParams.get('hasRefund')
  const reviewEligible = searchParams.get('reviewEligible') === 'true'
  const customerEmail = searchParams.get('customerEmail') ?? ''

  const [searchInput, setSearchInput] = useState(search)
  const [orders, setOrders] = useState<Order[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [facets, setFacets] = useState<Facets | null>(null)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [columnPickerOpen, setColumnPickerOpen] = useState(false)

  const [visibleColumns, setVisibleColumns] = useState<string[]>(() => {
    if (typeof window === 'undefined') return DEFAULT_VISIBLE
    try { const s = window.localStorage.getItem('orders.visibleColumns'); return s ? JSON.parse(s) : DEFAULT_VISIBLE } catch { return DEFAULT_VISIBLE }
  })
  useEffect(() => { try { window.localStorage.setItem('orders.visibleColumns', JSON.stringify(visibleColumns)) } catch {} }, [visibleColumns])

  const updateUrl = useCallback((patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }, [searchParams, pathname, router])

  // Debounce search → URL
  useEffect(() => {
    const t = setTimeout(() => { if (searchInput !== search) updateUrl({ search: searchInput || undefined, page: undefined }) }, 250)
    return () => clearTimeout(t)
  }, [searchInput])

  const fetchOrders = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams()
      qs.set('page', String(page))
      qs.set('pageSize', String(pageSize))
      if (search) qs.set('search', search)
      if (channelFilters.length) qs.set('channel', channelFilters.join(','))
      if (marketplaceFilters.length) qs.set('marketplace', marketplaceFilters.join(','))
      if (statusFilters.length) qs.set('status', statusFilters.join(','))
      if (fulfillmentFilters.length) qs.set('fulfillment', fulfillmentFilters.join(','))
      if (reviewStatusFilters.length) qs.set('reviewStatus', reviewStatusFilters.join(','))
      if (hasReturn) qs.set('hasReturn', hasReturn)
      if (hasRefund) qs.set('hasRefund', hasRefund)
      if (reviewEligible) qs.set('reviewEligible', 'true')
      if (customerEmail) qs.set('customerEmail', customerEmail)
      qs.set('sortBy', sortBy)
      qs.set('sortDir', sortDir)
      const res = await fetch(`${getBackendUrl()}/api/orders?${qs.toString()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const data = await res.json()
      setOrders(data.orders ?? [])
      setTotal(data.total ?? 0)
      setTotalPages(data.totalPages ?? 0)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
      setOrders([])
    } finally { setLoading(false) }
  }, [page, pageSize, search, channelFilters.join(','), marketplaceFilters.join(','), statusFilters.join(','), fulfillmentFilters.join(','), reviewStatusFilters.join(','), hasReturn, hasRefund, reviewEligible, customerEmail, sortBy, sortDir])

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/orders/stats`, { cache: 'no-store' })
      if (res.ok) setStats(await res.json())
    } catch {}
  }, [])
  const fetchFacets = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/orders/facets`, { cache: 'no-store' })
      if (res.ok) setFacets(await res.json())
    } catch {}
  }, [])

  useEffect(() => { if (lens === 'grid') fetchOrders() }, [lens, fetchOrders])
  useEffect(() => { fetchStats(); fetchFacets() }, [fetchStats, fetchFacets])

  // 30s poll on Grid
  useEffect(() => {
    if (lens !== 'grid') return
    const onVis = () => { if (document.visibilityState === 'visible') fetchOrders() }
    document.addEventListener('visibilitychange', onVis)
    const id = setInterval(() => { if (document.visibilityState === 'visible') fetchOrders() }, 30000)
    return () => { document.removeEventListener('visibilitychange', onVis); clearInterval(id) }
  }, [lens, fetchOrders])

  useEffect(() => { setSelected(new Set()) }, [page, search, channelFilters.join(','), marketplaceFilters.join(','), statusFilters.join(','), fulfillmentFilters.join(','), hasReturn, hasRefund, reviewEligible])

  const filterCount =
    channelFilters.length + marketplaceFilters.length + statusFilters.length +
    fulfillmentFilters.length + reviewStatusFilters.length +
    (hasReturn ? 1 : 0) + (hasRefund ? 1 : 0) + (reviewEligible ? 1 : 0) + (customerEmail ? 1 : 0)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Orders"
        description={
          stats
            ? `${stats.total.toLocaleString()} total · ${stats.pending} pending · ${stats.shipped} shipped · ${stats.delivered} delivered`
            : 'Multi-channel order command center'
        }
        actions={
          <div className="flex items-center gap-2">
            <Link href="/orders/reviews/rules" className="h-8 px-3 text-base bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1.5">
              <Star size={12} /> Review rules
            </Link>
            <button onClick={() => fetchOrders()} className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        }
      />

      <div className="flex items-center gap-2 flex-wrap">
        <LensTabs current={lens} onChange={(next) => updateUrl({ lens: next === 'grid' ? undefined : next, page: undefined })} />
      </div>

      {/* Filter bar */}
      {lens === 'grid' && (
        <FilterBar
          searchInput={searchInput}
          setSearchInput={setSearchInput}
          channelFilters={channelFilters}
          marketplaceFilters={marketplaceFilters}
          statusFilters={statusFilters}
          fulfillmentFilters={fulfillmentFilters}
          reviewStatusFilters={reviewStatusFilters}
          hasReturn={hasReturn}
          hasRefund={hasRefund}
          reviewEligible={reviewEligible}
          filterCount={filterCount}
          filtersOpen={filtersOpen}
          setFiltersOpen={setFiltersOpen}
          facets={facets}
          updateUrl={updateUrl}
        />
      )}

      {/* Bulk action bar */}
      {lens === 'grid' && selected.size > 0 && (
        <BulkActionBar
          selectedIds={Array.from(selected)}
          onClear={() => setSelected(new Set())}
          onComplete={() => { setSelected(new Set()); fetchOrders() }}
        />
      )}

      {lens === 'grid' && (
        <GridLens
          orders={orders}
          loading={loading}
          error={error}
          page={page}
          pageSize={pageSize}
          totalPages={totalPages}
          total={total}
          visibleColumns={visibleColumns}
          setVisibleColumns={setVisibleColumns}
          columnPickerOpen={columnPickerOpen}
          setColumnPickerOpen={setColumnPickerOpen}
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={(key: string) => updateUrl({
            sortBy: key,
            sortDir: sortBy === key && sortDir === 'desc' ? 'asc' : 'desc',
            page: undefined,
          })}
          selected={selected}
          setSelected={setSelected}
          onPage={(p: number) => updateUrl({ page: p === 1 ? undefined : String(p) })}
          onPageSize={(s: number) => updateUrl({ pageSize: s === 50 ? undefined : String(s), page: undefined })}
        />
      )}

      {lens === 'customer' && <CustomerLens />}
      {lens === 'financials' && <FinancialsLens orders={orders} />}
      {lens === 'returns' && <ReturnsLens />}
      {lens === 'reviews' && <ReviewsLens />}
    </div>
  )
}

function LensTabs({ current, onChange }: { current: Lens; onChange: (l: Lens) => void }) {
  const tabs: Array<{ key: Lens; label: string; icon: any }> = [
    { key: 'grid', label: 'Grid', icon: ShoppingCart },
    { key: 'customer', label: 'Customers', icon: User },
    { key: 'financials', label: 'Financials', icon: DollarSign },
    { key: 'returns', label: 'Returns', icon: Undo2 },
    { key: 'reviews', label: 'Reviews', icon: Star },
  ]
  return (
    <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`h-7 px-3 text-base font-medium inline-flex items-center gap-1.5 rounded transition-colors ${current === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
        >
          <t.icon size={12} />
          {t.label}
        </button>
      ))}
    </div>
  )
}

function FilterBar(props: any) {
  const {
    searchInput, setSearchInput,
    channelFilters, marketplaceFilters, statusFilters, fulfillmentFilters, reviewStatusFilters,
    hasReturn, hasRefund, reviewEligible,
    filterCount, filtersOpen, setFiltersOpen, facets, updateUrl,
  } = props
  const toggleArr = (current: string[], val: string) => current.includes(val) ? current.filter((v: string) => v !== val) : [...current, val]
  return (
    <Card>
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex-1 min-w-[240px] max-w-md relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder="Search order ID, customer, email, SKU…"
              value={searchInput}
              onChange={(e: any) => setSearchInput(e.target.value)}
              className="pl-7"
            />
          </div>
          <button
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={`h-8 px-3 text-base border rounded inline-flex items-center gap-1.5 ${filtersOpen || filterCount > 0 ? 'border-slate-300 bg-slate-50' : 'border-slate-200 hover:bg-slate-50'}`}
          >
            <Filter size={12} />
            Filters
            {filterCount > 0 && <span className="bg-slate-700 text-white text-xs px-1.5 py-0.5 rounded-full font-semibold">{filterCount}</span>}
            <ChevronDown size={12} className={filtersOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
          </button>
          {filterCount > 0 && (
            <button
              onClick={() => updateUrl({ channel: '', marketplace: '', status: '', fulfillment: '', reviewStatus: '', hasReturn: undefined, hasRefund: undefined, reviewEligible: undefined, customerEmail: undefined, page: undefined })}
              className="h-8 px-2 text-base text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
            ><X size={12} /> Clear</button>
          )}
        </div>
        {filtersOpen && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 pt-2 border-t border-slate-100">
            <FilterGroup
              label="Channel"
              options={['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY', 'MANUAL']}
              selected={channelFilters}
              counts={facets?.channels.reduce((m: any, s: any) => { m[s.value] = s.count; return m }, {})}
              onToggle={(v: string) => updateUrl({ channel: toggleArr(channelFilters, v).join(',') || undefined, page: undefined })}
            />
            {facets && facets.marketplaces.length > 0 && (
              <FilterGroup
                label="Marketplace"
                options={facets.marketplaces.map((m: any) => m.value)}
                selected={marketplaceFilters}
                counts={facets.marketplaces.reduce((m: any, s: any) => { m[s.value] = s.count; return m }, {})}
                renderLabel={(v: string) => `${v} · ${COUNTRY_NAMES[v] ?? ''}`.trim()}
                onToggle={(v: string) => updateUrl({ marketplace: toggleArr(marketplaceFilters, v).join(',') || undefined, page: undefined })}
              />
            )}
            <FilterGroup
              label="Status"
              options={['PENDING', 'SHIPPED', 'DELIVERED', 'CANCELLED']}
              selected={statusFilters}
              onToggle={(v: string) => updateUrl({ status: toggleArr(statusFilters, v).join(',') || undefined, page: undefined })}
            />
            <FilterGroup
              label="Fulfillment"
              options={['FBA', 'FBM']}
              selected={fulfillmentFilters}
              counts={facets?.fulfillment.reduce((m: any, s: any) => { m[s.value] = s.count; return m }, {})}
              onToggle={(v: string) => updateUrl({ fulfillment: toggleArr(fulfillmentFilters, v).join(',') || undefined, page: undefined })}
            />
            <FilterGroup
              label="Review status"
              options={['ELIGIBLE', 'SCHEDULED', 'SENT', 'SUPPRESSED', 'FAILED', 'SKIPPED']}
              selected={reviewStatusFilters}
              onToggle={(v: string) => updateUrl({ reviewStatus: toggleArr(reviewStatusFilters, v).join(',') || undefined, page: undefined })}
            />
            <div className="md:col-span-2 lg:col-span-3 flex items-center gap-2 flex-wrap pt-2 border-t border-slate-100">
              <ToggleChip active={hasReturn === 'true'} label="Has return" tone="warning" onClick={() => updateUrl({ hasReturn: hasReturn === 'true' ? undefined : 'true', page: undefined })} />
              <ToggleChip active={hasRefund === 'true'} label="Has refund" tone="danger" onClick={() => updateUrl({ hasRefund: hasRefund === 'true' ? undefined : 'true', page: undefined })} />
              <ToggleChip active={reviewEligible} label="Review-eligible (delivered, no return/refund, no prior request)" tone="success" onClick={() => updateUrl({ reviewEligible: reviewEligible ? undefined : 'true', page: undefined })} />
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

function FilterGroup({ label, options, selected, onToggle, counts, renderLabel }: any) {
  if (options.length === 0) return null
  return (
    <div>
      <div className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-1.5">{label}</div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {options.map((opt: string) => {
          const active = selected.includes(opt)
          const count = counts?.[opt]
          return (
            <button
              key={opt}
              onClick={() => onToggle(opt)}
              className={`h-7 px-2 text-sm border rounded inline-flex items-center gap-1.5 ${active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'}`}
            >
              {renderLabel ? renderLabel(opt) : opt}
              {count != null && <span className={active ? 'text-slate-300' : 'text-slate-400'}>{count}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ToggleChip({ active, label, onClick, tone }: { active: boolean; label: string; onClick: () => void; tone: 'danger' | 'warning' | 'success' }) {
  const cls = active ? {
    danger: 'bg-rose-50 text-rose-700 border-rose-300',
    warning: 'bg-amber-50 text-amber-700 border-amber-300',
    success: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  }[tone] : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
  return <button onClick={onClick} className={`h-7 px-3 text-sm border rounded-full font-medium ${cls}`}>{label}</button>
}

function BulkActionBar({ selectedIds, onClear, onComplete }: { selectedIds: string[]; onClear: () => void; onComplete: () => void }) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const run = async (label: string, fn: () => Promise<any>) => {
    setBusy(true); setStatus(label)
    try {
      const res = await fn()
      if (typeof res === 'string') setStatus(res); else setStatus('Done')
      onComplete()
      setTimeout(() => setStatus(null), 2500)
    } catch (e: any) {
      setStatus(`Error: ${e.message ?? 'failed'}`); setTimeout(() => setStatus(null), 4000)
    } finally { setBusy(false) }
  }
  const createShipments = () => run('Creating shipments…', async () => {
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipments/bulk-create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderIds: selectedIds }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    return `Created ${data.created}, ${data.errors?.length ?? 0} errors`
  })
  const markShipped = () => run('Marking shipped…', async () => {
    const res = await fetch(`${getBackendUrl()}/api/orders/bulk-mark-shipped`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderIds: selectedIds }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    return `Updated ${data.updated}`
  })
  const requestReviews = () => run('Requesting reviews…', async () => {
    const res = await fetch(`${getBackendUrl()}/api/orders/bulk-request-reviews`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderIds: selectedIds }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)
    return `Sent ${data.sent}, skipped ${data.skipped}, failed ${data.failed}`
  })
  return (
    <div className="sticky top-2 z-20">
      <Card>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-semibold text-slate-700">{selectedIds.length} selected</span>
          <div className="h-4 w-px bg-slate-200" />
          <button onClick={createShipments} disabled={busy} className="h-7 px-3 text-base bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 disabled:opacity-50 inline-flex items-center gap-1.5">
            <Truck size={12} /> Create shipments
          </button>
          <button onClick={markShipped} disabled={busy} className="h-7 px-3 text-base bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 disabled:opacity-50 inline-flex items-center gap-1.5">
            <Package size={12} /> Mark shipped
          </button>
          <button onClick={requestReviews} disabled={busy} className="h-7 px-3 text-base bg-amber-50 text-amber-700 border border-amber-200 rounded hover:bg-amber-100 disabled:opacity-50 inline-flex items-center gap-1.5">
            <Star size={12} /> Request reviews
          </button>
          {status && <span className="text-sm text-slate-500 ml-2">{status}</span>}
          <button onClick={onClear} disabled={busy} className="ml-auto h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded">
            <X size={14} />
          </button>
        </div>
      </Card>
    </div>
  )
}

function GridLens(props: any) {
  const {
    orders, loading, error, page, pageSize, totalPages, total,
    visibleColumns, setVisibleColumns, columnPickerOpen, setColumnPickerOpen,
    sortBy, sortDir, onSort, selected, setSelected, onPage, onPageSize,
  } = props
  const visible = useMemo(() => ALL_COLUMNS.filter((c) => visibleColumns.includes(c.key) || c.locked), [visibleColumns])
  const allSelected = orders.length > 0 && orders.every((o: Order) => selected.has(o.id))
  const toggleSelectAll = () => {
    const next = new Set<string>(selected)
    if (allSelected) orders.forEach((o: Order) => next.delete(o.id))
    else orders.forEach((o: Order) => next.add(o.id))
    setSelected(next)
  }
  const toggleSelect = (id: string) => {
    const next = new Set<string>(selected)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelected(next)
  }

  if (loading && orders.length === 0) return <Card><div className="text-md text-slate-500 py-8 text-center">Loading orders…</div></Card>
  if (error) return <Card><div className="text-md text-rose-600 py-8 text-center">Failed to load: {error}</div></Card>
  if (orders.length === 0) return <EmptyState icon={ShoppingCart} title="No orders match these filters" description="Adjust filters or wait for new orders to ingest." />

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-500">
            <span className="font-semibold text-slate-700 tabular-nums">{total}</span> orders · page {page} of {totalPages}
          </span>
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} className="h-7 px-2 text-sm border border-slate-200 rounded">
            {[25, 50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}/page</option>)}
          </select>
        </div>
        <div className="relative">
          <button onClick={() => setColumnPickerOpen(!columnPickerOpen)} className="h-7 px-2 text-base border border-slate-200 rounded inline-flex items-center gap-1.5 hover:bg-slate-50">
            <Settings2 size={12} /> Columns ({visibleColumns.length})
          </button>
          {columnPickerOpen && <ColumnPickerMenu visible={visibleColumns} setVisible={setVisibleColumns} onClose={() => setColumnPickerOpen(false)} />}
        </div>
      </div>

      <Card noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-md">
            <thead className="border-b border-slate-200 bg-slate-50 sticky top-0 z-10">
              <tr>
                {visible.map((col) => (
                  <th
                    key={col.key}
                    style={{ width: col.width, minWidth: col.width }}
                    className={`px-3 py-2 text-sm font-semibold uppercase tracking-wider text-slate-700 text-left ${['date', 'customer', 'total', 'status'].includes(col.key) ? 'cursor-pointer hover:bg-slate-100' : ''}`}
                    onClick={() => {
                      const map: Record<string, string> = { date: 'purchaseDate', customer: 'customer', total: 'totalPrice', status: 'status' }
                      if (map[col.key]) onSort(map[col.key])
                    }}
                  >
                    {col.key === 'select' ? <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} /> : (
                      <span className="inline-flex items-center gap-1">
                        {col.label}
                        {col.key === 'date' && sortBy === 'purchaseDate' && <span className="text-slate-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                        {col.key === 'total' && sortBy === 'totalPrice' && <span className="text-slate-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                        {col.key === 'status' && sortBy === 'status' && <span className="text-slate-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                        {col.key === 'customer' && sortBy === 'customer' && <span className="text-slate-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map((o: Order) => {
                const isSelected = selected.has(o.id)
                return (
                  <tr key={o.id} className={`border-b border-slate-100 hover:bg-slate-50 ${isSelected ? 'bg-blue-50/30' : ''}`}>
                    {visible.map((col) => (
                      <td key={col.key} className="px-3 py-2 align-middle" style={{ width: col.width, minWidth: col.width }}>
                        <OrderCell col={col.key} order={o} isSelected={isSelected} onToggle={() => toggleSelect(o.id)} />
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-base text-slate-500">
          <span>Page <span className="font-semibold text-slate-700 tabular-nums">{page}</span> of <span className="tabular-nums">{totalPages}</span></span>
          <div className="flex items-center gap-1">
            <button onClick={() => onPage(Math.max(1, page - 1))} disabled={page === 1} className="h-7 px-3 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed">Previous</button>
            <button onClick={() => onPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages} className="h-7 px-3 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed">Next</button>
          </div>
        </div>
      )}
    </div>
  )
}

function OrderCell({ col, order, isSelected, onToggle }: { col: string; order: Order; isSelected: boolean; onToggle: () => void }) {
  const o = order
  switch (col) {
    case 'select': return <input type="checkbox" checked={isSelected} onChange={onToggle} />
    case 'channel':
      return (
        <div className="flex flex-col gap-0.5">
          <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded w-fit ${CHANNEL_TONE[o.channel] ?? 'bg-slate-50 text-slate-600 border-slate-200'}`}>{o.channel}</span>
          {o.marketplace && <span className="text-xs text-slate-500 font-mono">{o.marketplace}</span>}
        </div>
      )
    case 'orderId':
      return (
        <Link href={`/orders/${o.id}`} className="text-base font-mono text-blue-600 hover:underline truncate block">
          {o.channelOrderId}
        </Link>
      )
    case 'date':
      return (
        <span className="text-base text-slate-700">
          {o.purchaseDate
            ? new Date(o.purchaseDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
            : new Date(o.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })}
        </span>
      )
    case 'customer':
      return (
        <div className="min-w-0">
          <div className="text-base text-slate-900 truncate">{o.customerName}</div>
          <div className="text-sm text-slate-500 truncate">{o.customerEmail}</div>
        </div>
      )
    case 'items':
      return <span className="text-base tabular-nums text-slate-700">{o.itemCount}</span>
    case 'total':
      return <span className="text-md tabular-nums font-semibold text-slate-900">{o.currencyCode === 'EUR' || !o.currencyCode ? '€' : ''}{o.totalPrice.toFixed(2)}{o.currencyCode && o.currencyCode !== 'EUR' ? ` ${o.currencyCode}` : ''}</span>
    case 'status':
      return <Badge variant={STATUS_VARIANT[o.status] ?? 'default'} size="sm">{o.status}</Badge>
    case 'fulfillment':
      return o.fulfillmentMethod
        ? <Badge variant={o.fulfillmentMethod === 'FBA' ? 'warning' : 'info'} size="sm">{o.fulfillmentMethod}</Badge>
        : <span className="text-slate-400 text-sm">—</span>
    case 'returnRefund':
      return (
        <div className="flex items-center gap-1">
          {o.hasActiveReturn && <span title="Active return" className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1 py-0.5 rounded">R</span>}
          {o.hasRefund && <span title="Has refund" className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 px-1 py-0.5 rounded">$</span>}
          {!o.hasActiveReturn && !o.hasRefund && <span className="text-slate-400 text-xs">—</span>}
        </div>
      )
    case 'review': {
      const rr = o.reviewRequests[0]
      if (!rr) return <span className="text-xs text-slate-400">—</span>
      return (
        <span className={`inline-block text-xs uppercase tracking-wider font-semibold px-1.5 py-0.5 border rounded ${REVIEW_STATUS_TONE[rr.status]}`}>
          {rr.status.slice(0, 4)}
        </span>
      )
    }
    case 'repeat':
      return o.customerOrderCount > 1
        ? <span title={`${o.customerOrderCount} orders from this customer`} className="text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded">×{o.customerOrderCount}</span>
        : <span className="text-slate-400 text-xs">new</span>
    case 'tags':
      return (
        <div className="flex items-center gap-1 flex-wrap">
          {(o.tags ?? []).slice(0, 3).map((t) => (
            <span key={t.id} className="inline-flex items-center px-1.5 py-0.5 text-xs rounded" style={{ background: t.color ? `${t.color}20` : '#f1f5f9', color: t.color ?? '#64748b' }}>
              {t.name}
            </span>
          ))}
        </div>
      )
    case 'actions':
      return (
        <Link href={`/orders/${o.id}`} className="h-6 px-2 text-sm text-slate-600 hover:text-blue-600 hover:bg-blue-50 rounded inline-flex items-center gap-1">
          Open <ChevronRight size={11} />
        </Link>
      )
    default: return null
  }
}

function ColumnPickerMenu({ visible, setVisible, onClose }: { visible: string[]; setVisible: (v: string[]) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose])
  const togglable = ALL_COLUMNS.filter((c) => !c.locked && c.label)
  return (
    <div ref={ref} className="absolute right-0 top-full mt-1 w-56 bg-white border border-slate-200 rounded-md shadow-lg z-20 p-1.5">
      <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 px-2 py-1.5">Visible columns</div>
      {togglable.map((c) => (
        <label key={c.key} className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 rounded text-base cursor-pointer">
          <input type="checkbox" checked={visible.includes(c.key)} onChange={() => visible.includes(c.key) ? setVisible(visible.filter((k) => k !== c.key)) : setVisible([...visible, c.key])} />
          <span className="text-slate-700">{c.label}</span>
        </label>
      ))}
      <div className="border-t border-slate-100 mt-1.5 pt-1.5 px-2 py-1 flex items-center justify-between">
        <button onClick={() => setVisible(DEFAULT_VISIBLE)} className="text-sm text-slate-500 hover:text-slate-900">Reset</button>
        <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-900">Close</button>
      </div>
    </div>
  )
}

// CustomerLens extracted to ./_lenses/CustomerLens.tsx (O.8a).

// FinancialsLens extracted to ./_lenses/FinancialsLens.tsx (O.8b).

// ReturnsLens extracted to ./_lenses/ReturnsLens.tsx (O.8c).

function ReviewsLens() {
  const { toast } = useToast()
  const [requests, setRequests] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)

  const refresh = useCallback(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/review-requests?pageSize=200`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => setRequests(data.items ?? []))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const tickEngine = async () => {
    setRunning(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/review-engine/tick`, { method: 'POST' })
      const data = await res.json()
      toast.success(`Engine ran: ${data.processed} processed · ${data.sent} sent · ${data.failed} failed · ${data.suppressed} suppressed`)
      refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally { setRunning(false) }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Link href="/orders/reviews/rules" className="h-8 px-3 text-base bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1.5">
          <Sparkles size={12} /> Manage rules
        </Link>
        <button onClick={tickEngine} disabled={running} className="h-8 px-3 text-base bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5">
          <RefreshCw size={12} className={running ? 'animate-spin' : ''} /> Run engine now
        </button>
        <button onClick={refresh} className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>
      {loading ? <Card><div className="text-md text-slate-500 py-8 text-center">Loading review requests…</div></Card> :
        requests.length === 0 ? <EmptyState icon={Star} title="No review requests yet" description="Create a rule, run it, or send manually from an order detail." action={{ label: 'Manage rules', href: '/orders/reviews/rules' }} /> : (
          <Card noPadding>
            <div className="overflow-x-auto">
              <table className="w-full text-md">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">Order</th>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">Channel</th>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">Status</th>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">Rule</th>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">Sent / Scheduled</th>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-2"><Link href={`/orders/${r.orderId}`} className="font-mono text-base text-blue-600 hover:underline">{r.order?.channelOrderId ?? r.orderId.slice(0, 12)}</Link></td>
                      <td className="px-3 py-2"><span className={`inline-block text-xs font-semibold uppercase px-1.5 py-0.5 border rounded ${CHANNEL_TONE[r.channel]}`}>{r.channel}</span></td>
                      <td className="px-3 py-2"><span className={`inline-block text-xs uppercase tracking-wider font-semibold px-1.5 py-0.5 border rounded ${REVIEW_STATUS_TONE[r.status]}`}>{r.status}</span></td>
                      <td className="px-3 py-2 text-sm text-slate-600">{r.rule?.name ?? <span className="text-slate-400">—</span>}</td>
                      <td className="px-3 py-2 text-sm text-slate-500">
                        {r.sentAt ? new Date(r.sentAt).toLocaleString() : r.scheduledFor ? `→ ${new Date(r.scheduledFor).toLocaleString()}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-sm text-slate-500 max-w-[260px] truncate">{r.errorMessage ?? r.suppressedReason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )
      }
    </div>
  )
}
