/**
 * F1 — Product drawer.
 *
 * Slide-in panel mounted from the /products grid. Click a product row,
 * the drawer opens with that product's full state without a route
 * navigation. Esc closes; clicking the dim overlay closes; the URL
 * carries `?drawer=<productId>` so direct links work and back/forward
 * behave naturally.
 *
 * Tabs:
 *   Details   master data + image gallery + quick-edit price/stock
 *             (the same PATCH /api/products/:id the inline grid uses,
 *             with the same atomic guarantees from B4).
 *   Listings  per-channel + per-marketplace summary; click-through to
 *             /listings/:id for the deep-dive.
 *   Activity  AuditLog rows for this product. F3 populates the data
 *             fetch; the tab structure ships now so the empty state
 *             is in place.
 *
 * Footer:
 *   "Open full edit" link to /products/:id/edit for power-user work
 *   that doesn't fit the drawer.
 */

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  X,
  ExternalLink,
  Package,
  ChevronRight,
  AlertCircle,
  Loader2,
  Activity,
  Boxes,
  Edit3,
  Image as ImageIcon,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

interface ProductDetail {
  id: string
  sku: string
  name: string
  brand: string | null
  productType: string | null
  status: string
  basePrice: string | number | null
  totalStock: number | null
  lowStockThreshold: number | null
  amazonAsin: string | null
  ebayItemId: string | null
  isParent: boolean
  parentId: string | null
  weightValue: number | null
  weightUnit: string | null
  description: string | null
  fulfillmentMethod: string | null
  updatedAt: string
  createdAt: string
  _count?: {
    images: number
    channelListings: number
    variations: number
  }
  channelListings?: Array<{
    id: string
    channel: string
    marketplace: string
    listingStatus: string
    syncStatus: string | null
    lastSyncStatus: string | null
    lastSyncError: string | null
    lastSyncedAt: string | null
    isPublished: boolean
    price: string | number | null
    quantity: number | null
    // F9 — drift signals from Phase 13. masterPrice / masterQuantity
    // are the snapshots maintained by MasterPriceService and
    // applyStockMovement; they tell us what the listing thinks the
    // master value was at last sync. Drift = followMasterPrice=false
    // AND the snapshot differs from the published price.
    masterPrice?: string | number | null
    masterQuantity?: number | null
    followMasterPrice?: boolean
    followMasterQuantity?: boolean
    title: string | null
    externalListingId: string | null
  }>
  images?: Array<{ url: string; type: string | null }>
}

export interface ProductDrawerProps {
  productId: string | null
  onClose: () => void
  /** Called after a successful in-drawer mutation so the parent can
   *  refetch the grid. Phase 10 invalidation already broadcasts; this
   *  is the in-tab signal. */
  onChanged?: () => void
}

type Tab = 'details' | 'listings' | 'activity'

export default function ProductDrawer({
  productId,
  onClose,
  onChanged,
}: ProductDrawerProps) {
  const [tab, setTab] = useState<Tab>('details')
  const [data, setData] = useState<ProductDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Reset tab + state when productId changes (e.g. user clicks
  // a different row while the drawer is open).
  useEffect(() => {
    if (!productId) return
    setTab('details')
    setData(null)
    setError(null)
  }, [productId])

  const fetchDetail = useCallback(async () => {
    if (!productId) return
    setLoading(true)
    setError(null)
    try {
      // Reuses the existing /api/products/:id/health endpoint which
      // already returns Product + nested ChannelListings + counts +
      // images. Single round-trip, ETag-cached (P0/A1).
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/health`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setData(json as ProductDetail)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    if (productId) fetchDetail()
  }, [productId, fetchDetail])

  // Esc closes. Click outside the inner panel closes too.
  useEffect(() => {
    if (!productId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [productId, onClose])

  if (!productId) return null

  return (
    <div
      className="fixed inset-0 z-40 bg-slate-900/30 flex justify-end"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Product details"
    >
      <div
        ref={containerRef}
        className="w-full max-w-[640px] bg-white shadow-2xl border-l border-slate-200 flex flex-col h-full"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-slate-200">
          <div className="flex-shrink-0 w-12 h-12 rounded bg-slate-100 flex items-center justify-center overflow-hidden">
            {data?.images?.[0]?.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={data.images[0].url}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <Package className="w-5 h-5 text-slate-400" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-[14px] font-semibold text-slate-900 truncate">
                {data?.name ?? (loading ? 'Loading…' : 'Product')}
              </h2>
              {data?.isParent && (
                <a
                  href={`/products/${data.id}/matrix`}
                  className="inline-flex items-center h-5 px-1.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700 hover:bg-blue-100"
                  title="Open the variant matrix editor"
                >
                  Parent · {data._count?.variations ?? 0} variants
                </a>
              )}
              {data?.status && (
                <StatusBadge status={data.status} />
              )}
            </div>
            <div className="flex items-center gap-3 text-[11px] text-slate-500 font-mono mt-0.5">
              <span>{data?.sku ?? '—'}</span>
              {data?.amazonAsin && (
                <a
                  href={`https://amazon.com/dp/${data.amazonAsin}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 hover:text-blue-600"
                >
                  ASIN {data.amazonAsin} <ExternalLink className="w-3 h-3" />
                </a>
              )}
              {data?.ebayItemId && <span>eBay {data.ebayItemId}</span>}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 -mr-1"
            aria-label="Close drawer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center border-b border-slate-200 px-5">
          <DrawerTab active={tab === 'details'} onClick={() => setTab('details')}>
            <Edit3 className="w-3 h-3" /> Details
          </DrawerTab>
          <DrawerTab
            active={tab === 'listings'}
            onClick={() => setTab('listings')}
            count={data?._count?.channelListings}
          >
            <Boxes className="w-3 h-3" /> Listings
          </DrawerTab>
          <DrawerTab
            active={tab === 'activity'}
            onClick={() => setTab('activity')}
          >
            <Activity className="w-3 h-3" /> Activity
          </DrawerTab>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && !data && (
            <div className="flex items-center justify-center py-12 text-slate-400 text-[12px]">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…
            </div>
          )}
          {error && (
            <div className="m-5 border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-[12px] text-rose-800 flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>Failed to load: {error}</span>
            </div>
          )}
          {data && tab === 'details' && (
            <DetailsTab
              product={data}
              onSaved={() => {
                fetchDetail()
                onChanged?.()
              }}
            />
          )}
          {data && tab === 'listings' && <ListingsTab listings={data.channelListings ?? []} />}
          {data && tab === 'activity' && <ActivityTab productId={data.id} />}
        </div>

        {/* Footer */}
        {data && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200 bg-slate-50">
            <span className="text-[11px] text-slate-500">
              Updated {new Date(data.updatedAt).toLocaleString()}
            </span>
            <Link
              href={`/products/${data.id}/edit`}
              className="inline-flex items-center gap-1 text-[12px] font-medium text-blue-700 hover:underline"
            >
              Open full edit
              <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}

function DrawerTab({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  count?: number | null
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-2.5 text-[12px] font-medium border-b-2 -mb-px transition-colors',
        active
          ? 'border-blue-500 text-blue-700'
          : 'border-transparent text-slate-600 hover:text-slate-900',
      )}
    >
      {children}
      {count != null && count > 0 && (
        <span className="text-[10px] text-slate-500 font-normal">{count}</span>
      )}
    </button>
  )
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'ACTIVE'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'DRAFT'
      ? 'bg-slate-100 text-slate-600'
      : 'bg-rose-50 text-rose-700'
  return (
    <span
      className={cn(
        'inline-flex items-center h-5 px-1.5 rounded text-[10px] font-medium',
        tone,
      )}
    >
      {status}
    </span>
  )
}

/* ─────────────────────────── tabs ─────────────────────────── */

function DetailsTab({
  product,
  onSaved,
}: {
  product: ProductDetail
  onSaved: () => void
}) {
  const [basePrice, setBasePrice] = useState(
    product.basePrice != null ? String(Number(product.basePrice)) : '',
  )
  const [totalStock, setTotalStock] = useState(
    product.totalStock != null ? String(product.totalStock) : '',
  )
  const [threshold, setThreshold] = useState(
    product.lowStockThreshold != null ? String(product.lowStockThreshold) : '',
  )
  const [saving, setSaving] = useState<'basePrice' | 'totalStock' | 'threshold' | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const save = useCallback(
    async (
      field: 'basePrice' | 'totalStock' | 'threshold',
      raw: string,
    ) => {
      setSaving(field)
      try {
        const body: Record<string, unknown> = {}
        if (field === 'basePrice') body.basePrice = Number(raw)
        else if (field === 'totalStock') body.totalStock = Number(raw)
        else body.lowStockThreshold = Number(raw)
        const res = await fetch(`${getBackendUrl()}/api/products/${product.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
        setSavedAt(Date.now())
        emitInvalidation({
          type: 'product.updated',
          id: product.id,
          fields: [field === 'threshold' ? 'lowStockThreshold' : field],
          meta: { source: 'product-drawer' },
        })
        if (field === 'basePrice' || field === 'totalStock') {
          emitInvalidation({
            type: 'listing.updated',
            meta: { productIds: [product.id], source: 'product-drawer', field },
          })
        }
        onSaved()
      } catch (e) {
        alert(e instanceof Error ? e.message : String(e))
      } finally {
        setSaving(null)
      }
    },
    [product.id, onSaved],
  )

  return (
    <div className="p-5 space-y-5">
      {/* Quick-edit row */}
      <div className="grid grid-cols-3 gap-3">
        <QuickField
          label="Base price"
          value={basePrice}
          onChange={setBasePrice}
          onCommit={(v) => save('basePrice', v)}
          saving={saving === 'basePrice'}
          numeric
          prefix="€"
        />
        <QuickField
          label="Total stock"
          value={totalStock}
          onChange={setTotalStock}
          onCommit={(v) => save('totalStock', v)}
          saving={saving === 'totalStock'}
          numeric
        />
        <QuickField
          label="Low-stock threshold"
          value={threshold}
          onChange={setThreshold}
          onCommit={(v) => save('threshold', v)}
          saving={saving === 'threshold'}
          numeric
        />
      </div>
      {savedAt && (
        <div className="text-[11px] text-emerald-700">Saved.</div>
      )}

      {/* Master read-only summary */}
      <DetailGrid product={product} />

      {/* Description */}
      {product.description && (
        <div>
          <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
            Description
          </div>
          <p className="text-[12px] text-slate-700 whitespace-pre-line">
            {product.description}
          </p>
        </div>
      )}
    </div>
  )
}

function DetailGrid({ product }: { product: ProductDetail }) {
  const fields: Array<{ label: string; value: React.ReactNode }> = [
    { label: 'Brand', value: product.brand ?? <em className="text-slate-400">—</em> },
    { label: 'Type', value: product.productType ?? <em className="text-slate-400">—</em> },
    { label: 'Fulfillment', value: product.fulfillmentMethod ?? <em className="text-slate-400">—</em> },
    {
      label: 'Weight',
      value:
        product.weightValue != null
          ? `${product.weightValue} ${product.weightUnit ?? ''}`.trim()
          : (<em className="text-slate-400">—</em>),
    },
    {
      label: 'Images',
      value: (
        <span className="inline-flex items-center gap-1">
          <ImageIcon className="w-3 h-3 text-slate-400" />
          {product._count?.images ?? 0}
        </span>
      ),
    },
    {
      label: 'Listings',
      value: (
        <span className="inline-flex items-center gap-1">
          <Boxes className="w-3 h-3 text-slate-400" />
          {product._count?.channelListings ?? 0}
        </span>
      ),
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
      {fields.map((f) => (
        <div key={f.label} className="flex items-baseline justify-between gap-2">
          <span className="text-slate-500">{f.label}</span>
          <span className="text-slate-900 text-right">{f.value}</span>
        </div>
      ))}
    </div>
  )
}

function QuickField({
  label,
  value,
  onChange,
  onCommit,
  saving,
  numeric,
  prefix,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onCommit: (v: string) => void
  saving: boolean
  numeric?: boolean
  prefix?: string
}) {
  const [focused, setFocused] = useState(false)
  return (
    <div>
      <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className="relative">
        {prefix && (
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[12px] text-slate-500 pointer-events-none">
            {prefix}
          </span>
        )}
        <input
          type={numeric ? 'number' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={(e) => {
            setFocused(false)
            onCommit(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur()
            }
          }}
          className={cn(
            'w-full h-8 text-[12px] border rounded-md bg-white focus:outline-none transition-colors',
            prefix ? 'pl-6 pr-2' : 'px-2',
            focused
              ? 'border-blue-300 ring-1 ring-blue-200'
              : 'border-slate-200',
            saving && 'opacity-60',
          )}
          disabled={saving}
        />
      </div>
    </div>
  )
}

function ListingsTab({
  listings,
}: {
  listings: NonNullable<ProductDetail['channelListings']>
}) {
  const grouped = useMemo(() => {
    const map = new Map<string, typeof listings>()
    for (const l of listings) {
      const arr = map.get(l.channel) ?? []
      arr.push(l)
      map.set(l.channel, arr)
    }
    return Array.from(map.entries())
  }, [listings])

  if (listings.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-[12px] text-slate-500">
        <Boxes className="w-6 h-6 mx-auto text-slate-300 mb-2" />
        No listings yet.
        <div className="text-[11px] text-slate-400 mt-1">
          Use the listing wizard to publish this product.
        </div>
      </div>
    )
  }

  return (
    <div className="p-5 space-y-4">
      {grouped.map(([channel, rows]) => (
        <section key={channel}>
          <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
            {channel}
          </div>
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50 border-b border-slate-200 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-1.5 text-left">Market</th>
                  <th className="px-3 py-1.5 text-left">Status</th>
                  <th className="px-3 py-1.5 text-right">Price</th>
                  <th className="px-3 py-1.5 text-right">Qty</th>
                  <th className="px-3 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  // F9 — drift detection. masterPrice/Quantity are
                  // the snapshots Phase 13 maintains. A divergence
                  // when followMaster* is false means the seller has
                  // a per-marketplace override that's drifted from
                  // master.
                  const priceDrift =
                    l.followMasterPrice === false &&
                    l.masterPrice != null &&
                    l.price != null &&
                    Number(l.masterPrice) !== Number(l.price)
                  const qtyDrift =
                    l.followMasterQuantity === false &&
                    l.masterQuantity != null &&
                    l.quantity != null &&
                    Number(l.masterQuantity) !== Number(l.quantity)
                  return (
                  <tr key={l.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                      {l.marketplace}
                    </td>
                    <td className="px-3 py-2">
                      <ListingStatusBadge
                        listingStatus={l.listingStatus}
                        lastSyncStatus={l.lastSyncStatus}
                      />
                      {(priceDrift || qtyDrift) && (
                        <span
                          className="ml-1 inline-flex items-center h-5 px-1.5 rounded text-[10px] font-medium bg-amber-50 text-amber-800 border border-amber-200"
                          title={
                            priceDrift && qtyDrift
                              ? 'Both price and quantity differ from the master snapshot'
                              : priceDrift
                              ? `Listing price €${Number(l.price).toFixed(2)} differs from master €${Number(l.masterPrice).toFixed(2)} (followMasterPrice=false)`
                              : `Listing qty ${l.quantity} differs from master ${l.masterQuantity} (followMasterQuantity=false)`
                          }
                        >
                          DRIFT
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {l.price != null ? `€${Number(l.price).toFixed(2)}` : '—'}
                      {priceDrift && (
                        <div className="text-[10px] text-amber-700 mt-0.5">
                          master €{Number(l.masterPrice).toFixed(2)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {l.quantity ?? '—'}
                      {qtyDrift && (
                        <div className="text-[10px] text-amber-700 mt-0.5">
                          master {l.masterQuantity}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Link
                        href={`/listings/${l.id}`}
                        className="text-[11px] text-blue-700 hover:underline inline-flex items-center gap-0.5"
                      >
                        Open <ChevronRight className="w-3 h-3" />
                      </Link>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  )
}

function ListingStatusBadge({
  listingStatus,
  lastSyncStatus,
}: {
  listingStatus: string
  lastSyncStatus: string | null
}) {
  const failed = lastSyncStatus === 'FAILED'
  const tone = failed
    ? 'bg-rose-50 text-rose-700'
    : listingStatus === 'ACTIVE'
    ? 'bg-emerald-50 text-emerald-700'
    : listingStatus === 'DRAFT'
    ? 'bg-slate-100 text-slate-600'
    : 'bg-amber-50 text-amber-700'
  return (
    <span
      className={cn(
        'inline-flex items-center h-5 px-1.5 rounded text-[10px] font-medium',
        tone,
      )}
    >
      {failed ? 'SYNC FAILED' : listingStatus}
    </span>
  )
}

/**
 * Activity tab (F3) — AuditLog timeline for the product.
 *
 * Reads GET /api/products/:id/activity (ETag-cached). Each row is a
 * slim before/after diff captured by AuditLogService writers
 * (PATCH /api/products/:id, PATCH /api/products/bulk, the master-
 * data services, etc.). Bulk operations also write per-row Product
 * audit rows; metadata.bulkOperationId is shown so users can
 * trace a change back to the bulk job that emitted it.
 */
interface ActivityEntry {
  id: string
  action: string
  userId: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

function ActivityTab({ productId }: { productId: string }) {
  const [items, setItems] = useState<ActivityEntry[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products/${productId}/activity?limit=100`,
          { cache: 'no-store' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (cancelled) return
        setItems(json.items ?? [])
        setTotal(json.total ?? 0)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchOnce()
    return () => {
      cancelled = true
    }
  }, [productId])

  if (loading && items.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-slate-400 text-[12px]">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading activity…
      </div>
    )
  }
  if (error) {
    return (
      <div className="m-5 border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-[12px] text-rose-800 flex items-start gap-2">
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <span>Failed to load activity: {error}</span>
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-[12px] text-slate-500">
        <Activity className="w-6 h-6 mx-auto text-slate-300 mb-2" />
        No activity recorded yet.
        <div className="text-[11px] text-slate-400 mt-1">
          Edits, bulk operations, and master-data changes show up here.
        </div>
      </div>
    )
  }

  return (
    <div className="p-5 space-y-3">
      {total > items.length && (
        <div className="text-[11px] text-slate-500">
          Showing {items.length} of {total} entries (most recent first)
        </div>
      )}
      <ol className="space-y-2">
        {items.map((entry) => (
          <ActivityRow key={entry.id} entry={entry} />
        ))}
      </ol>
    </div>
  )
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const diff = useMemo(() => buildDiff(entry.before, entry.after), [entry.before, entry.after])
  const actor = entry.userId ?? 'system'
  const bulkOpId =
    entry.metadata && typeof entry.metadata === 'object'
      ? (entry.metadata as Record<string, unknown>).bulkOperationId
      : null
  const source =
    entry.metadata && typeof entry.metadata === 'object'
      ? (entry.metadata as Record<string, unknown>).source
      : null
  const reason =
    entry.metadata && typeof entry.metadata === 'object'
      ? (entry.metadata as Record<string, unknown>).reason
      : null

  return (
    <li className="border border-slate-200 rounded-md bg-white px-3 py-2">
      <div className="flex items-baseline justify-between gap-2 text-[11px] text-slate-500">
        <span>
          <span className="font-semibold text-slate-700 capitalize">{entry.action}</span>
          {' · '}
          <span className="font-mono">{actor}</span>
          {(source || reason) ? (
            <span className="text-slate-400 ml-1">
              ({String(source ?? reason)})
            </span>
          ) : null}
        </span>
        <time dateTime={entry.createdAt} className="font-mono">
          {new Date(entry.createdAt).toLocaleString()}
        </time>
      </div>
      {diff.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-[12px]">
          {diff.map((d) => (
            <li key={d.field} className="flex items-baseline gap-2">
              <span className="text-slate-500 font-mono text-[11px] flex-shrink-0">
                {d.field}
              </span>
              <span className="text-rose-700 line-through">{formatValue(d.before)}</span>
              <span className="text-slate-400">→</span>
              <span className="text-emerald-700">{formatValue(d.after)}</span>
            </li>
          ))}
        </ul>
      )}
      {typeof bulkOpId === 'string' && (
        <div className="mt-1.5 text-[10px] text-slate-400">
          via bulk operation <span className="font-mono">{bulkOpId.slice(0, 12)}…</span>
        </div>
      )}
    </li>
  )
}

interface DiffEntry {
  field: string
  before: unknown
  after: unknown
}

function buildDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): DiffEntry[] {
  // Slim diffs from the writers: before/after are usually
  // single-key objects (e.g. { basePrice: 100 } → { basePrice: 105 }).
  // For bulk-edit per-row entries, after is { field, value }; we
  // surface those too.
  const out: DiffEntry[] = []
  const keys = new Set<string>()
  if (before && typeof before === 'object') for (const k of Object.keys(before)) keys.add(k)
  if (after && typeof after === 'object') for (const k of Object.keys(after)) keys.add(k)
  // Special case: bulk-patch writers store after = { field, value }.
  // Surface that as a single diff entry keyed by the field name.
  if (
    after &&
    typeof after === 'object' &&
    'field' in after &&
    'value' in after
  ) {
    const a = after as { field: unknown; value: unknown }
    if (typeof a.field === 'string') {
      return [{ field: a.field, before: undefined, after: a.value }]
    }
  }
  for (const k of keys) {
    out.push({
      field: k,
      before: before?.[k],
      after: after?.[k],
    })
  }
  return out
}

function formatValue(v: unknown): string {
  if (v === undefined) return '—'
  if (v === null) return 'null'
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 60)}…` : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    const json = JSON.stringify(v)
    return json.length > 60 ? `${json.slice(0, 60)}…` : json
  } catch {
    return String(v)
  }
}
