'use client'

// H.3 — multi-location stock workspace.
//
// Reads /api/stock (StockLevel ledger) instead of /api/fulfillment/stock.
// Each row is a (product, location) pair so a single SKU can appear once
// per location it stocks at — Riccione vs Amazon-EU-FBA, etc. The drawer
// opens by productId and aggregates across locations; full multi-location
// breakdown lives in Commit 4.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  Warehouse, Search, RefreshCw, Package, ChevronRight,
  X, History, ExternalLink, ArrowRightLeft, Plus, Minus,
  Boxes, AlertTriangle, TrendingDown, Layers, Activity, Truck,
  Lock as LockIcon, Table as TableIcon, Grid, LayoutGrid,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'

type StockRow = {
  id: string
  quantity: number
  reserved: number
  available: number
  reorderThreshold: number | null
  syncStatus: string
  lastUpdatedAt: string
  lastSyncedAt: string | null
  location: { id: string; code: string; name: string; type: string }
  product: {
    id: string
    sku: string
    name: string
    amazonAsin: string | null
    lowStockThreshold: number
    costPrice: number | null
    basePrice: number | null
    thumbnailUrl: string | null
  }
  variation: { id: string; sku: string; variationAttributes: any } | null
}

type LocationSummary = {
  id: string
  code: string
  name: string
  type: string
  skuCount: number
  totalQuantity: number
  totalReserved: number
  totalAvailable: number
}

type ProductBundle = {
  id: string
  sku: string
  name: string
  amazonAsin: string | null
  totalStock: number
  lowStockThreshold: number
  costPrice: number | null
  basePrice: number | null
  thumbnailUrl: string | null
  stockLevels: Array<{
    id: string
    locationId: string
    quantity: number
    reserved: number
    available: number
    lastUpdatedAt: string
  }>
}

type ViewMode = 'table' | 'matrix' | 'cards'

type Kpis = {
  totalStockUnits: number
  totalStockValue: number
  totalReserved: number
  totalAvailable: number
  stockouts: number
  critical: number
  low: number
  healthy: number
  totalSkus: number
  activeLocations: number
}

type Movement = {
  id: string
  productId: string
  variationId: string | null
  warehouseId: string | null
  locationId: string | null
  change: number
  balanceAfter: number
  quantityBefore: number | null
  reason: string
  referenceType: string | null
  referenceId: string | null
  notes: string | null
  actor: string | null
  createdAt: string
}

const REASON_TONE: Record<string, string> = {
  ORDER_PLACED: 'text-rose-600 bg-rose-50',
  ORDER_CANCELLED: 'text-emerald-600 bg-emerald-50',
  RETURN_RECEIVED: 'text-blue-600 bg-blue-50',
  RETURN_RESTOCKED: 'text-emerald-600 bg-emerald-50',
  INBOUND_RECEIVED: 'text-emerald-600 bg-emerald-50',
  SUPPLIER_DELIVERY: 'text-emerald-600 bg-emerald-50',
  MANUFACTURING_OUTPUT: 'text-violet-600 bg-violet-50',
  FBA_TRANSFER_OUT: 'text-orange-600 bg-orange-50',
  FBA_TRANSFER_IN: 'text-orange-600 bg-orange-50',
  TRANSFER_OUT: 'text-orange-600 bg-orange-50',
  TRANSFER_IN: 'text-orange-600 bg-orange-50',
  MANUAL_ADJUSTMENT: 'text-slate-600 bg-slate-100',
  WRITE_OFF: 'text-rose-700 bg-rose-100',
  INVENTORY_COUNT: 'text-amber-600 bg-amber-50',
  SYNC_RECONCILIATION: 'text-blue-600 bg-blue-50',
  RESERVATION_CREATED: 'text-violet-600 bg-violet-50',
  RESERVATION_RELEASED: 'text-slate-600 bg-slate-100',
  RESERVATION_CONSUMED: 'text-rose-600 bg-rose-50',
  STOCKLEVEL_BACKFILL: 'text-slate-600 bg-slate-100',
  PARENT_PRODUCT_CLEANUP: 'text-slate-600 bg-slate-100',
}

const LOCATION_TONE: Record<string, string> = {
  WAREHOUSE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  AMAZON_FBA: 'bg-orange-50 text-orange-700 border-orange-200',
  CHANNEL_RESERVED: 'bg-violet-50 text-violet-700 border-violet-200',
}

const STATUS_OPTIONS = [
  { value: 'IN_STOCK', label: 'In stock', tone: 'emerald' },
  { value: 'LOW', label: 'Low', tone: 'amber' },
  { value: 'CRITICAL', label: 'Critical', tone: 'orange' },
  { value: 'OUT_OF_STOCK', label: 'Out of stock', tone: 'rose' },
] as const

export default function StockWorkspace() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const view = (searchParams.get('view') as ViewMode) ?? 'table'
  const locationCode = searchParams.get('location') ?? ''
  const status = searchParams.get('status') ?? ''
  const search = searchParams.get('search') ?? ''
  const page = parseInt(searchParams.get('page') ?? '1', 10) || 1

  const [searchInput, setSearchInput] = useState(search)
  const [items, setItems] = useState<StockRow[]>([])
  const [productBundles, setProductBundles] = useState<ProductBundle[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [drawerProductId, setDrawerProductId] = useState<string | null>(null)
  const [locations, setLocations] = useState<LocationSummary[]>([])
  const [kpis, setKpis] = useState<Kpis | null>(null)

  const updateUrl = useCallback((patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }, [searchParams, pathname, router])

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== search) updateUrl({ search: searchInput || undefined, page: undefined })
    }, 250)
    return () => clearTimeout(t)
  }, [searchInput])

  const fetchStock = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams()
      qs.set('page', String(page))
      // Matrix + Cards aggregate by product, so they need a higher
      // pageSize ceiling to avoid splitting a single product across
      // pages. Table stays at the dense 50-row default.
      qs.set('pageSize', view === 'table' ? '50' : '100')
      if (status) qs.set('status', status)
      if (search) qs.set('search', search)
      // locationCode only applies to table (filters per-StockLevel rows).
      // Matrix shows all locations as columns; cards show all in badges.
      if (view === 'table' && locationCode) qs.set('locationCode', locationCode)
      const endpoint = view === 'table' ? '/api/stock' : '/api/stock/by-product'
      const res = await fetch(`${getBackendUrl()}${endpoint}?${qs.toString()}`, { cache: 'no-store' })
      if (!res.ok) {
        throw new Error(`stock list failed: ${res.status}`)
      }
      const data = await res.json()
      if (view === 'table') {
        setItems(data.items ?? [])
        setProductBundles([])
      } else {
        setProductBundles(data.products ?? [])
        setItems([])
      }
      setTotal(data.total ?? 0)
      setTotalPages(data.totalPages ?? 0)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load stock')
    } finally {
      setLoading(false)
    }
  }, [view, locationCode, status, search, page])

  const fetchSidecar = useCallback(async () => {
    try {
      const [locRes, kpiRes] = await Promise.all([
        fetch(`${getBackendUrl()}/api/stock/locations`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/stock/kpis`, { cache: 'no-store' }),
      ])
      if (locRes.ok) {
        const data = await locRes.json()
        setLocations(data.locations ?? [])
      }
      if (kpiRes.ok) {
        setKpis(await kpiRes.json())
      }
    } catch {
      // Sidecar is best-effort — the table still works without it.
    }
  }, [])

  useEffect(() => { fetchStock() }, [fetchStock])
  useEffect(() => { fetchSidecar() }, [fetchSidecar])

  // 30s poll + visibility-driven refresh
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        fetchStock()
        fetchSidecar()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchStock()
        fetchSidecar()
      }
    }, 30000)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      clearInterval(id)
    }
  }, [fetchStock, fetchSidecar])

  const filterCount = useMemo(
    () => [locationCode, status, search].filter(Boolean).length,
    [locationCode, status, search],
  )

  return (
    <div className="space-y-5">
      <PageHeader
        title="Stock"
        description="Multi-location inventory ledger across Riccione, Amazon FBA, and per-channel allocations."
        breadcrumbs={[{ label: 'Fulfillment', href: '/fulfillment' }, { label: 'Stock' }]}
        actions={
          <div className="flex items-center gap-2">
            <ViewToggle view={view} onChange={(v) => updateUrl({ view: v === 'table' ? undefined : v, page: undefined })} />
            <button
              onClick={() => { fetchStock(); fetchSidecar() }}
              className="h-8 px-3 text-[12px] border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        }
      />

      {/* KPI strip */}
      <KpiStrip kpis={kpis} />

      {/* Filter bar */}
      <Card>
        <div className="space-y-3">
          {/* Location chips */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mr-1">Location</span>
            <button
              onClick={() => updateUrl({ location: undefined, page: undefined })}
              className={`h-7 px-3 text-[11px] rounded-full font-medium border ${
                !locationCode
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
              }`}
            >All</button>
            {locations.map((loc) => (
              <button
                key={loc.id}
                onClick={() => updateUrl({ location: loc.code, page: undefined })}
                className={`h-7 px-3 text-[11px] rounded-full font-medium border inline-flex items-center gap-1.5 ${
                  locationCode === loc.code
                    ? 'bg-slate-900 text-white border-slate-900'
                    : `bg-white text-slate-600 border-slate-200 hover:border-slate-300`
                }`}
              >
                {loc.code}
                <span className={`text-[10px] tabular-nums ${locationCode === loc.code ? 'text-slate-300' : 'text-slate-400'}`}>
                  {loc.totalQuantity}
                </span>
              </button>
            ))}
          </div>

          {/* Search + status chips */}
          <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-slate-100">
            <div className="flex-1 min-w-[240px] max-w-md relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Search SKU, product name, ASIN"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="pl-7"
              />
            </div>
            <span className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold ml-1">Status</span>
            {STATUS_OPTIONS.map((s) => {
              const active = status === s.value
              const toneActive: Record<string, string> = {
                emerald: 'bg-emerald-50 text-emerald-700 border-emerald-300',
                amber: 'bg-amber-50 text-amber-700 border-amber-300',
                orange: 'bg-orange-50 text-orange-700 border-orange-300',
                rose: 'bg-rose-50 text-rose-700 border-rose-300',
              }
              return (
                <button
                  key={s.value}
                  onClick={() => updateUrl({ status: active ? undefined : s.value, page: undefined })}
                  className={`h-7 px-3 text-[11px] border rounded-full font-medium ${
                    active ? toneActive[s.tone] : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
                  }`}
                >{s.label}</button>
              )
            })}
            {filterCount > 0 && (
              <button
                onClick={() => updateUrl({ location: undefined, status: undefined, search: undefined, page: undefined })}
                className="h-7 px-2 text-[12px] text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
              >
                <X size={12} /> Clear
              </button>
            )}
            <div className="ml-auto text-[12px] text-slate-500">
              <span className="font-semibold text-slate-700 tabular-nums">{total}</span> rows
            </div>
          </div>
        </div>
      </Card>

      {/* Body — view-switched */}
      {(() => {
        const noResults = view === 'table' ? items.length === 0 : productBundles.length === 0
        if (error) {
          return (
            <Card>
              <div className="text-[13px] text-rose-700 py-8 text-center">
                Failed to load stock: {error}
              </div>
            </Card>
          )
        }
        if (loading && noResults) {
          return <Card><div className="text-[13px] text-slate-500 py-8 text-center">Loading stock…</div></Card>
        }
        if (noResults) {
          return (
            <EmptyState
              icon={Warehouse}
              title="No stock matches these filters"
              description={filterCount > 0 ? 'Try clearing filters.' : 'Stock levels appear once products are imported and seeded.'}
              action={filterCount > 0
                ? { label: 'Clear filters', onClick: () => updateUrl({ location: undefined, status: undefined, search: undefined, page: undefined }) }
                : { label: 'Go to Catalog', href: '/products' }
              }
            />
          )
        }
        if (view === 'matrix') {
          return <MatrixView products={productBundles} locations={locations} onOpenProduct={setDrawerProductId} />
        }
        if (view === 'cards') {
          return <CardsView products={productBundles} locations={locations} onOpenProduct={setDrawerProductId} />
        }
        return <TableView items={items} onOpenProduct={setDrawerProductId} />
      })()}

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-[12px] text-slate-500">
          <span>Page <span className="font-semibold text-slate-700 tabular-nums">{page}</span> of <span className="tabular-nums">{totalPages}</span></span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => updateUrl({ page: page <= 2 ? undefined : String(page - 1) })}
              disabled={page === 1}
              className="h-7 px-3 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >Previous</button>
            <button
              onClick={() => updateUrl({ page: String(Math.min(totalPages, page + 1)) })}
              disabled={page >= totalPages}
              className="h-7 px-3 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >Next</button>
          </div>
        </div>
      )}

      {drawerProductId && (
        <StockDrawer
          productId={drawerProductId}
          onClose={() => setDrawerProductId(null)}
          onChanged={() => { fetchStock(); fetchSidecar() }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// KPI strip
// ─────────────────────────────────────────────────────────────────────
function KpiStrip({ kpis }: { kpis: Kpis | null }) {
  if (!kpis) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <div className="h-[68px] flex items-center justify-center text-[12px] text-slate-400">…</div>
          </Card>
        ))}
      </div>
    )
  }

  const cards = [
    {
      icon: Boxes,
      label: 'Total stock value',
      value: `€${kpis.totalStockValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      detail: `${kpis.totalStockUnits.toLocaleString()} units across ${kpis.activeLocations} location${kpis.activeLocations === 1 ? '' : 's'}`,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      icon: AlertTriangle,
      label: 'Stockouts',
      value: kpis.stockouts.toLocaleString(),
      detail: `${kpis.totalSkus.toLocaleString()} SKUs total`,
      tone: kpis.stockouts > 0 ? 'bg-rose-50 text-rose-600' : 'bg-slate-50 text-slate-600',
    },
    {
      icon: TrendingDown,
      label: 'Critical stock',
      value: kpis.critical.toLocaleString(),
      detail: `+ ${kpis.low.toLocaleString()} below threshold`,
      tone: kpis.critical > 0 ? 'bg-orange-50 text-orange-600' : 'bg-slate-50 text-slate-600',
    },
    {
      icon: Layers,
      label: 'Available units',
      value: kpis.totalAvailable.toLocaleString(),
      detail: `${kpis.totalReserved.toLocaleString()} reserved`,
      tone: 'bg-blue-50 text-blue-600',
    },
  ]

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((c, i) => (
        <Card key={i}>
          <div className="flex items-start gap-3">
            <div className={`w-9 h-9 rounded-md inline-flex items-center justify-center flex-shrink-0 ${c.tone}`}>
              <c.icon size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{c.label}</div>
              <div className="text-[20px] font-semibold tabular-nums text-slate-900 mt-0.5">{c.value}</div>
              <div className="text-[11px] text-slate-500 mt-0.5 truncate">{c.detail}</div>
            </div>
          </div>
        </Card>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// StockDrawer — H.4 multi-location rebuild.
// One bundle fetch (/api/stock/product/:id) drives every section.
// ─────────────────────────────────────────────────────────────────────
type DrawerBundle = {
  product: {
    id: string; sku: string; name: string; amazonAsin: string | null
    totalStock: number; lowStockThreshold: number
    basePrice: number | null; costPrice: number | null
    thumbnailUrl: string | null
  }
  stockLevels: Array<{
    id: string
    location: { id: string; code: string; name: string; type: string; isActive: boolean }
    quantity: number; reserved: number; available: number
    reorderThreshold: number | null
    lastUpdatedAt: string; lastSyncedAt: string | null; syncStatus: string
    activeReservations: number
  }>
  channelListings: Array<{
    id: string; channel: string; marketplace: string
    listingStatus: string; syncStatus: string
    lastSyncedAt: string | null; lastSyncStatus: string | null; lastSyncError: string | null
    quantity: number | null; stockBuffer: number; externalListingId: string | null
  }>
  movements: Movement[]
  salesVelocity: {
    last30Units: number; last30Revenue: number
    avgDailyUnits: number; daysOfStock: number | null
    totalAvailable: number
    dailyHistory: Array<{ day: string; units: number; revenue: number; orders: number }>
  }
  atp: {
    leadTimeDays: number; leadTimeSource: string
    inboundWithinLeadTime: number; totalOpenInbound: number
    openShipments: Array<{ shipmentId: string; type: string; status: string; expectedAt: string | null; remainingUnits: number; reference: string | null }>
  } | null
  reservations: Array<{
    id: string; quantity: number; reason: string; orderId: string | null
    expiresAt: string; createdAt: string
    location: { id: string; code: string }
  }>
}

type ActionMode = null | { kind: 'adjust'; stockLevelId: string; locationCode: string } | { kind: 'transfer' } | { kind: 'reserve' }

function StockDrawer({ productId, onClose, onChanged }: { productId: string; onClose: () => void; onChanged: () => void }) {
  const [bundle, setBundle] = useState<DrawerBundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [action, setAction] = useState<ActionMode>(null)

  const fetchBundle = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/product/${productId}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`drawer load failed: ${res.status}`)
      setBundle(await res.json())
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load drawer')
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => { fetchBundle() }, [fetchBundle])

  const handleActionDone = useCallback(() => {
    setAction(null)
    fetchBundle()
    onChanged()
  }, [fetchBundle, onChanged])

  return (
    <div className="fixed inset-0 z-30 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" />
      <aside
        onClick={(e) => e.stopPropagation()}
        className="relative h-full w-full max-w-2xl bg-white shadow-2xl overflow-y-auto"
      >
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="text-[13px] font-semibold text-slate-900 inline-flex items-center gap-2">
            <Boxes size={14} /> Stock detail
          </div>
          <div className="flex items-center gap-2">
            <button onClick={fetchBundle} className="h-7 px-2 text-[11px] text-slate-500 hover:text-slate-900 inline-flex items-center gap-1">
              <RefreshCw size={11} /> Refresh
            </button>
            <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="p-5 space-y-5">
          {error && (
            <div className="text-[13px] text-rose-700 py-3 px-3 bg-rose-50 border border-rose-200 rounded">
              {error}
            </div>
          )}

          {loading && !bundle ? (
            <div className="text-[13px] text-slate-500 py-8 text-center">Loading…</div>
          ) : bundle ? (
            <>
              {/* Product header */}
              <div className="flex items-start gap-3">
                {bundle.product.thumbnailUrl ? (
                  <img src={bundle.product.thumbnailUrl} alt="" className="w-14 h-14 rounded object-cover bg-slate-100 flex-shrink-0" />
                ) : (
                  <div className="w-14 h-14 rounded bg-slate-100 flex items-center justify-center text-slate-400 flex-shrink-0">
                    <Package size={20} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-semibold text-slate-900">{bundle.product.name}</div>
                  <div className="text-[11px] text-slate-500 font-mono">
                    {bundle.product.sku}
                    {bundle.product.amazonAsin && <span> · {bundle.product.amazonAsin}</span>}
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-[12px] text-slate-600">
                    <span className="inline-flex items-center gap-1">
                      <Boxes size={11} className="text-slate-400" />
                      <span className="font-semibold tabular-nums">{bundle.product.totalStock}</span> total
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <LockIcon size={11} className="text-slate-400" />
                      <span className="tabular-nums">{bundle.salesVelocity.totalAvailable}</span> available
                    </span>
                  </div>
                </div>
              </div>

              {/* Quick actions */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => setAction({ kind: 'transfer' })}
                  disabled={bundle.stockLevels.length < 1}
                  className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-40"
                ><ArrowRightLeft size={12} /> Transfer</button>
                <button
                  onClick={() => setAction({ kind: 'reserve' })}
                  disabled={bundle.stockLevels.length < 1}
                  className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-40"
                ><LockIcon size={12} /> Reserve</button>
                <Link
                  href={`/products/${productId}/edit`}
                  className="h-8 px-3 text-[12px] bg-white text-slate-700 border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
                ><ExternalLink size={12} /> Open in editor</Link>
              </div>

              {/* Inline action panel */}
              {action?.kind === 'adjust' && (
                <AdjustPanel
                  stockLevelId={action.stockLevelId}
                  locationCode={action.locationCode}
                  onCancel={() => setAction(null)}
                  onDone={handleActionDone}
                />
              )}
              {action?.kind === 'transfer' && (
                <TransferPanel
                  productId={productId}
                  stockLevels={bundle.stockLevels}
                  onCancel={() => setAction(null)}
                  onDone={handleActionDone}
                />
              )}
              {action?.kind === 'reserve' && (
                <ReservePanel
                  productId={productId}
                  stockLevels={bundle.stockLevels}
                  onCancel={() => setAction(null)}
                  onDone={handleActionDone}
                />
              )}

              {/* Multi-location breakdown */}
              <Section title="Stock by location" icon={Warehouse}>
                {bundle.stockLevels.length === 0 ? (
                  <div className="text-[12px] text-slate-400 text-center py-3">No StockLevel rows yet.</div>
                ) : (
                  <ul className="space-y-1.5">
                    {bundle.stockLevels.map((sl) => (
                      <li key={sl.id} className="flex items-center justify-between gap-3 py-2 px-3 border border-slate-200 rounded">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${LOCATION_TONE[sl.location.type] ?? 'bg-slate-50 text-slate-600 border-slate-200'}`}>
                              {sl.location.code}
                            </span>
                            <span className="text-[12px] text-slate-700">{sl.location.name}</span>
                            {sl.activeReservations > 0 && (
                              <span className="text-[10px] text-violet-700 bg-violet-50 px-1.5 py-0.5 rounded">
                                {sl.activeReservations} active reservation{sl.activeReservations === 1 ? '' : 's'}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-[11px] text-slate-500 inline-flex items-center gap-3">
                            <span><span className="font-semibold tabular-nums text-slate-700">{sl.quantity}</span> on hand</span>
                            <span><span className="tabular-nums">{sl.reserved}</span> reserved</span>
                            <span><span className="tabular-nums">{sl.available}</span> available</span>
                            <span className="text-slate-400">· {formatRelative(sl.lastUpdatedAt)}</span>
                          </div>
                        </div>
                        <button
                          onClick={() => setAction({ kind: 'adjust', stockLevelId: sl.id, locationCode: sl.location.code })}
                          className="h-7 px-2 text-[11px] border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1"
                        >
                          <Plus size={11} className="-mr-0.5" /><Minus size={11} /> Adjust
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {/* Channel listing status */}
              {bundle.channelListings.length > 0 && (
                <Section title="Channel listings" icon={Activity}>
                  <ul className="space-y-1">
                    {bundle.channelListings.map((cl) => {
                      const tone =
                        cl.lastSyncStatus === 'FAILED' || cl.syncStatus === 'FAILED' ? 'rose' :
                        cl.syncStatus === 'PENDING' || cl.syncStatus === 'SYNCING' ? 'amber' :
                        cl.listingStatus === 'ACTIVE' ? 'emerald' : 'slate'
                      const toneCls: Record<string, string> = {
                        emerald: 'bg-emerald-50 text-emerald-700',
                        amber: 'bg-amber-50 text-amber-700',
                        rose: 'bg-rose-50 text-rose-700',
                        slate: 'bg-slate-100 text-slate-600',
                      }
                      return (
                        <li key={cl.id} className="flex items-center justify-between gap-3 py-1.5 px-2 -mx-2 border-b border-slate-100 last:border-0">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] font-semibold text-slate-700">{cl.channel} · {cl.marketplace}</span>
                              <span className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${toneCls[tone]}`}>
                                {cl.listingStatus}
                              </span>
                            </div>
                            <div className="text-[10px] text-slate-400 mt-0.5">
                              {cl.lastSyncedAt ? `Synced ${formatRelative(cl.lastSyncedAt)}` : 'Never synced'}
                              {cl.lastSyncError && <span className="text-rose-600"> · {cl.lastSyncError.slice(0, 60)}</span>}
                            </div>
                          </div>
                          <div className="text-right flex-shrink-0 text-[11px] text-slate-500 tabular-nums">
                            {cl.quantity == null ? <span className="text-slate-400">follows master</span> : <><span className="font-semibold text-slate-700">{cl.quantity}</span> shown</>}
                            {cl.stockBuffer > 0 && <span className="text-slate-400"> · −{cl.stockBuffer} buffer</span>}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </Section>
              )}

              {/* Sales velocity */}
              <Section
                title="Sales velocity (last 30d)"
                icon={TrendingDown}
                right={
                  bundle.salesVelocity.last30Units > 0 ? (
                    <span className="text-[11px] text-slate-500">
                      {bundle.salesVelocity.avgDailyUnits.toFixed(2)}/day avg
                    </span>
                  ) : null
                }
              >
                {bundle.salesVelocity.last30Units === 0 ? (
                  <div className="text-[12px] text-slate-400 py-2">No sales in the last 30 days.</div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-4 text-[12px] text-slate-700">
                      <div>
                        <span className="font-semibold tabular-nums">{bundle.salesVelocity.last30Units}</span>
                        <span className="text-slate-500 text-[11px]"> units</span>
                      </div>
                      <div>
                        <span className="font-semibold tabular-nums">€{bundle.salesVelocity.last30Revenue.toFixed(2)}</span>
                        <span className="text-slate-500 text-[11px]"> revenue</span>
                      </div>
                      {bundle.salesVelocity.daysOfStock != null && (
                        <div className={bundle.salesVelocity.daysOfStock <= 7 ? 'text-rose-700' : bundle.salesVelocity.daysOfStock <= 21 ? 'text-amber-700' : 'text-slate-700'}>
                          <span className="font-semibold tabular-nums">{bundle.salesVelocity.daysOfStock}</span>
                          <span className="text-[11px]"> days of stock</span>
                        </div>
                      )}
                    </div>
                    <Sparkline points={bundle.salesVelocity.dailyHistory.slice(-30).map((d) => d.units)} />
                  </div>
                )}
              </Section>

              {/* ATP / reorder */}
              {bundle.atp && (bundle.atp.totalOpenInbound > 0 || bundle.atp.leadTimeSource !== 'FALLBACK') && (
                <Section title="Replenishment" icon={Truck}>
                  <div className="text-[12px] text-slate-700 space-y-1">
                    <div>
                      Lead time:{' '}
                      <span className="font-semibold tabular-nums">{bundle.atp.leadTimeDays} days</span>
                      <span className="text-slate-400 text-[11px]"> · {bundle.atp.leadTimeSource.toLowerCase().replace(/_/g, ' ')}</span>
                    </div>
                    {bundle.atp.totalOpenInbound > 0 && (
                      <div>
                        Inbound:{' '}
                        <span className="font-semibold tabular-nums">{bundle.atp.totalOpenInbound}</span>
                        <span className="text-slate-500 text-[11px]"> units</span>
                        {bundle.atp.inboundWithinLeadTime !== bundle.atp.totalOpenInbound && (
                          <span className="text-slate-400 text-[11px]"> ({bundle.atp.inboundWithinLeadTime} within lead time)</span>
                        )}
                      </div>
                    )}
                    {bundle.atp.openShipments.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {bundle.atp.openShipments.slice(0, 5).map((s) => (
                          <li key={s.shipmentId} className="text-[11px] text-slate-500 inline-flex items-center gap-2">
                            <span className="font-mono">{s.reference ?? s.shipmentId.slice(0, 8)}</span>
                            <span>·</span>
                            <span>{s.type} {s.status.toLowerCase()}</span>
                            <span>·</span>
                            <span className="tabular-nums">{s.remainingUnits} units</span>
                            {s.expectedAt && <span className="text-slate-400">· ETA {new Date(s.expectedAt).toLocaleDateString()}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </Section>
              )}

              {/* Active reservations */}
              {bundle.reservations.length > 0 && (
                <Section title="Active reservations" icon={LockIcon}>
                  <ul className="space-y-1">
                    {bundle.reservations.map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-2 py-1.5 px-2 -mx-2 border-b border-slate-100 last:border-0">
                        <div className="min-w-0">
                          <div className="text-[12px] text-slate-700">
                            <span className="font-semibold tabular-nums">{r.quantity}</span> at{' '}
                            <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">{r.location.code}</span>
                            <span className="text-slate-400 text-[11px]"> · {r.reason}</span>
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {r.orderId && <span>order {r.orderId.slice(0, 8)} · </span>}
                            expires {formatRelative(r.expiresAt)}
                          </div>
                        </div>
                        <button
                          onClick={async () => {
                            if (!confirm(`Release ${r.quantity} units?`)) return
                            try {
                              const res = await fetch(`${getBackendUrl()}/api/stock/release/${r.id}`, { method: 'POST' })
                              if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Release failed')
                              handleActionDone()
                            } catch (e: any) { alert(e.message) }
                          }}
                          className="h-6 px-2 text-[10px] text-slate-500 hover:text-slate-900 border border-slate-200 rounded"
                        >Release</button>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {/* Movement history */}
              <Section title={`Movement history (${bundle.movements.length})`} icon={History}>
                {bundle.movements.length === 0 ? (
                  <div className="text-[12px] text-slate-400 text-center py-2">No movements yet.</div>
                ) : (
                  <ul className="space-y-1">
                    {bundle.movements.map((m) => (
                      <li key={m.id} className="flex items-start justify-between gap-3 py-1.5 px-2 -mx-2 border-b border-slate-100 last:border-0">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className={`text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${REASON_TONE[m.reason] ?? 'bg-slate-100 text-slate-600'}`}>
                              {m.reason.replace(/_/g, ' ')}
                            </span>
                            {m.referenceType && (
                              <span className="text-[10px] text-slate-400 font-mono">{m.referenceType}</span>
                            )}
                          </div>
                          {m.notes && <div className="text-[11px] text-slate-600 mt-0.5">{m.notes}</div>}
                          <div className="text-[10px] text-slate-400 mt-0.5">
                            {new Date(m.createdAt).toLocaleString()} {m.actor && `· ${m.actor}`}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <div className={`text-[14px] font-semibold tabular-nums ${m.change > 0 ? 'text-emerald-600' : m.change < 0 ? 'text-rose-600' : 'text-slate-500'}`}>
                            {m.change > 0 ? '+' : ''}{m.change}
                          </div>
                          <div className="text-[10px] text-slate-400 tabular-nums">→ {m.balanceAfter}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </>
          ) : null}
        </div>
      </aside>
    </div>
  )
}

function Section({ title, icon: Icon, right, children }: { title: string; icon: any; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 inline-flex items-center gap-1.5">
          <Icon size={11} className="text-slate-400" />
          {title}
        </div>
        {right}
      </div>
      {children}
    </div>
  )
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length === 0) return null
  const max = Math.max(...points, 1)
  return (
    <div className="flex items-end gap-px h-10 mt-1">
      {points.map((v, i) => (
        <div
          key={i}
          className="flex-1 bg-blue-200 rounded-sm min-h-[1px]"
          style={{ height: `${Math.max(2, (v / max) * 100)}%` }}
          title={`${v} units`}
        />
      ))}
    </div>
  )
}

function AdjustPanel({ stockLevelId, locationCode, onCancel, onDone }: { stockLevelId: string; locationCode: string; onCancel: () => void; onDone: () => void }) {
  const [change, setChange] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    const n = Number(change)
    if (!Number.isFinite(n) || n === 0) {
      alert('Enter a non-zero number (positive to add, negative to remove)')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/${stockLevelId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ change: n, notes: notes || null }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Adjust failed')
      onDone()
    } catch (e: any) {
      alert(e.message)
    } finally { setSubmitting(false) }
  }

  return (
    <div className="border border-slate-300 rounded-md p-3 bg-slate-50">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2 inline-flex items-center gap-1.5">
        Adjust at <span className="text-slate-700">{locationCode}</span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number" value={change} onChange={(e) => setChange(e.target.value)}
          placeholder="±n" autoFocus
          className="h-8 w-24 px-2 text-[13px] border border-slate-200 rounded font-mono tabular-nums"
        />
        <input
          type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="Reason (optional)"
          className="flex-1 h-8 px-2 text-[12px] border border-slate-200 rounded"
        />
        <button onClick={submit} disabled={submitting} className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50">Apply</button>
        <button onClick={onCancel} className="h-8 px-2 text-[12px] text-slate-500 hover:text-slate-900">Cancel</button>
      </div>
    </div>
  )
}

function TransferPanel({
  productId, stockLevels, onCancel, onDone,
}: { productId: string; stockLevels: DrawerBundle['stockLevels']; onCancel: () => void; onDone: () => void }) {
  const [fromId, setFromId] = useState<string>(stockLevels[0]?.location.id ?? '')
  const [toId, setToId] = useState<string>(stockLevels[1]?.location.id ?? stockLevels[0]?.location.id ?? '')
  const [qty, setQty] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    const n = Number(qty)
    if (!Number.isFinite(n) || n <= 0) { alert('Quantity must be > 0'); return }
    if (fromId === toId) { alert('From and to locations must differ'); return }
    setSubmitting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, fromLocationId: fromId, toLocationId: toId, quantity: n }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Transfer failed')
      onDone()
    } catch (e: any) {
      alert(e.message)
    } finally { setSubmitting(false) }
  }

  return (
    <div className="border border-slate-300 rounded-md p-3 bg-slate-50 space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 inline-flex items-center gap-1.5">
        <ArrowRightLeft size={11} /> Transfer between locations
      </div>
      <div className="flex items-center gap-2">
        <select value={fromId} onChange={(e) => setFromId(e.target.value)} className="h-8 flex-1 px-2 text-[12px] border border-slate-200 rounded">
          {stockLevels.map((sl) => (
            <option key={sl.id} value={sl.location.id}>From {sl.location.code} ({sl.available} avail)</option>
          ))}
        </select>
        <ArrowRightLeft size={12} className="text-slate-400" />
        <select value={toId} onChange={(e) => setToId(e.target.value)} className="h-8 flex-1 px-2 text-[12px] border border-slate-200 rounded">
          {stockLevels.map((sl) => (
            <option key={sl.id} value={sl.location.id}>To {sl.location.code}</option>
          ))}
        </select>
        <input
          type="number" value={qty} onChange={(e) => setQty(e.target.value)}
          placeholder="qty"
          className="h-8 w-20 px-2 text-[13px] border border-slate-200 rounded font-mono tabular-nums"
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className="h-8 px-2 text-[12px] text-slate-500 hover:text-slate-900">Cancel</button>
        <button onClick={submit} disabled={submitting} className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50">Transfer</button>
      </div>
      <div className="text-[10px] text-slate-500">
        If the target location has no StockLevel row, one is created with the transferred quantity.
      </div>
    </div>
  )
}

function ReservePanel({
  productId, stockLevels, onCancel, onDone,
}: { productId: string; stockLevels: DrawerBundle['stockLevels']; onCancel: () => void; onDone: () => void }) {
  const [locId, setLocId] = useState<string>(stockLevels[0]?.location.id ?? '')
  const [qty, setQty] = useState('')
  const [orderId, setOrderId] = useState('')
  const [reason, setReason] = useState<'PENDING_ORDER' | 'MANUAL_HOLD' | 'PROMOTION'>('MANUAL_HOLD')
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    const n = Number(qty)
    if (!Number.isFinite(n) || n <= 0) { alert('Quantity must be > 0'); return }
    setSubmitting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, locationId: locId, quantity: n, orderId: orderId || undefined, reason }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Reserve failed')
      onDone()
    } catch (e: any) {
      alert(e.message)
    } finally { setSubmitting(false) }
  }

  return (
    <div className="border border-slate-300 rounded-md p-3 bg-slate-50 space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 inline-flex items-center gap-1.5">
        <LockIcon size={11} /> Reserve stock
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <select value={locId} onChange={(e) => setLocId(e.target.value)} className="h-8 px-2 text-[12px] border border-slate-200 rounded">
          {stockLevels.map((sl) => (
            <option key={sl.id} value={sl.location.id}>{sl.location.code} ({sl.available} avail)</option>
          ))}
        </select>
        <select value={reason} onChange={(e) => setReason(e.target.value as any)} className="h-8 px-2 text-[12px] border border-slate-200 rounded">
          <option value="MANUAL_HOLD">Manual hold</option>
          <option value="PENDING_ORDER">Pending order</option>
          <option value="PROMOTION">Promotion</option>
        </select>
        <input
          type="number" value={qty} onChange={(e) => setQty(e.target.value)}
          placeholder="quantity"
          className="h-8 px-2 text-[13px] border border-slate-200 rounded font-mono tabular-nums"
        />
        <input
          type="text" value={orderId} onChange={(e) => setOrderId(e.target.value)}
          placeholder="Order ID (optional)"
          className="h-8 px-2 text-[12px] border border-slate-200 rounded"
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className="h-8 px-2 text-[12px] text-slate-500 hover:text-slate-900">Cancel</button>
        <button onClick={submit} disabled={submitting} className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50">Reserve</button>
      </div>
      <div className="text-[10px] text-slate-500">
        PENDING_ORDER reservations expire after 24h. Manual holds and promotions never expire automatically.
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// View toggle + view components
// ─────────────────────────────────────────────────────────────────────
function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  const tabs: Array<{ key: ViewMode; label: string; icon: any }> = [
    { key: 'table', label: 'Table', icon: TableIcon },
    { key: 'matrix', label: 'Matrix', icon: Grid },
    { key: 'cards', label: 'Cards', icon: LayoutGrid },
  ]
  return (
    <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`h-7 px-2.5 text-[12px] font-medium inline-flex items-center gap-1.5 rounded transition-colors ${
            view === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <t.icon size={12} />
          {t.label}
        </button>
      ))}
    </div>
  )
}

function TableView({ items, onOpenProduct }: { items: StockRow[]; onOpenProduct: (id: string) => void }) {
  return (
    <Card noPadding>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700 w-10"></th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">Product</th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">Location</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">On hand</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Reserved</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Available</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Threshold</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Cost</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Updated</th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const threshold = it.reorderThreshold ?? it.product.lowStockThreshold
              const stockTone =
                it.quantity === 0 ? 'text-rose-600' :
                it.quantity <= 5 ? 'text-orange-600' :
                it.quantity <= threshold ? 'text-amber-600' : 'text-slate-900'
              return (
                <tr
                  key={it.id}
                  onClick={() => onOpenProduct(it.product.id)}
                  className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                >
                  <td className="px-3 py-2">
                    {it.product.thumbnailUrl ? (
                      <img src={it.product.thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover bg-slate-100" />
                    ) : (
                      <div className="w-8 h-8 rounded bg-slate-100 flex items-center justify-center text-slate-400">
                        <Package size={14} />
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-[13px] font-medium text-slate-900 truncate max-w-md">{it.product.name}</div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      {it.product.sku}
                      {it.variation && <span> · {it.variation.sku}</span>}
                      {it.product.amazonAsin && <span> · {it.product.amazonAsin}</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${
                      LOCATION_TONE[it.location.type] ?? 'bg-slate-50 text-slate-600 border-slate-200'
                    }`} title={it.location.name}>
                      {it.location.code}
                    </span>
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums font-semibold ${stockTone}`}>{it.quantity}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{it.reserved}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">{it.available}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-500">{threshold}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                    {it.product.costPrice != null ? `€${it.product.costPrice.toFixed(2)}` : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-400 text-[11px]">
                    {formatRelative(it.lastUpdatedAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <ChevronRight size={14} className="text-slate-400 inline" />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// Color-coded heatmap. Cells show quantity; tone is a function of
// quantity (red=zero, orange=critical, amber=low, blue tint scaled
// by quantity for healthy). Empty cell = no StockLevel row, rendered
// as a grey dash so allocation gaps are visually obvious.
function MatrixView({
  products, locations, onOpenProduct,
}: { products: ProductBundle[]; locations: LocationSummary[]; onOpenProduct: (id: string) => void }) {
  // Compute the max quantity across the visible page for color scaling.
  const maxQty = Math.max(
    1,
    ...products.flatMap((p) => p.stockLevels.map((sl) => sl.quantity)),
  )

  return (
    <Card noPadding>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="border-b border-slate-200 bg-slate-50 sticky top-0">
            <tr>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700 sticky left-0 bg-slate-50 z-10 min-w-[280px]">
                Product
              </th>
              {locations.map((loc) => (
                <th
                  key={loc.id}
                  className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700 min-w-[80px]"
                  title={loc.name}
                >
                  {loc.code}
                </th>
              ))}
              <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Total</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const cellByLoc = new Map(p.stockLevels.map((sl) => [sl.locationId, sl]))
              return (
                <tr
                  key={p.id}
                  onClick={() => onOpenProduct(p.id)}
                  className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                >
                  <td className="px-3 py-2 sticky left-0 bg-white hover:bg-slate-50 z-10 min-w-[280px]">
                    <div className="flex items-center gap-2">
                      {p.thumbnailUrl ? (
                        <img src={p.thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover bg-slate-100 flex-shrink-0" />
                      ) : (
                        <div className="w-8 h-8 rounded bg-slate-100 flex items-center justify-center text-slate-400 flex-shrink-0">
                          <Package size={14} />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-slate-900 truncate max-w-[220px]">{p.name}</div>
                        <div className="text-[11px] text-slate-500 font-mono">{p.sku}</div>
                      </div>
                    </div>
                  </td>
                  {locations.map((loc) => {
                    const cell = cellByLoc.get(loc.id)
                    if (!cell) {
                      return (
                        <td key={loc.id} className="px-3 py-2 text-right text-slate-300">
                          —
                        </td>
                      )
                    }
                    return (
                      <td key={loc.id} className="px-3 py-2 text-right">
                        <MatrixCell quantity={cell.quantity} reserved={cell.reserved} maxQty={maxQty} threshold={p.lowStockThreshold} />
                      </td>
                    )
                  })}
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">
                    {p.totalStock}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function MatrixCell({ quantity, reserved, maxQty, threshold }: { quantity: number; reserved: number; maxQty: number; threshold: number }) {
  const tone =
    quantity === 0 ? 'bg-rose-100 text-rose-800' :
    quantity <= 5 ? 'bg-orange-100 text-orange-800' :
    quantity <= threshold ? 'bg-amber-100 text-amber-800' :
    // Healthy → blue tint scaled by quantity / maxQty
    quantity > maxQty * 0.66 ? 'bg-blue-200 text-blue-900' :
    quantity > maxQty * 0.33 ? 'bg-blue-100 text-blue-800' :
    'bg-blue-50 text-blue-700'
  return (
    <span
      className={`inline-block min-w-[40px] px-2 py-1 rounded text-center font-semibold tabular-nums ${tone}`}
      title={reserved > 0 ? `${quantity} on hand (${reserved} reserved)` : `${quantity} on hand`}
    >
      {quantity}
      {reserved > 0 && (
        <span className="ml-1 text-[9px] opacity-60">({quantity - reserved})</span>
      )}
    </span>
  )
}

function CardsView({
  products, locations, onOpenProduct,
}: { products: ProductBundle[]; locations: LocationSummary[]; onOpenProduct: (id: string) => void }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {products.map((p) => {
        const cellByLoc = new Map(p.stockLevels.map((sl) => [sl.locationId, sl]))
        const stockTone =
          p.totalStock === 0 ? 'text-rose-600' :
          p.totalStock <= 5 ? 'text-orange-600' :
          p.totalStock <= p.lowStockThreshold ? 'text-amber-600' : 'text-slate-900'
        return (
          <Card
            key={p.id}
            className="cursor-pointer hover:border-slate-300 transition-colors"
          >
            <button onClick={() => onOpenProduct(p.id)} className="block w-full text-left">
              {p.thumbnailUrl ? (
                <img src={p.thumbnailUrl} alt="" className="w-full aspect-square rounded object-cover bg-slate-100 mb-3" />
              ) : (
                <div className="w-full aspect-square rounded bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
                  <Package size={28} />
                </div>
              )}
              <div className="text-[13px] font-medium text-slate-900 line-clamp-2 min-h-[36px]">{p.name}</div>
              <div className="text-[11px] text-slate-500 font-mono mt-0.5 truncate">{p.sku}</div>
              <div className={`text-[24px] font-semibold tabular-nums mt-2 ${stockTone}`}>
                {p.totalStock}
                <span className="text-[11px] text-slate-500 font-normal ml-1.5">total</span>
              </div>
              <div className="mt-2 flex items-center gap-1 flex-wrap">
                {locations.map((loc) => {
                  const cell = cellByLoc.get(loc.id)
                  if (!cell) {
                    return (
                      <span
                        key={loc.id}
                        className="text-[10px] font-mono uppercase px-1.5 py-0.5 border border-slate-200 rounded bg-slate-50 text-slate-300"
                        title={`No stock at ${loc.code}`}
                      >
                        {loc.code} —
                      </span>
                    )
                  }
                  const tone =
                    cell.quantity === 0 ? 'border-rose-200 bg-rose-50 text-rose-700' :
                    cell.quantity <= 5 ? 'border-orange-200 bg-orange-50 text-orange-700' :
                    cell.quantity <= p.lowStockThreshold ? 'border-amber-200 bg-amber-50 text-amber-700' :
                    'border-emerald-200 bg-emerald-50 text-emerald-700'
                  return (
                    <span
                      key={loc.id}
                      className={`text-[10px] font-mono uppercase px-1.5 py-0.5 border rounded ${tone}`}
                      title={`${loc.name}: ${cell.quantity} on hand, ${cell.available} available`}
                    >
                      {loc.code} <span className="font-bold">{cell.quantity}</span>
                    </span>
                  )
                })}
              </div>
            </button>
          </Card>
        )
      })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────
function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}
