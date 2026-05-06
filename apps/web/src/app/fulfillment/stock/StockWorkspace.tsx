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
  X, History, ExternalLink,
  Boxes, AlertTriangle, TrendingDown, Layers,
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

  const locationCode = searchParams.get('location') ?? ''
  const status = searchParams.get('status') ?? ''
  const search = searchParams.get('search') ?? ''
  const page = parseInt(searchParams.get('page') ?? '1', 10) || 1

  const [searchInput, setSearchInput] = useState(search)
  const [items, setItems] = useState<StockRow[]>([])
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
      qs.set('pageSize', '50')
      if (locationCode) qs.set('locationCode', locationCode)
      if (status) qs.set('status', status)
      if (search) qs.set('search', search)
      const res = await fetch(`${getBackendUrl()}/api/stock?${qs.toString()}`, { cache: 'no-store' })
      if (!res.ok) {
        throw new Error(`stock list failed: ${res.status}`)
      }
      const data = await res.json()
      setItems(data.items ?? [])
      setTotal(data.total ?? 0)
      setTotalPages(data.totalPages ?? 0)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load stock')
    } finally {
      setLoading(false)
    }
  }, [locationCode, status, search, page])

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
          <button
            onClick={() => { fetchStock(); fetchSidecar() }}
            className="h-8 px-3 text-[12px] border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5"
          >
            <RefreshCw size={12} /> Refresh
          </button>
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

      {/* Table */}
      {error ? (
        <Card>
          <div className="text-[13px] text-rose-700 py-8 text-center">
            Failed to load stock: {error}
          </div>
        </Card>
      ) : loading && items.length === 0 ? (
        <Card><div className="text-[13px] text-slate-500 py-8 text-center">Loading stock…</div></Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Warehouse}
          title="No stock matches these filters"
          description={filterCount > 0 ? 'Try clearing filters.' : 'Stock levels appear once products are imported and seeded.'}
          action={filterCount > 0
            ? { label: 'Clear filters', onClick: () => updateUrl({ location: undefined, status: undefined, search: undefined, page: undefined }) }
            : { label: 'Go to Catalog', href: '/products' }
          }
        />
      ) : (
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
                      onClick={() => setDrawerProductId(it.product.id)}
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
      )}

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
// StockDrawer (carried over from B.3 — full multi-location rebuild
// lands in Commit 4. Still talks to the legacy endpoints which remain
// live alongside /api/stock).
// ─────────────────────────────────────────────────────────────────────
function StockDrawer({ productId, onClose, onChanged }: { productId: string; onClose: () => void; onChanged: () => void }) {
  const [movements, setMovements] = useState<Movement[]>([])
  const [loading, setLoading] = useState(true)
  const [adjustValue, setAdjustValue] = useState<string>('')
  const [adjustNotes, setAdjustNotes] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [product, setProduct] = useState<{ sku: string; name: string; totalStock: number } | null>(null)

  const fetchMovements = useCallback(async () => {
    setLoading(true)
    try {
      const [mvRes, prodRes] = await Promise.all([
        fetch(`${getBackendUrl()}/api/fulfillment/stock/${productId}/movements?limit=200`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/inventory/${productId}`, { cache: 'no-store' }),
      ])
      if (mvRes.ok) {
        const data = await mvRes.json()
        setMovements(data.movements ?? [])
      }
      if (prodRes.ok) {
        const data = await prodRes.json()
        setProduct({ sku: data.sku, name: data.name, totalStock: data.totalStock ?? 0 })
      }
    } finally { setLoading(false) }
  }, [productId])

  useEffect(() => { fetchMovements() }, [fetchMovements])

  const submitAdjust = async () => {
    const change = Number(adjustValue)
    if (!Number.isFinite(change) || change === 0) {
      alert('Enter a non-zero number (positive to add, negative to remove)')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/stock/${productId}/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ change, notes: adjustNotes || null }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Adjust failed')
      }
      setAdjustValue('')
      setAdjustNotes('')
      await fetchMovements()
      onChanged()
    } catch (e: any) {
      alert(e.message)
    } finally { setSubmitting(false) }
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" />
      <aside
        onClick={(e) => e.stopPropagation()}
        className="relative h-full w-full max-w-xl bg-white shadow-2xl overflow-y-auto"
      >
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="text-[13px] font-semibold text-slate-900 inline-flex items-center gap-2">
            <History size={14} /> Stock Movement
          </div>
          <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100">
            <X size={16} />
          </button>
        </header>
        <div className="p-5 space-y-4">
          {product && (
            <div>
              <div className="text-[14px] font-semibold text-slate-900">{product.name}</div>
              <div className="text-[11px] text-slate-500 font-mono">{product.sku}</div>
              <div className="mt-2 inline-flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wider text-slate-500">Current stock (all locations)</span>
                <span className="text-[20px] font-semibold tabular-nums text-slate-900">{product.totalStock}</span>
              </div>
            </div>
          )}

          {/* Manual adjust */}
          <div className="border border-slate-200 rounded-md p-3 bg-slate-50/50">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Manual adjustment (IT-MAIN)</div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={adjustValue}
                onChange={(e) => setAdjustValue(e.target.value)}
                placeholder="±n"
                className="h-8 w-24 px-2 text-[13px] border border-slate-200 rounded font-mono tabular-nums"
              />
              <input
                type="text"
                value={adjustNotes}
                onChange={(e) => setAdjustNotes(e.target.value)}
                placeholder="Reason (optional)"
                className="flex-1 h-8 px-2 text-[12px] border border-slate-200 rounded"
              />
              <button
                onClick={submitAdjust}
                disabled={submitting}
                className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50"
              >Apply</button>
            </div>
            <div className="text-[10px] text-slate-500 mt-1.5">Positive adds, negative removes. Routed to IT-MAIN; per-location adjust lands in Commit 4.</div>
          </div>

          {/* Movement log */}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">History</div>
            {loading ? (
              <div className="text-[12px] text-slate-500">Loading…</div>
            ) : movements.length === 0 ? (
              <div className="text-[12px] text-slate-400 text-center py-6">No movements yet.</div>
            ) : (
              <ul className="space-y-1">
                {movements.map((m) => (
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
          </div>

          <div className="pt-3 border-t border-slate-100 flex items-center gap-2">
            <Link
              href={`/products/${productId}/edit`}
              className="h-8 px-3 text-[12px] bg-white text-slate-700 border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
            ><ExternalLink size={12} /> Open in editor</Link>
          </div>
        </div>
      </aside>
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
