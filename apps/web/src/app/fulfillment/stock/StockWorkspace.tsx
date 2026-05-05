'use client'

// FULFILLMENT B.3 — Stock workspace with movement audit drawer + manual adjust.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  Warehouse, Search, RefreshCw, Package, ChevronRight,
  X, History, ExternalLink,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'

type StockItem = {
  id: string
  sku: string
  name: string
  totalStock: number
  lowStockThreshold: number
  fulfillmentChannel: string | null
  fulfillmentMethod: string | null
  amazonAsin: string | null
  basePrice: number | null
  costPrice: number | null
  thumbnailUrl: string | null
  channelCount: number
  listings: Array<{ channel: string; marketplace: string; listingStatus: string; quantity: number | null; stockBuffer: number }>
  updatedAt: string
}

type Movement = {
  id: string
  productId: string
  variationId: string | null
  warehouseId: string | null
  change: number
  balanceAfter: number
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
  MANUAL_ADJUSTMENT: 'text-slate-600 bg-slate-100',
  WRITE_OFF: 'text-rose-700 bg-rose-100',
  INVENTORY_COUNT: 'text-amber-600 bg-amber-50',
}

const CHANNEL_TONE: Record<string, string> = {
  AMAZON: 'bg-orange-50 text-orange-700 border-orange-200',
  EBAY: 'bg-blue-50 text-blue-700 border-blue-200',
  SHOPIFY: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  WOOCOMMERCE: 'bg-violet-50 text-violet-700 border-violet-200',
  ETSY: 'bg-rose-50 text-rose-700 border-rose-200',
}

export default function StockWorkspace() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const tab = (searchParams.get('tab') as 'ALL' | 'FBA' | 'FBM') ?? 'ALL'
  const lowStock = searchParams.get('lowStock') === 'true'
  const outOfStock = searchParams.get('outOfStock') === 'true'
  const search = searchParams.get('search') ?? ''
  const page = parseInt(searchParams.get('page') ?? '1', 10) || 1

  const [searchInput, setSearchInput] = useState(search)
  const [items, setItems] = useState<StockItem[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [drawerProductId, setDrawerProductId] = useState<string | null>(null)

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
    try {
      const qs = new URLSearchParams()
      qs.set('page', String(page))
      qs.set('pageSize', '50')
      if (tab === 'FBA' || tab === 'FBM') qs.set('fulfillment', tab)
      if (lowStock) qs.set('lowStock', 'true')
      if (outOfStock) qs.set('outOfStock', 'true')
      if (search) qs.set('search', search)
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/stock?${qs.toString()}`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setItems(data.items ?? [])
        setTotal(data.total ?? 0)
        setTotalPages(data.totalPages ?? 0)
      }
    } finally { setLoading(false) }
  }, [tab, lowStock, outOfStock, search, page])

  useEffect(() => { fetchStock() }, [fetchStock])

  // 30s poll + visibilitychange refresh — same pattern as dashboard
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') fetchStock() }
    document.addEventListener('visibilitychange', onVis)
    const id = setInterval(() => { if (document.visibilityState === 'visible') fetchStock() }, 30000)
    return () => { document.removeEventListener('visibilitychange', onVis); clearInterval(id) }
  }, [fetchStock])

  const counts = useMemo(() => ({
    lowStock: items.filter((i) => i.totalStock > 0 && i.totalStock <= 5).length,
    outOfStock: items.filter((i) => i.totalStock === 0).length,
  }), [items])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Stock"
        description="Inventory levels across all fulfillment channels with full audit trail."
        breadcrumbs={[{ label: 'Fulfillment', href: '/fulfillment' }, { label: 'Stock' }]}
      />

      {/* Tabs + summary */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5">
          {(['ALL', 'FBA', 'FBM'] as const).map((t) => (
            <button
              key={t}
              onClick={() => updateUrl({ tab: t === 'ALL' ? undefined : t, page: undefined })}
              className={`h-7 px-3 text-[12px] font-medium rounded transition-colors ${tab === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
            >{t}</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="text-[12px] text-slate-500">
            <span className="font-semibold text-slate-700 tabular-nums">{total}</span> products
            {' · '}
            <span className={counts.lowStock > 0 ? 'text-amber-700' : ''}>{counts.lowStock} low</span>
            {' · '}
            <span className={counts.outOfStock > 0 ? 'text-rose-700' : ''}>{counts.outOfStock} out</span>
          </div>
          <button
            onClick={fetchStock}
            className="h-8 px-3 text-[12px] border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      {/* Search + chips */}
      <Card>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex-1 min-w-[240px] max-w-md relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder="Search SKU, product name, or ASIN"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-7"
            />
          </div>
          <button
            onClick={() => updateUrl({ lowStock: lowStock ? undefined : 'true', outOfStock: undefined, page: undefined })}
            className={`h-7 px-3 text-[11px] border rounded-full font-medium ${lowStock ? 'bg-amber-50 text-amber-700 border-amber-300' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'}`}
          >Low stock</button>
          <button
            onClick={() => updateUrl({ outOfStock: outOfStock ? undefined : 'true', lowStock: undefined, page: undefined })}
            className={`h-7 px-3 text-[11px] border rounded-full font-medium ${outOfStock ? 'bg-rose-50 text-rose-700 border-rose-300' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'}`}
          >Out of stock</button>
        </div>
      </Card>

      {/* Table */}
      {loading && items.length === 0 ? (
        <Card><div className="text-[13px] text-slate-500 py-8 text-center">Loading stock…</div></Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Warehouse}
          title="No products match these filters"
          description="Try clearing filters, or import products from Amazon."
          action={{ label: 'Go to Catalog', href: '/products' }}
        />
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700 w-10"></th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">Product</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">Method</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">Channels</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Stock</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Threshold</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Cost</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const stockTone = it.totalStock === 0 ? 'text-rose-600' : it.totalStock <= it.lowStockThreshold ? 'text-amber-600' : 'text-slate-900'
                  return (
                    <tr
                      key={it.id}
                      onClick={() => setDrawerProductId(it.id)}
                      className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                    >
                      <td className="px-3 py-2">
                        {it.thumbnailUrl ? (
                          <img src={it.thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover bg-slate-100" />
                        ) : (
                          <div className="w-8 h-8 rounded bg-slate-100 flex items-center justify-center text-slate-400">
                            <Package size={14} />
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-[13px] font-medium text-slate-900 truncate max-w-md">{it.name}</div>
                        <div className="text-[11px] text-slate-500 font-mono">{it.sku}{it.amazonAsin && ` · ${it.amazonAsin}`}</div>
                      </td>
                      <td className="px-3 py-2">
                        {it.fulfillmentMethod ? (
                          <Badge variant={it.fulfillmentMethod === 'FBA' ? 'warning' : 'info'} size="sm">
                            {it.fulfillmentMethod}
                          </Badge>
                        ) : <span className="text-slate-400 text-[11px]">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1 flex-wrap">
                          {it.listings.length === 0 && <span className="text-slate-400 text-[11px]">No listings</span>}
                          {it.listings.slice(0, 3).map((l, i) => (
                            <span key={i} className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${CHANNEL_TONE[l.channel] ?? 'bg-slate-50 text-slate-600 border-slate-200'}`} title={`${l.channel} · ${l.marketplace} · ${l.listingStatus}`}>
                              {l.channel.slice(0, 3)}
                            </span>
                          ))}
                          {it.listings.length > 3 && <span className="text-[10px] text-slate-400">+{it.listings.length - 3}</span>}
                        </div>
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums font-semibold ${stockTone}`}>{it.totalStock}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">{it.lowStockThreshold}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-600">
                        {it.costPrice != null ? `€${it.costPrice.toFixed(2)}` : <span className="text-slate-400">—</span>}
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
          onChanged={fetchStock}
        />
      )}
    </div>
  )
}

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
                <span className="text-[11px] uppercase tracking-wider text-slate-500">Current stock</span>
                <span className="text-[20px] font-semibold tabular-nums text-slate-900">{product.totalStock}</span>
              </div>
            </div>
          )}

          {/* Manual adjust */}
          <div className="border border-slate-200 rounded-md p-3 bg-slate-50/50">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Manual adjustment</div>
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
            <div className="text-[10px] text-slate-500 mt-1.5">Positive adds stock, negative removes. Logged with reason "MANUAL_ADJUSTMENT".</div>
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
                      <div className={`text-[14px] font-semibold tabular-nums ${m.change > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
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
