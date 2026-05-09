'use client'

// ORDERS REBUILD — universal command center.
// Lenses: Grid · Customer · Financials · Returns · Reviews.
// Inline quick-edit, bulk action toolbar (3 priorities), URL-driven state.

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  ShoppingCart, RefreshCw, Star, User, DollarSign, Undo2, Download,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { CustomerLens } from './_lenses/CustomerLens'
import { FinancialsLens } from './_lenses/FinancialsLens'
import { ReturnsLens } from './_lenses/ReturnsLens'
import { ReviewsLens } from './_lenses/ReviewsLens'
import { GridLens } from './_lenses/GridLens'
import { FilterBar } from './_components/FilterBar'
import { BulkActionBar } from './_components/BulkActionBar'
import { DEFAULT_VISIBLE } from './_lib/columns'
import {
  SavedViewsButton,
  type SavedView,
} from '../products/_components/SavedViewsButton'
import { useToast } from '@/components/ui/Toast'

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

// O.8e — column registry / status variant / channel + review tone
// constants moved to ./_lib/columns and ./_lib/tone.

export default function OrdersWorkspace() {
  const { t } = useTranslations()
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
  // O.14 — keyboard row navigation. -1 = no row focused; J/ArrowDown
  // sets to 0 on first press. Reset whenever the orders list itself
  // changes underneath (page/search/filter shift).
  const [activeRowIndex, setActiveRowIndex] = useState(-1)
  const [columnPickerOpen, setColumnPickerOpen] = useState(false)

  // O.23a — saved views (extends the existing SavedView infrastructure
  // shared with /products + /listings; surface='orders' tag).
  const [savedViews, setSavedViews] = useState<SavedView[]>([])
  const [savedViewMenuOpen, setSavedViewMenuOpen] = useState(false)
  const { toast } = useToast()
  const fetchSavedViews = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/saved-views?surface=orders`, {
        cache: 'no-store',
      })
      if (!res.ok) return
      const data = await res.json()
      setSavedViews(data.items ?? [])
    } catch {
      /* ignore — saved views are best-effort */
    }
  }, [])
  useEffect(() => {
    fetchSavedViews()
  }, [fetchSavedViews])
  // Apply default view on first mount when no URL state is set.
  const appliedDefaultRef = useRef(false)
  useEffect(() => {
    if (appliedDefaultRef.current) return
    if (savedViews.length === 0) return
    const hasAnyParam = Array.from(searchParams.entries()).length > 0
    if (hasAnyParam) {
      appliedDefaultRef.current = true
      return
    }
    const def = savedViews.find((v) => v.isDefault)
    if (!def) {
      appliedDefaultRef.current = true
      return
    }
    appliedDefaultRef.current = true
    const f = (def.filters ?? {}) as Record<string, any>
    const next = new URLSearchParams()
    for (const [k, v] of Object.entries(f)) {
      if (v == null || v === '') continue
      next.set(k, Array.isArray(v) ? v.join(',') : String(v))
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }, [savedViews, searchParams, pathname, router])

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

  // 30s poll on Grid (fallback when SSE drops or for stats/facets
  // refresh that the SSE bus doesn't carry)
  useEffect(() => {
    if (lens !== 'grid') return
    const onVis = () => { if (document.visibilityState === 'visible') fetchOrders() }
    document.addEventListener('visibilitychange', onVis)
    const id = setInterval(() => { if (document.visibilityState === 'visible') fetchOrders() }, 30000)
    return () => { document.removeEventListener('visibilitychange', onVis); clearInterval(id) }
  }, [lens, fetchOrders])

  // AU.3 — Order SSE subscription. Backend bus shipped in O.6 but
  // had no consumer until this commit. EventSource auto-reconnects
  // on transient drops; on order.created / updated / cancelled /
  // return.created we re-fetch the visible list + stats so the
  // operator sees the change within ~200ms instead of waiting on
  // the 30s poll. Stats/facets refresh too so the header counters
  // stay accurate.
  useEffect(() => {
    const es = new EventSource(`${getBackendUrl()}/api/orders/events`)
    const onAny = () => {
      if (document.visibilityState === 'visible') {
        fetchOrders()
        fetchStats()
        fetchFacets()
      }
    }
    const types = ['order.created', 'order.updated', 'order.cancelled', 'return.created'] as const
    for (const t of types) es.addEventListener(t, onAny as EventListener)
    es.onerror = () => {
      // EventSource reconnects natively on transient drops; we
      // only log unexpected fatal closures.
    }
    return () => {
      for (const t of types) es.removeEventListener(t, onAny as EventListener)
      es.close()
    }
  }, [fetchOrders, fetchStats, fetchFacets])

  useEffect(() => { setSelected(new Set()) }, [page, search, channelFilters.join(','), marketplaceFilters.join(','), statusFilters.join(','), fulfillmentFilters.join(','), hasReturn, hasRefund, reviewEligible])

  // O.14 — reset row focus on filter/search/page change so the cursor
  // doesn't point at a row that just scrolled off the page.
  useEffect(() => {
    setActiveRowIndex(-1)
  }, [page, search, channelFilters.join(','), marketplaceFilters.join(','), statusFilters.join(','), fulfillmentFilters.join(','), reviewStatusFilters.join(','), hasReturn, hasRefund, reviewEligible, lens])

  // O.14 — keyboard shortcuts on the Grid lens. Mirrors the canonical
  // pattern from /listings, /products, /fulfillment/returns:
  //   /              focus search input
  //   j / ArrowDown  next row
  //   k / ArrowUp    previous row
  //   Enter          open the focused row's detail page
  //   Space          toggle row selection
  //   Escape         clear the search → row focus → selection chain
  // Skipped while typing in any input/textarea/select/contentEditable
  // so the search field's own keystrokes don't get intercepted. Cmd/
  // Ctrl combos defer to the app-wide CommandPalette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      const inEditable =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (e.target as HTMLElement)?.isContentEditable
      if (inEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === '/') {
        e.preventDefault()
        const input = document.getElementById('orders-search') as HTMLInputElement | null
        input?.focus()
        input?.select()
        return
      }

      if (e.key === 'Escape') {
        if (searchInput) setSearchInput('')
        else if (activeRowIndex >= 0) setActiveRowIndex(-1)
        else if (selected.size > 0) setSelected(new Set())
        return
      }

      if (lens !== 'grid') return
      const rows = orders.length
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveRowIndex((i) => Math.min(i + 1, rows - 1))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveRowIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        if (activeRowIndex >= 0 && activeRowIndex < rows) {
          e.preventDefault()
          router.push(`/orders/${orders[activeRowIndex].id}`)
        }
      } else if (e.key === ' ') {
        if (activeRowIndex >= 0 && activeRowIndex < rows) {
          e.preventDefault()
          const id = orders[activeRowIndex].id
          setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lens, orders, activeRowIndex, searchInput, selected.size, router])

  const filterCount =
    channelFilters.length + marketplaceFilters.length + statusFilters.length +
    fulfillmentFilters.length + reviewStatusFilters.length +
    (hasReturn ? 1 : 0) + (hasRefund ? 1 : 0) + (reviewEligible ? 1 : 0) + (customerEmail ? 1 : 0)

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('orders.title')}
        description={
          stats
            ? `${stats.total.toLocaleString()} total · ${stats.pending} pending · ${stats.shipped} shipped · ${stats.delivered} delivered`
            : t('orders.subtitle')
        }
        actions={
          <div className="flex items-center gap-2">
            <SavedViewsButton
              open={savedViewMenuOpen}
              setOpen={setSavedViewMenuOpen}
              views={savedViews}
              onApply={(view) => {
                const f = (view.filters ?? {}) as Record<string, any>
                const next = new URLSearchParams()
                for (const [k, v] of Object.entries(f)) {
                  if (v == null || v === '') continue
                  next.set(k, Array.isArray(v) ? v.join(',') : String(v))
                }
                router.replace(`${pathname}?${next.toString()}`, { scroll: false })
                setSavedViewMenuOpen(false)
              }}
              onSaveCurrent={async (name, isDefault) => {
                const filters: Record<string, any> = {}
                if (search) filters.search = search
                if (lens !== 'grid') filters.lens = lens
                if (channelFilters.length) filters.channel = channelFilters
                if (marketplaceFilters.length) filters.marketplace = marketplaceFilters
                if (statusFilters.length) filters.status = statusFilters
                if (fulfillmentFilters.length) filters.fulfillment = fulfillmentFilters
                if (reviewStatusFilters.length) filters.reviewStatus = reviewStatusFilters
                if (hasReturn) filters.hasReturn = hasReturn
                if (hasRefund) filters.hasRefund = hasRefund
                if (reviewEligible) filters.reviewEligible = 'true'
                if (customerEmail) filters.customerEmail = customerEmail
                if (sortBy !== 'purchaseDate') filters.sortBy = sortBy
                if (sortDir !== 'desc') filters.sortDir = sortDir
                if (pageSize !== 50) filters.pageSize = String(pageSize)
                const res = await fetch(`${getBackendUrl()}/api/saved-views`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name, surface: 'orders', filters, isDefault }),
                })
                if (res.ok) {
                  fetchSavedViews()
                  return true
                }
                const err = await res.json().catch(() => ({}))
                toast.error(err.error ?? 'Save failed')
                return false
              }}
              onDelete={async (id) => {
                await fetch(`${getBackendUrl()}/api/saved-views/${id}`, { method: 'DELETE' })
                fetchSavedViews()
              }}
              onSetDefault={async (id) => {
                await fetch(`${getBackendUrl()}/api/saved-views/${id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ isDefault: true }),
                })
                fetchSavedViews()
              }}
            />
            <Link href="/orders/reviews/rules" className="h-8 px-3 text-base bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1.5">
              <Star size={12} /> {t('orders.action.reviewRules')}
            </Link>
            <a
              href={`${getBackendUrl()}/api/orders/export.csv?${searchParams.toString()}`}
              className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
              download
            >
              <Download size={12} /> {t('orders.action.exportCsv')}
            </a>
            <button onClick={() => fetchOrders()} className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5">
              <RefreshCw size={12} /> {t('orders.action.refresh')}
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
          activeRowIndex={activeRowIndex}
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
  const { t } = useTranslations()
  const tabs: Array<{ key: Lens; label: string; icon: any }> = [
    { key: 'grid', label: t('orders.lens.grid'), icon: ShoppingCart },
    { key: 'customer', label: t('orders.lens.customer'), icon: User },
    { key: 'financials', label: t('orders.lens.financials'), icon: DollarSign },
    { key: 'returns', label: t('orders.lens.returns'), icon: Undo2 },
    { key: 'reviews', label: t('orders.lens.reviews'), icon: Star },
  ]
  // U.60 — was a single `inline-flex` row with no overflow handling, so
  // adding lenses pushed the row past its container and clipped silently.
  // Wrapper now allows horizontal scroll; pill row keeps its rounded look
  // via inline-flex + flex-shrink-0 on items so each lens stays a fixed
  // pill instead of squishing.
  return (
    <div className="max-w-full overflow-x-auto [scrollbar-width:thin]">
      <div
        role="tablist"
        aria-label="Order lenses"
        className="inline-flex items-center bg-slate-100 rounded-md p-0.5"
      >
        {tabs.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={current === tab.key}
            aria-controls={`orders-lens-${tab.key}`}
            onClick={() => onChange(tab.key)}
            className={`h-7 px-3 text-base font-medium inline-flex items-center gap-1.5 rounded transition-colors whitespace-nowrap flex-shrink-0 ${current === tab.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
          >
            <tab.icon size={12} aria-hidden="true" />
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  )
}


// CustomerLens extracted to ./_lenses/CustomerLens.tsx (O.8a).

// FinancialsLens extracted to ./_lenses/FinancialsLens.tsx (O.8b).

// ReturnsLens extracted to ./_lenses/ReturnsLens.tsx (O.8c).

// ReviewsLens extracted to ./_lenses/ReviewsLens.tsx (O.8d).
