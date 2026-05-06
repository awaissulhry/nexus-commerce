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
  Globe,
  Plus,
  Sparkles,
  Check,
  Trash2,
  Network,
  Search,
  Layers,
} from 'lucide-react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import {
  emitInvalidation,
  useInvalidationChannel,
} from '@/lib/sync/invalidation-channel'

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
  bulletPoints?: string[]
  keywords?: string[]
  fulfillmentMethod: string | null
  updatedAt: string
  createdAt: string
  _count?: {
    images: number
    channelListings: number
    variations: number
    /** P.6 — counts for tab badges (translations + outgoing relations). */
    translations?: number
    relationsFrom?: number
    /** P.8 — count of child Products (parentId), shown on the
     *  Variations tab badge for parent products. */
    children?: number
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

type Tab = 'details' | 'listings' | 'variations' | 'translations' | 'related' | 'activity'

export default function ProductDrawer({
  productId,
  onClose,
  onChanged,
}: ProductDrawerProps) {
  // P.6 — tab persisted in the URL (?drawerTab=<name>) so a refresh
  // keeps the user on the tab they were reading. Falls back to
  // 'details' for any unknown / missing value. Writes are scroll: false
  // so switching tabs doesn't yank the page.
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlTab = searchParams.get('drawerTab') as Tab | null
  const tab: Tab =
    urlTab && ['details', 'listings', 'variations', 'translations', 'related', 'activity'].includes(urlTab)
      ? urlTab
      : 'details'
  const setTab = useCallback(
    (next: Tab) => {
      const sp = new URLSearchParams(searchParams.toString())
      if (next === 'details') sp.delete('drawerTab')
      else sp.set('drawerTab', next)
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false })
    },
    [router, pathname, searchParams],
  )

  const [data, setData] = useState<ProductDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Reset state when productId changes (e.g. user clicks a different
  // row while the drawer is open). We do NOT reset the tab — the user
  // probably wants to keep their context (e.g. always check Listings
  // when scanning multiple products).
  useEffect(() => {
    if (!productId) return
    setData(null)
    setError(null)
  }, [productId])

  const fetchDetail = useCallback(async () => {
    if (!productId) return
    setLoading(true)
    setError(null)
    try {
      // Reuses /api/products/:id/health which now (P.6) returns the
      // full master product + nested ChannelListings + images +
      // counts in one round-trip, ETag-cached. Before P.6 the
      // endpoint only returned the health-badge fields; the drawer
      // silently rendered empty Description / Listings cards.
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

  // P.6 — cross-tab refresh. If another tab edits this product (or a
  // listing belonging to it), refetch so the drawer doesn't show
  // stale master data. Matches when:
  //   - event.id === productId (single-subject events)
  //   - event.meta.productIds includes productId (bulk events)
  //   - event.meta.productId === productId (some emitters use the
  //     singular form on listing.updated)
  useInvalidationChannel(
    ['product.updated', 'listing.updated'],
    (event) => {
      if (!productId) return
      const meta = event.meta as Record<string, unknown> | undefined
      const metaIds = meta?.productIds
      const metaSingleId = meta?.productId
      const matches =
        event.id === productId ||
        metaSingleId === productId ||
        (Array.isArray(metaIds) && metaIds.includes(productId))
      if (matches) void fetchDetail()
    },
  )

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
          {/* P.8 — Variations tab only renders for parent products.
              Children render under their parent's drawer; standalone
              products don't have variants by definition. */}
          {data?.isParent && (
            <DrawerTab
              active={tab === 'variations'}
              onClick={() => setTab('variations')}
              count={data?._count?.children}
            >
              <Layers className="w-3 h-3" /> Variations
            </DrawerTab>
          )}
          <DrawerTab
            active={tab === 'translations'}
            onClick={() => setTab('translations')}
            count={data?._count?.translations}
          >
            <Globe className="w-3 h-3" /> Translations
          </DrawerTab>
          <DrawerTab
            active={tab === 'related'}
            onClick={() => setTab('related')}
            count={data?._count?.relationsFrom}
          >
            <Network className="w-3 h-3" /> Related
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
          {data && tab === 'variations' && data.isParent && (
            <VariationsTab
              parentId={data.id}
              parentSku={data.sku}
              onChanged={() => {
                fetchDetail()
                onChanged?.()
              }}
            />
          )}
          {data && tab === 'translations' && (
            <TranslationsTab
              productId={data.id}
              masterName={data.name}
              masterDescription={data.description ?? null}
              masterBullets={data.bulletPoints ?? []}
              masterKeywords={data.keywords ?? []}
              onChanged={() => {
                fetchDetail()
                onChanged?.()
              }}
            />
          )}
          {data && tab === 'related' && (
            <RelatedTab
              productId={data.id}
              onChanged={() => {
                fetchDetail()
                onChanged?.()
              }}
            />
          )}
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

      {/* H.12 — stock-out projection card. Pulls daysOfCover +
          stockoutDate + velocity from the F.4 forecast tables. */}
      <ForecastCard productId={product.id} />
    </div>
  )
}

function ForecastCard({ productId }: { productId: string }) {
  const [projection, setProjection] = useState<{
    daysOfCover: number | null
    stockoutDate: string | null
    velocity: number | null
    urgency: string
    basis: string
    forecastDays: number
    totalStock: number
  } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`${getBackendUrl()}/api/products/${productId}/forecast`, {
      cache: 'no-store',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled) setProjection(j)
      })
      .catch(() => {
        if (!cancelled) setProjection(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [productId])

  if (loading) {
    return (
      <div className="border border-slate-200 rounded-md p-3 text-[11px] text-slate-400 italic">
        <Loader2 className="w-3 h-3 animate-spin inline mr-1.5" /> Loading
        forecast…
      </div>
    )
  }
  if (!projection) return null

  const tone =
    projection.urgency === 'critical'
      ? { ring: 'border-rose-200 bg-rose-50/40', text: 'text-rose-700' }
      : projection.urgency === 'warn'
        ? { ring: 'border-amber-200 bg-amber-50/40', text: 'text-amber-700' }
        : projection.urgency === 'unknown'
          ? { ring: 'border-slate-200 bg-slate-50/40', text: 'text-slate-600' }
          : { ring: 'border-emerald-200 bg-emerald-50/40', text: 'text-emerald-700' }

  return (
    <div className={`border rounded-md p-3 ${tone.ring}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-700">
          Forecast
        </div>
        <span
          className={`text-[10px] font-semibold uppercase tracking-wider ${tone.text}`}
        >
          {projection.urgency}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <div className="text-slate-400 uppercase tracking-wider text-[9px]">
            Days of cover
          </div>
          <div className="text-[14px] font-semibold tabular-nums text-slate-900">
            {projection.daysOfCover != null
              ? `${projection.daysOfCover}d`
              : '—'}
          </div>
        </div>
        <div>
          <div className="text-slate-400 uppercase tracking-wider text-[9px]">
            Velocity
          </div>
          <div className="text-[14px] font-semibold tabular-nums text-slate-900">
            {projection.velocity != null
              ? `${projection.velocity.toFixed(1)}/d`
              : '—'}
          </div>
        </div>
        <div>
          <div className="text-slate-400 uppercase tracking-wider text-[9px]">
            Stocks out
          </div>
          <div className="text-[12px] font-medium tabular-nums text-slate-900">
            {projection.stockoutDate
              ? new Date(projection.stockoutDate).toLocaleDateString()
              : '—'}
          </div>
        </div>
      </div>
      <div className="text-[10px] text-slate-500 mt-2 pt-2 border-t border-slate-200/50">
        {projection.basis === 'forecast'
          ? `Based on ${projection.forecastDays} days of demand data.`
          : projection.basis === 'threshold'
            ? 'No demand signal yet — using stock threshold.'
            : 'No demand signal yet. Generate sales history to project a stockout date.'}
      </div>
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

// ────────────────────────────────────────────────────────────────────
// VariationsTab (P.8) — child Products of a parent, with quick-edit
// ────────────────────────────────────────────────────────────────────
/**
 * For parent products only. Reads /api/products/:parentId/children,
 * lists each child's sku, name, axis values, basePrice, totalStock,
 * status. Inline-edit price + stock per child via the same
 * PATCH /api/products/:id pattern the grid uses; sends If-Match
 * for optimistic concurrency. On 409 we surface inline + refresh.
 *
 * Click the child's SKU → open it in the drawer (replaces current).
 * Click "Open full edit" → /products/<childId>/edit.
 *
 * No bulk operations here — the dedicated /products/[id]/matrix +
 * the bulk-action bar on the main grid are where multi-row work
 * happens. This tab is the "scan + tweak one or two cells" surface.
 */
interface ChildProduct {
  id: string
  sku: string
  name: string
  basePrice: string | number | null
  totalStock: number | null
  status: string
  version?: number
  variations: Record<string, string> | null
}

function VariationsTab({
  parentId,
  parentSku,
  onChanged,
}: {
  parentId: string
  parentSku: string
  onChanged: () => void
}) {
  const [children, setChildren] = useState<ChildProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{
    childId: string
    field: 'price' | 'stock'
  } | null>(null)
  const [draft, setDraft] = useState('')
  const [savingError, setSavingError] = useState<{
    childId: string
    field: 'price' | 'stock'
    message: string
  } | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${parentId}/children`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setChildren(json.children ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [parentId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Cross-tab refresh — same pattern as the parent drawer. If
  // another tab edits one of the children we re-pull the list so
  // this tab doesn't show stale price/stock.
  useInvalidationChannel(
    ['product.updated', 'product.created', 'product.deleted'],
    () => { void refresh() },
  )

  const startEdit = (child: ChildProduct, field: 'price' | 'stock') => {
    setSavingError(null)
    setDraft(
      String(field === 'price' ? Number(child.basePrice ?? 0) : child.totalStock ?? 0),
    )
    setEditing({ childId: child.id, field })
  }

  const commit = async (child: ChildProduct, field: 'price' | 'stock') => {
    const value = draft.trim()
    setEditing(null)
    if (value === '') return
    const body: Record<string, unknown> =
      field === 'price'
        ? { basePrice: Number(value) }
        : { totalStock: Number(value) }
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (typeof child.version === 'number') headers['If-Match'] = String(child.version)
      const res = await fetch(`${getBackendUrl()}/api/products/${child.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}))
        if (res.status === 409 && errJson?.code === 'VERSION_CONFLICT') {
          setSavingError({
            childId: child.id,
            field,
            message: `Another change landed first (v${errJson.currentVersion ?? '?'}) — refreshing.`,
          })
          void refresh()
          return
        }
        throw new Error(errJson?.error ?? `Update failed (${res.status})`)
      }
      emitInvalidation({
        type: 'product.updated',
        id: child.id,
        fields: [field === 'price' ? 'basePrice' : 'totalStock'],
        meta: { source: 'drawer-variations' },
      })
      // basePrice + totalStock both cascade to ChannelListing.
      emitInvalidation({
        type: 'listing.updated',
        meta: { productIds: [child.id], source: 'drawer-variations', field },
      })
      setSavingError(null)
      void refresh()
      onChanged()
    } catch (e) {
      setSavingError({
        childId: child.id,
        field,
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  if (loading && children.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-slate-400 text-[12px]">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading variations…
      </div>
    )
  }
  if (error) {
    return (
      <div className="m-5 border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-[12px] text-rose-800 flex items-start gap-2">
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <span>Failed to load variations: {error}</span>
      </div>
    )
  }
  if (children.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-[12px] text-slate-500">
        <Layers className="w-6 h-6 mx-auto text-slate-300 mb-2" />
        No variations under {parentSku} yet.
        <div className="text-[11px] text-slate-400 mt-1">
          Add child products from the catalog organize page.
        </div>
      </div>
    )
  }

  // Collect axis names across all children so the table header is
  // stable even if some children are missing an axis value.
  const axisKeys = Array.from(
    children.reduce((set, c) => {
      if (c.variations) for (const k of Object.keys(c.variations)) set.add(k)
      return set
    }, new Set<string>()),
  )

  return (
    <div className="p-5 space-y-3">
      <div className="text-[11px] text-slate-500">
        {children.length} variation{children.length === 1 ? '' : 's'} under{' '}
        <span className="font-mono text-slate-700">{parentSku}</span>. Click
        price or stock to edit inline.
      </div>
      <div className="overflow-x-auto -mx-5 px-5">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
              <th className="text-left py-1.5 px-2 font-semibold">SKU</th>
              {axisKeys.map((k) => (
                <th key={k} className="text-left py-1.5 px-2 font-semibold">
                  {k}
                </th>
              ))}
              <th className="text-right py-1.5 px-2 font-semibold">Price</th>
              <th className="text-right py-1.5 px-2 font-semibold">Stock</th>
              <th className="text-center py-1.5 px-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {children.map((c) => {
              const editingPrice =
                editing?.childId === c.id && editing.field === 'price'
              const editingStock =
                editing?.childId === c.id && editing.field === 'stock'
              const cellErr =
                savingError?.childId === c.id ? savingError : null
              return (
                <tr
                  key={c.id}
                  className="border-b border-slate-100 hover:bg-slate-50/50"
                >
                  <td className="py-1.5 px-2 align-top">
                    <button
                      type="button"
                      onClick={() => {
                        // Replace current drawer with this child via
                        // the same custom-event channel the grid uses.
                        window.dispatchEvent(
                          new CustomEvent('nexus:open-product-drawer', {
                            detail: { productId: c.id },
                          }),
                        )
                      }}
                      className="text-left text-blue-700 hover:underline font-mono text-[11px]"
                    >
                      {c.sku}
                    </button>
                  </td>
                  {axisKeys.map((k) => (
                    <td key={k} className="py-1.5 px-2 text-slate-700 align-top">
                      {c.variations?.[k] ?? <span className="text-slate-300">—</span>}
                    </td>
                  ))}
                  <td className="py-1.5 px-2 text-right tabular-nums align-top">
                    {editingPrice ? (
                      <input
                        autoFocus
                        type="number"
                        step="0.01"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commit(c, 'price')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commit(c, 'price')
                          if (e.key === 'Escape') setEditing(null)
                        }}
                        className="w-20 h-6 px-1.5 text-[12px] text-right tabular-nums border border-blue-300 rounded"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => startEdit(c, 'price')}
                        className="text-slate-900 hover:text-blue-700"
                      >
                        €{Number(c.basePrice ?? 0).toFixed(2)}
                      </button>
                    )}
                    {cellErr?.field === 'price' && (
                      <div className="text-[10px] text-rose-700 mt-0.5">
                        {cellErr.message}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums align-top">
                    {editingStock ? (
                      <input
                        autoFocus
                        type="number"
                        min="0"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commit(c, 'stock')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commit(c, 'stock')
                          if (e.key === 'Escape') setEditing(null)
                        }}
                        className="w-16 h-6 px-1.5 text-[12px] text-right tabular-nums border border-blue-300 rounded"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => startEdit(c, 'stock')}
                        className={cn(
                          'font-semibold',
                          (c.totalStock ?? 0) === 0
                            ? 'text-rose-600'
                            : 'text-slate-900 hover:text-blue-700',
                        )}
                      >
                        {c.totalStock ?? 0}
                      </button>
                    )}
                    {cellErr?.field === 'stock' && (
                      <div className="text-[10px] text-rose-700 mt-0.5">
                        {cellErr.message}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 px-2 text-center align-top">
                    <StatusBadge status={c.status} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="text-[11px] text-slate-500">
        Bulk variant operations live on{' '}
        <Link
          href={`/products/${parentId}/matrix`}
          className="text-blue-700 hover:underline"
        >
          the matrix view
        </Link>
        .
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// TranslationsTab (H.10) — per-language master content editor
// ────────────────────────────────────────────────────────────────────
/**
 * Lists every ProductTranslation row plus the Master (primary
 * language) row up top so the user has a single surface for all
 * language variants. Each row collapses to a one-line summary;
 * expand to edit. AI-sourced rows show an "AI · review" pill until
 * the user marks reviewed.
 */

interface TranslationRow {
  id: string
  language: string
  name: string | null
  description: string | null
  bulletPoints: string[]
  keywords: string[]
  source: string | null
  sourceModel: string | null
  reviewedAt: string | null
  updatedAt: string
}

const KNOWN_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'it', label: 'Italian' },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'en', label: 'English' },
  { code: 'nl', label: 'Dutch' },
  { code: 'sv', label: 'Swedish' },
  { code: 'pl', label: 'Polish' },
]

function languageLabel(code: string): string {
  const m = KNOWN_LANGUAGES.find((l) => l.code === code)
  return m ? `${m.label} (${code.toUpperCase()})` : code.toUpperCase()
}

function TranslationsTab({
  productId,
  masterName,
  masterDescription,
  masterBullets,
  masterKeywords,
  onChanged,
}: {
  productId: string
  masterName: string
  masterDescription: string | null
  masterBullets: string[]
  masterKeywords: string[]
  onChanged: () => void
}) {
  const [primaryLanguage, setPrimaryLanguage] = useState<string>('it')
  const [rows, setRows] = useState<TranslationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [newLang, setNewLang] = useState('de')
  const [newLangCustom, setNewLangCustom] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/translations`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setPrimaryLanguage((json.primaryLanguage ?? 'it').toLowerCase())
      setRows(json.translations ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const create = async () => {
    const code = (newLangCustom.trim() || newLang).toLowerCase()
    if (!code) return
    if (code === primaryLanguage) {
      setError(
        `${code} is the primary language — edit the master fields directly`,
      )
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/translations/${code}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'manual' }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setAdding(false)
      setNewLangCustom('')
      setExpanded((s) => new Set(s).add(code))
      void refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const save = async (
    language: string,
    payload: Partial<TranslationRow>,
  ) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/translations/${language}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      onChanged()
      void refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const markReviewed = async (language: string) => {
    setBusy(true)
    try {
      await fetch(
        `${getBackendUrl()}/api/products/${productId}/translations/${language}/review`,
        { method: 'POST' },
      )
      void refresh()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (language: string) => {
    if (!confirm(`Delete the ${languageLabel(language)} translation?`)) return
    setBusy(true)
    try {
      await fetch(
        `${getBackendUrl()}/api/products/${productId}/translations/${language}`,
        { method: 'DELETE' },
      )
      void refresh()
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="px-5 py-8 text-center text-[12px] text-slate-400 italic">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…
      </div>
    )
  }

  return (
    <div className="px-5 py-4 space-y-3">
      {error && (
        <div className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-[12px] text-rose-800">
          {error}
        </div>
      )}

      {/* Master row — read-only here. Editing happens in Details. */}
      <div className="border border-blue-200 bg-blue-50/40 rounded-md p-3">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="inline-flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-blue-700 bg-blue-100 rounded px-1.5 py-0.5">
              Master
            </span>
            <span className="text-[12px] font-medium text-slate-900">
              {languageLabel(primaryLanguage)}
            </span>
          </div>
          <span className="text-[10px] text-blue-600 italic">
            Edit on the Details tab
          </span>
        </div>
        <div className="text-[12px] text-slate-700 truncate">
          {masterName || <span className="text-slate-400">—</span>}
        </div>
        {masterDescription && (
          <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-2">
            {masterDescription.replace(/<[^>]+>/g, ' ').trim()}
          </div>
        )}
      </div>

      {rows.length === 0 && !adding && (
        <div className="text-center py-6 text-[12px] text-slate-500 space-y-2">
          <Globe className="w-5 h-5 mx-auto text-slate-300" />
          <div>No translations yet.</div>
        </div>
      )}

      {rows.map((r) => {
        const isExpanded = expanded.has(r.language)
        const isAi = r.source?.startsWith('ai-')
        const needsReview = isAi && !r.reviewedAt
        return (
          <TranslationRowCard
            key={r.id}
            row={r}
            expanded={isExpanded}
            needsReview={!!needsReview}
            masterFallback={{
              name: masterName,
              description: masterDescription,
              bulletPoints: masterBullets,
              keywords: masterKeywords,
            }}
            busy={busy}
            onToggle={() => toggle(r.language)}
            onSave={(payload) => save(r.language, payload)}
            onReview={() => markReviewed(r.language)}
            onDelete={() => remove(r.language)}
          />
        )
      })}

      {adding ? (
        <div className="border border-purple-200 bg-purple-50/40 rounded-md p-3 space-y-2">
          <div className="text-[11px] font-semibold text-purple-700 uppercase tracking-wider">
            Add translation
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={newLang}
              onChange={(e) => setNewLang(e.target.value)}
              className="h-8 px-2 text-[12px] border border-slate-200 rounded bg-white"
            >
              {KNOWN_LANGUAGES.filter(
                (l) =>
                  l.code !== primaryLanguage &&
                  !rows.some((r) => r.language === l.code),
              ).map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={newLangCustom}
              onChange={(e) => setNewLangCustom(e.target.value)}
              placeholder="or type code"
              className="h-8 px-2 text-[12px] border border-slate-200 rounded bg-white font-mono uppercase"
            />
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="h-7 px-2 text-[11px] text-slate-600 hover:bg-slate-100 rounded"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={create}
              disabled={busy}
              className="h-7 px-3 text-[11px] bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full h-8 text-[12px] border border-dashed border-slate-300 rounded text-slate-600 hover:bg-slate-50 inline-flex items-center justify-center gap-1.5"
        >
          <Plus className="w-3 h-3" /> Add translation
        </button>
      )}

      <div className="text-[10px] text-slate-500 pt-2 border-t border-slate-100">
        AI-generated translations stay marked &ldquo;unreviewed&rdquo; until
        you confirm them. Generation happens via /products bulk AI fill —
        pick a non-{primaryLanguage.toUpperCase()} marketplace and the
        result lands here.
      </div>
    </div>
  )
}

function TranslationRowCard({
  row,
  expanded,
  needsReview,
  masterFallback,
  busy,
  onToggle,
  onSave,
  onReview,
  onDelete,
}: {
  row: TranslationRow
  expanded: boolean
  needsReview: boolean
  masterFallback: {
    name: string
    description: string | null
    bulletPoints: string[]
    keywords: string[]
  }
  busy: boolean
  onToggle: () => void
  onSave: (payload: Partial<TranslationRow>) => void
  onReview: () => void
  onDelete: () => void
}) {
  const [name, setName] = useState(row.name ?? '')
  const [description, setDescription] = useState(row.description ?? '')
  const [bullets, setBullets] = useState((row.bulletPoints ?? []).join('\n'))
  const [keywords, setKeywords] = useState((row.keywords ?? []).join(', '))
  useEffect(() => {
    setName(row.name ?? '')
    setDescription(row.description ?? '')
    setBullets((row.bulletPoints ?? []).join('\n'))
    setKeywords((row.keywords ?? []).join(', '))
  }, [row.name, row.description, row.bulletPoints, row.keywords])

  const dirty =
    (name || '') !== (row.name ?? '') ||
    (description || '') !== (row.description ?? '') ||
    bullets !== (row.bulletPoints ?? []).join('\n') ||
    keywords !== (row.keywords ?? []).join(', ')

  const summaryName = row.name?.trim() || masterFallback.name
  const summaryDesc =
    row.description?.replace(/<[^>]+>/g, ' ').trim() ||
    masterFallback.description?.replace(/<[^>]+>/g, ' ').trim() ||
    ''

  const save = () => {
    onSave({
      name: name.trim() ? name : null,
      description: description.trim() ? description : null,
      bulletPoints: bullets
        .split('\n')
        .map((b) => b.trim())
        .filter(Boolean),
      keywords: keywords
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
      source: 'manual',
    } as Partial<TranslationRow>)
  }

  return (
    <div
      className={`border rounded-md ${
        needsReview ? 'border-amber-200' : 'border-slate-200'
      } bg-white`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-start gap-2 text-left hover:bg-slate-50"
      >
        <span className="text-[10px] uppercase tracking-wider font-semibold text-slate-700 bg-slate-100 rounded px-1.5 py-0.5 flex-shrink-0 mt-0.5">
          {row.language.toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-slate-900 truncate">
            {summaryName}
          </div>
          {summaryDesc && (
            <div className="text-[11px] text-slate-500 line-clamp-1 mt-0.5">
              {summaryDesc}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {needsReview && (
            <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
              <Sparkles className="w-2.5 h-2.5" /> AI · review
            </span>
          )}
          <ChevronRight
            className={`w-3.5 h-3.5 text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-100 p-3 space-y-2">
          <div>
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 block mb-0.5">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={masterFallback.name}
              className="w-full h-8 px-2 text-[12px] border border-slate-200 rounded bg-white"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 block mb-0.5">
              Description
            </label>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={masterFallback.description ?? ''}
              className="w-full px-2 py-1.5 text-[12px] border border-slate-200 rounded bg-white"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 block mb-0.5">
              Bullets · one per line
            </label>
            <textarea
              rows={5}
              value={bullets}
              onChange={(e) => setBullets(e.target.value)}
              className="w-full px-2 py-1.5 text-[12px] border border-slate-200 rounded bg-white"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 block mb-0.5">
              Keywords · comma-separated
            </label>
            <input
              type="text"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              className="w-full h-8 px-2 text-[12px] border border-slate-200 rounded bg-white"
            />
          </div>

          {row.source && (
            <div className="text-[10px] text-slate-500 pt-1 border-t border-slate-100">
              Source: <span className="font-mono">{row.source}</span>
              {row.sourceModel && <> · {row.sourceModel}</>}
              {row.reviewedAt && (
                <>
                  {' · reviewed '}
                  {new Date(row.reviewedAt).toLocaleDateString()}
                </>
              )}
            </div>
          )}

          <div className="flex items-center gap-1.5 pt-1">
            {needsReview && (
              <button
                type="button"
                onClick={onReview}
                disabled={busy}
                className="h-7 px-2 text-[11px] bg-amber-50 text-amber-800 border border-amber-200 rounded hover:bg-amber-100 inline-flex items-center gap-1"
              >
                <Check className="w-3 h-3" /> Mark reviewed
              </button>
            )}
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="h-7 px-2 text-[11px] text-rose-700 hover:bg-rose-50 rounded inline-flex items-center gap-1"
            >
              <Trash2 className="w-3 h-3" /> Delete
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || !dirty}
              className="ml-auto h-7 px-3 text-[11px] bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// RelatedTab (H.11) — cross-sells, accessories, replacements
// ────────────────────────────────────────────────────────────────────
/**
 * Lists outgoing relations grouped by type (cross-sells, accessories,
 * etc.) plus an "Add related" search picker.
 *
 * Reciprocal toggle is on by default — most cross-sells should be
 * symmetric (if jacket links gloves, gloves should link jacket too).
 * The user can untick it for asymmetric relations like REPLACEMENT
 * (the new product replaces the old one, not the other way around).
 *
 * The search picker hits /api/products?search=... and shows up to 10
 * results, lazily — fires on debounce (250ms).
 */

interface RelatedRow {
  id: string
  type: string
  displayOrder: number
  notes: string | null
  toProduct: {
    id: string
    sku: string
    name: string
    basePrice: number | null
    totalStock: number | null
    status: string
    imageUrl: string | null
  } | null
  fromProduct?: {
    id: string
    sku: string
    name: string
    basePrice: number | null
    totalStock: number | null
    status: string
    imageUrl: string | null
  } | null
}

const RELATION_TYPES: Array<{ code: string; label: string; hint: string }> = [
  { code: 'CROSS_SELL', label: 'Cross-sell', hint: 'You might also like' },
  { code: 'ACCESSORY', label: 'Accessory', hint: 'Works with this' },
  { code: 'UPSELL', label: 'Upsell', hint: 'Step up to this tier' },
  { code: 'REPLACEMENT', label: 'Replacement', hint: 'Supersedes' },
  { code: 'BUNDLE_PART', label: 'Bundle part', hint: 'Member of bundle' },
  { code: 'RECOMMENDED', label: 'Recommended', hint: 'Generic suggestion' },
]

function relationLabel(code: string): string {
  return RELATION_TYPES.find((t) => t.code === code)?.label ?? code
}

interface SearchResult {
  id: string
  sku: string
  name: string
  imageUrl?: string | null
}

function RelatedTab({
  productId,
  onChanged,
}: {
  productId: string
  onChanged: () => void
}) {
  const [outgoing, setOutgoing] = useState<RelatedRow[]>([])
  const [incoming, setIncoming] = useState<RelatedRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)

  // Picker state
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedTo, setSelectedTo] = useState<SearchResult | null>(null)
  const [pickedType, setPickedType] = useState<string>('CROSS_SELL')
  const [reciprocal, setReciprocal] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/relations`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setOutgoing(json.outgoing ?? [])
      setIncoming(json.incoming ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Debounced search → /api/products?search=
  useEffect(() => {
    if (!adding) return
    const term = search.trim()
    if (term.length < 2) {
      setResults([])
      return
    }
    let cancelled = false
    const handle = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products?search=${encodeURIComponent(term)}&limit=10`,
          { cache: 'no-store' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (cancelled) return
        const rows = (json.products ?? []) as Array<{
          id: string
          sku: string
          name: string
          imageUrl?: string | null
        }>
        setResults(
          rows
            .filter((r) => r.id !== productId)
            .map((r) => ({
              id: r.id,
              sku: r.sku,
              name: r.name,
              imageUrl: r.imageUrl ?? null,
            })),
        )
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [adding, search, productId])

  const create = async () => {
    if (!selectedTo) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/relations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toProductId: selectedTo.id,
            type: pickedType,
            reciprocal,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setAdding(false)
      setSelectedTo(null)
      setSearch('')
      setResults([])
      onChanged()
      void refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (relationId: string) => {
    if (!confirm('Remove this related-product link?')) return
    setBusy(true)
    try {
      await fetch(
        `${getBackendUrl()}/api/products/relations/${relationId}?reciprocal=true`,
        { method: 'DELETE' },
      )
      onChanged()
      void refresh()
    } finally {
      setBusy(false)
    }
  }

  // Group outgoing by type for the rendered sections.
  const outgoingByType = useMemo(() => {
    const m = new Map<string, RelatedRow[]>()
    for (const t of RELATION_TYPES) m.set(t.code, [])
    for (const r of outgoing) {
      const arr = m.get(r.type) ?? []
      arr.push(r)
      m.set(r.type, arr)
    }
    return m
  }, [outgoing])

  if (loading) {
    return (
      <div className="px-5 py-8 text-center text-[12px] text-slate-400 italic">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…
      </div>
    )
  }

  return (
    <div className="px-5 py-4 space-y-4">
      {error && (
        <div className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-[12px] text-rose-800">
          {error}
        </div>
      )}

      {RELATION_TYPES.map((t) => {
        const rows = outgoingByType.get(t.code) ?? []
        if (rows.length === 0) return null
        return (
          <section key={t.code} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[12px] font-semibold text-slate-700">
                  {t.label}
                </div>
                <div className="text-[10px] text-slate-500">{t.hint}</div>
              </div>
              <span className="text-[10px] text-slate-400">
                {rows.length} item{rows.length === 1 ? '' : 's'}
              </span>
            </div>
            {rows.map((r) => {
              const p = r.toProduct
              if (!p) return null
              return (
                <div
                  key={r.id}
                  className="flex items-center gap-2 px-2 py-1.5 border border-slate-200 rounded bg-white"
                >
                  {p.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.imageUrl}
                      alt=""
                      className="w-8 h-8 rounded object-cover bg-slate-100 flex-shrink-0"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded bg-slate-100 flex items-center justify-center text-slate-300 flex-shrink-0">
                      <Package className="w-4 h-4" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] text-slate-900 font-medium truncate">
                      {p.name}
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono truncate">
                      {p.sku}
                      {p.basePrice != null && (
                        <span className="ml-1.5 tabular-nums">
                          · €{p.basePrice.toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent('nexus:open-product-drawer', {
                          detail: { productId: p.id },
                        }),
                      )
                    }
                    title="Open"
                    className="h-7 w-7 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 rounded"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(r.id)}
                    disabled={busy}
                    title="Remove"
                    className="h-7 w-7 inline-flex items-center justify-center text-slate-400 hover:text-rose-600 rounded"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )
            })}
          </section>
        )
      })}

      {outgoing.length === 0 && !adding && (
        <div className="text-center py-6 text-[12px] text-slate-500 space-y-2">
          <Network className="w-5 h-5 mx-auto text-slate-300" />
          <div>No related products yet.</div>
        </div>
      )}

      {adding ? (
        <div className="border border-purple-200 bg-purple-50/40 rounded-md p-3 space-y-2">
          <div className="text-[11px] font-semibold text-purple-700 uppercase tracking-wider">
            Add related
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 block mb-0.5">
              Type
            </label>
            <select
              value={pickedType}
              onChange={(e) => setPickedType(e.target.value)}
              className="w-full h-8 px-2 text-[12px] border border-slate-200 rounded bg-white"
            >
              {RELATION_TYPES.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label} — {t.hint}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-500 block mb-0.5">
              Search product
            </label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="SKU, name, brand…"
                className="w-full h-8 pl-7 pr-2 text-[12px] border border-slate-200 rounded bg-white"
              />
            </div>
            {searching && (
              <div className="text-[10px] text-slate-400 mt-1 italic">
                Searching…
              </div>
            )}
            {results.length > 0 && !selectedTo && (
              <div className="mt-1 border border-slate-200 rounded bg-white max-h-48 overflow-y-auto">
                {results.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      setSelectedTo(r)
                      setResults([])
                    }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 text-left"
                  >
                    {r.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={r.imageUrl}
                        alt=""
                        className="w-6 h-6 rounded object-cover bg-slate-100 flex-shrink-0"
                      />
                    ) : (
                      <div className="w-6 h-6 rounded bg-slate-100 flex-shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] text-slate-900 truncate">
                        {r.name}
                      </div>
                      <div className="text-[10px] text-slate-500 font-mono truncate">
                        {r.sku}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {selectedTo && (
              <div className="mt-1 flex items-center gap-2 px-2 py-1.5 border border-purple-300 rounded bg-white">
                {selectedTo.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={selectedTo.imageUrl}
                    alt=""
                    className="w-6 h-6 rounded object-cover bg-slate-100 flex-shrink-0"
                  />
                ) : (
                  <div className="w-6 h-6 rounded bg-slate-100 flex-shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-slate-900 truncate font-medium">
                    {selectedTo.name}
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono truncate">
                    {selectedTo.sku}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedTo(null)}
                  className="h-6 w-6 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 rounded"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
          <label className="flex items-start gap-2 text-[11px] text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={reciprocal}
              onChange={() => setReciprocal((v) => !v)}
              className="mt-0.5"
            />
            <div>
              <div>Create the reverse link too</div>
              <div className="text-[10px] text-slate-500">
                Most cross-sells should be symmetric. Untick for asymmetric
                relations like Replacement.
              </div>
            </div>
          </label>
          <div className="flex items-center justify-end gap-1.5 pt-1">
            <button
              type="button"
              onClick={() => {
                setAdding(false)
                setSelectedTo(null)
                setSearch('')
                setResults([])
              }}
              className="h-7 px-2 text-[11px] text-slate-600 hover:bg-slate-100 rounded"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={create}
              disabled={busy || !selectedTo}
              className="h-7 px-3 text-[11px] bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full h-8 text-[12px] border border-dashed border-slate-300 rounded text-slate-600 hover:bg-slate-50 inline-flex items-center justify-center gap-1.5"
        >
          <Plus className="w-3 h-3" /> Add related product
        </button>
      )}

      {/* Incoming awareness — read-only list of products that link
          to this one. Useful when editing/removing this product. */}
      {incoming.length > 0 && (
        <section className="pt-3 border-t border-slate-100 space-y-1.5">
          <div className="text-[11px] font-semibold text-slate-700">
            Linked from {incoming.length} product
            {incoming.length === 1 ? '' : 's'}
          </div>
          <div className="text-[10px] text-slate-500">
            These products have an outgoing link to this one. Editing
            them happens in their own drawer.
          </div>
          {incoming.map((r) => {
            const p = r.fromProduct
            if (!p) return null
            return (
              <div
                key={r.id}
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('nexus:open-product-drawer', {
                      detail: { productId: p.id },
                    }),
                  )
                }
                className="flex items-center gap-2 px-2 py-1.5 border border-slate-100 rounded bg-slate-50/40 cursor-pointer hover:bg-slate-50"
              >
                {p.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.imageUrl}
                    alt=""
                    className="w-6 h-6 rounded object-cover bg-slate-100 flex-shrink-0"
                  />
                ) : (
                  <div className="w-6 h-6 rounded bg-slate-100 flex-shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] text-slate-700 truncate">
                    {p.name}
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono truncate">
                    {p.sku} ·{' '}
                    <span className="uppercase">{relationLabel(r.type)}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}
