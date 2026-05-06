'use client'

// PRODUCTS REBUILD — universal catalog workspace.
// Five lenses: Grid · Hierarchy · Coverage · Health · Drafts.
// URL-driven state, virtualized table, inline quick-edit, faceted filters,
// saved views, tag + bundle editors, bulk actions across channels.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  Boxes, AlertTriangle, LayoutGrid, Sparkles, Search, RefreshCw,
  Filter, Settings2, X, ChevronDown, ChevronRight, Eye, EyeOff, Tag as TagIcon,
  Package, Plus, FolderTree, Network, Bookmark, BookmarkPlus,
  ExternalLink, Star, Copy, Trash2, Layers, Image as ImageIcon,
  CheckCircle2, XCircle,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { COUNTRY_NAMES } from '@/lib/country-names'
import { getBackendUrl } from '@/lib/backend-url'
import { usePolledList } from '@/lib/sync/use-polled-list'
import {
  emitInvalidation,
  useInvalidationChannel,
} from '@/lib/sync/invalidation-channel'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import ProductDrawer from './_shared/ProductDrawer'

// ── Types ───────────────────────────────────────────────────────────
type Lens = 'grid' | 'hierarchy' | 'coverage' | 'health' | 'drafts'

type ProductRow = {
  id: string
  sku: string
  name: string
  brand: string | null
  basePrice: number
  totalStock: number
  lowStockThreshold: number
  status: string
  syncChannels: string[]
  imageUrl: string | null
  isParent: boolean
  parentId: string | null
  productType: string | null
  fulfillmentMethod: string | null
  photoCount: number
  channelCount: number
  variantCount: number
  // Number of child Products (Product.children self-relation). Used by
  // the grid to decide whether a parent gets a chevron. Differs from
  // variantCount, which counts ProductVariation rows (matrix cells).
  childCount?: number
  coverage: Record<string, { live: number; draft: number; error: number; total: number }> | null
  tags?: Array<{ id: string; name: string; color: string | null }>
  updatedAt: string
  createdAt: string
}

type Stats = { total: number; active: number; draft: number; inStock: number; outOfStock: number }
type Tag = { id: string; name: string; color: string | null; productCount?: number }
type Facets = {
  productTypes: Array<{ value: string; count: number }>
  brands: Array<{ value: string; count: number }>
  fulfillment: Array<{ value: string; count: number }>
  statuses: Array<{ value: string; count: number }>
  // E.5b — per-(channel, marketplace) facet, populated from
  // ChannelListing groupBy + Marketplace lookup.
  marketplaces?: Array<{
    value: string
    channel: string
    label: string
    region: string | null
    count: number
  }>
}
type SavedView = {
  id: string
  name: string
  filters: any
  isDefault: boolean
  surface: string
}

const ALL_COLUMNS: Array<{ key: string; label: string; width: number; locked?: boolean }> = [
  { key: 'thumb', label: '', width: 56, locked: true },
  { key: 'sku', label: 'SKU', width: 140, locked: true },
  { key: 'name', label: 'Name', width: 280, locked: true },
  { key: 'status', label: 'Status', width: 110 },
  { key: 'price', label: 'Price', width: 110 },
  { key: 'stock', label: 'Stock', width: 90 },
  { key: 'threshold', label: 'Low @', width: 80 },
  { key: 'brand', label: 'Brand', width: 120 },
  { key: 'productType', label: 'Type', width: 130 },
  { key: 'fulfillment', label: 'FBA/FBM', width: 80 },
  { key: 'coverage', label: 'Channels', width: 180 },
  { key: 'tags', label: 'Tags', width: 160 },
  { key: 'photos', label: 'Photos', width: 70 },
  { key: 'variants', label: 'Var.', width: 70 },
  { key: 'updated', label: 'Updated', width: 110 },
  { key: 'actions', label: '', width: 110, locked: true },
]

const DEFAULT_VISIBLE = ['thumb', 'sku', 'name', 'status', 'price', 'stock', 'coverage', 'tags', 'photos', 'updated', 'actions']

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'default' | 'info'> = {
  ACTIVE: 'success',
  DRAFT: 'default',
  INACTIVE: 'default',
}

const CHANNEL_TONE: Record<string, string> = {
  AMAZON: 'bg-orange-50 text-orange-700 border-orange-200',
  EBAY: 'bg-blue-50 text-blue-700 border-blue-200',
  SHOPIFY: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  WOOCOMMERCE: 'bg-violet-50 text-violet-700 border-violet-200',
  ETSY: 'bg-rose-50 text-rose-700 border-rose-200',
}

// Italian terminology lookup — falls back to English when not in the glossary.
// Loaded once and merged with productType facets so chips show "Giacca" etc.
// Mirrored from packages/database seed data for the brand glossary.
const IT_TERMS: Record<string, string> = {
  OUTERWEAR: 'Giacca',
  PANTS: 'Pantaloni',
  HELMET: 'Casco',
  BOOTS: 'Stivali',
  PROTECTIVE: 'Protezioni',
  GLOVES: 'Guanti',
  BAG: 'Borsa',
}

// E.5b — Country/marketplace code → display name. Used by the Marketplace
// filter group; codes match Marketplace.code values (IT/DE/.../GLOBAL).
const MARKETPLACE_DISPLAY_NAMES: Record<string, string> = {
  IT: 'Italy',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  NL: 'Netherlands',
  SE: 'Sweden',
  PL: 'Poland',
  UK: 'United Kingdom',
  GB: 'United Kingdom',
  US: 'United States',
  CA: 'Canada',
  MX: 'Mexico',
  AU: 'Australia',
  JP: 'Japan',
  GLOBAL: 'Global',
}

export default function ProductsWorkspace() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const lens = (searchParams.get('lens') as Lens) || 'grid'
  const page = parseInt(searchParams.get('page') ?? '1', 10) || 1
  const search = searchParams.get('search') ?? ''
  const sortBy = searchParams.get('sortBy') ?? 'updated'
  const pageSize = Math.min(500, parseInt(searchParams.get('pageSize') ?? '100', 10) || 100)

  const statusFilters = searchParams.get('status')?.split(',').filter(Boolean) ?? []
  const channelFilters = searchParams.get('channels')?.split(',').filter(Boolean) ?? []
  const marketplaceFilters = searchParams.get('marketplaces')?.split(',').filter(Boolean) ?? []
  const productTypeFilters = searchParams.get('productTypes')?.split(',').filter(Boolean) ?? []
  const brandFilters = searchParams.get('brands')?.split(',').filter(Boolean) ?? []
  const tagFilters = searchParams.get('tags')?.split(',').filter(Boolean) ?? []
  const fulfillmentFilters = searchParams.get('fulfillment')?.split(',').filter(Boolean) ?? []
  const stockLevel = searchParams.get('stockLevel') ?? 'all'

  // F1 — drawer state lives in the URL so back/forward + bookmarks +
  // shared links all work. Open: ?drawer=<productId>. Close: drop the
  // param. The drawer component handles Esc + click-overlay close
  // internally.
  const drawerProductId = searchParams.get('drawer')
  const hasPhotos = searchParams.get('hasPhotos')

  const [searchInput, setSearchInput] = useState(search)
  const [products, setProducts] = useState<ProductRow[]>([])
  const [stats, setStats] = useState<Stats>({ total: 0, active: 0, draft: 0, inStock: 0, outOfStock: 0 })
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [columnPickerOpen, setColumnPickerOpen] = useState(false)
  const [savedViewMenuOpen, setSavedViewMenuOpen] = useState(false)
  const [tagEditorProductId, setTagEditorProductId] = useState<string | null>(null)
  const [bundleEditorOpen, setBundleEditorOpen] = useState(false)

  // Grid expand-on-chevron: parents lazy-load their children via the
  // same /api/products endpoint with ?parentId=<id>. Cached so opening
  // the same parent twice doesn't re-fetch. The 30s page-level poll
  // does not refresh open child sets — toggling closed-then-open does.
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [childrenByParent, setChildrenByParent] = useState<Record<string, ProductRow[]>>({})
  const [loadingChildren, setLoadingChildren] = useState<Set<string>>(new Set())

  const [tags, setTags] = useState<Tag[]>([])
  const [facets, setFacets] = useState<Facets | null>(null)
  const [savedViews, setSavedViews] = useState<SavedView[]>([])

  const [visibleColumns, setVisibleColumns] = useState<string[]>(() => {
    if (typeof window === 'undefined') return DEFAULT_VISIBLE
    try {
      const saved = window.localStorage.getItem('products.visibleColumns')
      return saved ? JSON.parse(saved) : DEFAULT_VISIBLE
    } catch { return DEFAULT_VISIBLE }
  })
  useEffect(() => {
    try { window.localStorage.setItem('products.visibleColumns', JSON.stringify(visibleColumns)) } catch {}
  }, [visibleColumns])

  // Debounced search → URL
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== search) updateUrl({ search: searchInput || undefined, page: undefined })
    }, 250)
    return () => clearTimeout(t)
  }, [searchInput])

  const updateUrl = useCallback((patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }, [searchParams, pathname, router])

  // F1 — listen for nexus:open-product-drawer dispatched by row "View"
  // buttons (and any future affordance — e.g. cmd+click on a row).
  // Updates the URL to ?drawer=<id> which the ProductDrawer reads.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ productId: string }>).detail
      if (detail?.productId) updateUrl({ drawer: detail.productId })
    }
    window.addEventListener('nexus:open-product-drawer', onOpen)
    return () => window.removeEventListener('nexus:open-product-drawer', onOpen)
  }, [updateUrl])

  // Phase 10 — usePolledList replaces the fetchProducts useCallback +
  // manual setInterval(30s) + visibilitychange listener that lived
  // here previously. Same 30s polling cadence; same visibility-on-
  // focus refetch; the URL still reflects every filter so back/forward
  // and bookmarks work as before. The `channels` / `marketplaces`
  // CSV params stay on the URL for backwards compat — the backend's
  // csvParam() accepts both forms — but the canonical Phase 10 contract
  // now uses repeated keys, which 10a's parseFilters auto-translates
  // for any external link that arrives in the legacy form.
  const productsUrl = useMemo(() => {
    if (lens !== 'grid') return null
    const qs = new URLSearchParams()
    qs.set('page', String(page))
    qs.set('limit', String(pageSize))
    if (search) qs.set('search', search)
    if (statusFilters.length) qs.set('status', statusFilters.join(','))
    if (channelFilters.length) qs.set('channels', channelFilters.join(','))
    if (marketplaceFilters.length) qs.set('marketplaces', marketplaceFilters.join(','))
    if (productTypeFilters.length) qs.set('productTypes', productTypeFilters.join(','))
    if (brandFilters.length) qs.set('brands', brandFilters.join(','))
    if (tagFilters.length) qs.set('tags', tagFilters.join(','))
    if (fulfillmentFilters.length) qs.set('fulfillment', fulfillmentFilters.join(','))
    if (stockLevel !== 'all') qs.set('stockLevel', stockLevel)
    if (hasPhotos) qs.set('hasPhotos', hasPhotos)
    qs.set('sort', sortBy)
    qs.set('includeCoverage', 'true')
    qs.set('includeTags', 'true')
    return `/api/products?${qs.toString()}`
  }, [lens, page, pageSize, search, statusFilters, channelFilters, marketplaceFilters, productTypeFilters, brandFilters, tagFilters, fulfillmentFilters, stockLevel, hasPhotos, sortBy])

  const {
    data: productsData,
    loading: productsLoading,
    error: productsError,
    lastFetchedAt: productsFetchedAt,
    refetch: refetchProducts,
  } = usePolledList<{
    products: ProductRow[]
    stats: { total: number; active: number; draft: number; inStock: number; outOfStock: number }
    total: number
    totalPages: number
  }>({
    url: productsUrl,
    intervalMs: 30_000,
    invalidationTypes: [
      'product.updated',
      'product.created',
      'product.deleted',
      'listing.updated',
      'wizard.submitted',
      'pim.changed',
      'bulk-job.completed',
    ],
  })

  // Sync hook output into the page's existing state slots so the rest
  // of the file (renderers, drawer, bulk-action bar) keeps reading from
  // products / stats / total / totalPages without changes.
  useEffect(() => {
    if (productsData) {
      setProducts(productsData.products ?? [])
      setStats(productsData.stats ?? { total: 0, active: 0, draft: 0, inStock: 0, outOfStock: 0 })
      setTotal(productsData.total ?? 0)
      setTotalPages(productsData.totalPages ?? 0)
    }
  }, [productsData])
  useEffect(() => { setLoading(productsLoading) }, [productsLoading])
  useEffect(() => { setError(productsError) }, [productsError])

  // Backwards-compat: existing call sites (refresh button, drawer
  // onChanged, bulk-action onComplete) keep calling fetchProducts.
  const fetchProducts = refetchProducts

  const fetchTags = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/tags`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setTags(data.items ?? [])
      }
    } catch {}
  }, [])

  const fetchFacets = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/facets`, { cache: 'no-store' })
      if (res.ok) setFacets(await res.json())
    } catch {}
  }, [])

  const fetchSavedViews = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/saved-views?surface=products`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setSavedViews(data.items ?? [])
      }
    } catch {}
  }, [])

  // Lazy-load a parent's children. Cached after first fetch. Returns
  // void so the caller can fire-and-forget; loading/error state is
  // surfaced via loadingChildren and a fallback message in the row.
  const fetchChildrenFor = useCallback(async (parentId: string) => {
    if (childrenByParent[parentId]) return // cache hit
    setLoadingChildren((prev) => {
      const next = new Set(prev)
      next.add(parentId)
      return next
    })
    try {
      const qs = new URLSearchParams({
        parentId,
        limit: '200',
        includeCoverage: 'true',
        includeTags: 'true',
      })
      const res = await fetch(`${getBackendUrl()}/api/products?${qs.toString()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const data = await res.json()
      setChildrenByParent((prev) => ({ ...prev, [parentId]: data.products ?? [] }))
    } catch {
      // On failure, drop a marker [] so the row shows "no variants found"
      // instead of an infinite spinner. Re-collapse + re-expand retries.
      setChildrenByParent((prev) => ({ ...prev, [parentId]: [] }))
    } finally {
      setLoadingChildren((prev) => {
        const next = new Set(prev)
        next.delete(parentId)
        return next
      })
    }
  }, [childrenByParent])

  const toggleExpand = useCallback((parentId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev)
      if (next.has(parentId)) {
        next.delete(parentId)
      } else {
        next.add(parentId)
        void fetchChildrenFor(parentId)
      }
      return next
    })
  }, [fetchChildrenFor])

  // After a refresh of the top-level rows, evict child caches so the
  // next expand re-fetches against possibly-changed children. Cheap:
  // children render only when the user re-opens.
  const onTopLevelRefresh = useCallback(() => {
    setChildrenByParent({})
  }, [])

  // Phase 10 — usePolledList above owns the 30s poll + visibility
  // refresh + invalidation-driven refetch for the Grid lens. The
  // hook only fires when productsUrl !== null, which depends on
  // lens === 'grid'.

  useEffect(() => { fetchTags(); fetchFacets(); fetchSavedViews() }, [fetchTags, fetchFacets, fetchSavedViews])

  // Phase 10 — when other pages mutate data, refresh the sidecar
  // queries (tags, facets) in tandem with the grid. usePolledList
  // already handles the grid via invalidationTypes.
  useInvalidationChannel(
    [
      'product.updated',
      'product.created',
      'product.deleted',
      'listing.updated',
      'wizard.submitted',
      'pim.changed',
      'bulk-job.completed',
    ],
    () => {
      fetchTags()
      fetchFacets()
      onTopLevelRefresh()
    },
  )

  // Reset selection when filters change
  useEffect(() => { setSelected(new Set()) }, [page, search, statusFilters.join(','), channelFilters.join(','), marketplaceFilters.join(','), productTypeFilters.join(','), brandFilters.join(','), tagFilters.join(','), fulfillmentFilters.join(','), stockLevel, hasPhotos])

  // Auto-load default saved view on first mount if URL has no filter state
  const appliedDefaultRef = useRef(false)
  useEffect(() => {
    if (appliedDefaultRef.current) return
    if (savedViews.length === 0) return
    if (searchParams.toString().length > 0) { appliedDefaultRef.current = true; return }
    const def = savedViews.find((v) => v.isDefault)
    if (def) {
      appliedDefaultRef.current = true
      const next = new URLSearchParams()
      for (const [k, v] of Object.entries(def.filters ?? {})) {
        if (v == null || v === '') continue
        next.set(k, Array.isArray(v) ? v.join(',') : String(v))
      }
      router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    } else {
      appliedDefaultRef.current = true
    }
  }, [savedViews, searchParams, pathname, router])

  const filterCount =
    statusFilters.length + channelFilters.length + marketplaceFilters.length +
    productTypeFilters.length + brandFilters.length + tagFilters.length +
    fulfillmentFilters.length + (stockLevel !== 'all' ? 1 : 0) + (hasPhotos ? 1 : 0)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Products"
        description={`${stats.total.toLocaleString()} master SKUs · ${stats.active} active · ${stats.draft} draft · ${stats.inStock} in stock · ${stats.outOfStock} out`}
        actions={
          <div className="flex items-center gap-2">
            <Link href="/products/new" className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800 inline-flex items-center gap-1.5">
              <Plus size={12} /> New product
            </Link>
            {lens === 'grid' ? (
              <FreshnessIndicator
                lastFetchedAt={productsFetchedAt}
                onRefresh={() => fetchProducts()}
                loading={productsLoading}
                error={!!productsError}
              />
            ) : (
              <button onClick={() => fetchProducts()} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5">
                <RefreshCw size={12} /> Refresh
              </button>
            )}
          </div>
        }
      />

      {/* Lens switcher + saved views menu */}
      <div className="flex items-center gap-2 flex-wrap">
        <LensTabs current={lens} onChange={(next) => updateUrl({ lens: next === 'grid' ? undefined : next, page: undefined })} />

        <div className="ml-auto flex items-center gap-2">
          <SavedViewsButton
            open={savedViewMenuOpen}
            setOpen={setSavedViewMenuOpen}
            views={savedViews}
            onApply={(view: SavedView) => {
              const next = new URLSearchParams()
              for (const [k, v] of Object.entries(view.filters ?? {})) {
                if (v == null || v === '') continue
                next.set(k, Array.isArray(v) ? v.join(',') : String(v))
              }
              router.replace(`${pathname}?${next.toString()}`, { scroll: false })
              setSavedViewMenuOpen(false)
            }}
            onSaveCurrent={async (name: string, isDefault: boolean) => {
              const filters: Record<string, any> = {}
              if (search) filters.search = search
              if (statusFilters.length) filters.status = statusFilters
              if (channelFilters.length) filters.channels = channelFilters
              if (marketplaceFilters.length) filters.marketplaces = marketplaceFilters
              if (productTypeFilters.length) filters.productTypes = productTypeFilters
              if (brandFilters.length) filters.brands = brandFilters
              if (tagFilters.length) filters.tags = tagFilters
              if (fulfillmentFilters.length) filters.fulfillment = fulfillmentFilters
              if (stockLevel !== 'all') filters.stockLevel = stockLevel
              if (sortBy !== 'updated') filters.sort = sortBy
              if (lens !== 'grid') filters.lens = lens
              const res = await fetch(`${getBackendUrl()}/api/saved-views`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, surface: 'products', filters, isDefault }),
              })
              if (res.ok) { fetchSavedViews(); return true }
              const err = await res.json().catch(() => ({}))
              alert(err.error ?? 'Save failed')
              return false
            }}
            onDelete={async (id: string) => {
              await fetch(`${getBackendUrl()}/api/saved-views/${id}`, { method: 'DELETE' })
              fetchSavedViews()
            }}
            onSetDefault={async (id: string) => {
              await fetch(`${getBackendUrl()}/api/saved-views/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isDefault: true }),
              })
              fetchSavedViews()
            }}
          />
          <button onClick={() => setBundleEditorOpen(true)} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5">
            <Package size={12} /> Bundles
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <FilterBar
        searchInput={searchInput}
        setSearchInput={setSearchInput}
        statusFilters={statusFilters}
        channelFilters={channelFilters}
        marketplaceFilters={marketplaceFilters}
        productTypeFilters={productTypeFilters}
        brandFilters={brandFilters}
        tagFilters={tagFilters}
        fulfillmentFilters={fulfillmentFilters}
        stockLevel={stockLevel}
        hasPhotos={hasPhotos}
        filterCount={filterCount}
        filtersOpen={filtersOpen}
        setFiltersOpen={setFiltersOpen}
        facets={facets}
        tags={tags}
        updateUrl={updateUrl}
      />

      {/* Bulk action bar */}
      {lens === 'grid' && selected.size > 0 && (
        <BulkActionBar
          selectedIds={Array.from(selected)}
          allTags={tags}
          onClear={() => setSelected(new Set())}
          onComplete={() => { setSelected(new Set()); fetchProducts(); fetchTags() }}
        />
      )}

      {/* Lens body */}
      {lens === 'grid' && (
        <GridLens
          products={products}
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
          onSort={(key: string) => updateUrl({ sortBy: key, page: undefined })}
          selected={selected}
          setSelected={setSelected}
          onPage={(p: number) => updateUrl({ page: p === 1 ? undefined : String(p) })}
          onPageSize={(s: number) => updateUrl({ pageSize: s === 100 ? undefined : String(s), page: undefined })}
          onTagEdit={(id: string) => setTagEditorProductId(id)}
          onChanged={() => { onTopLevelRefresh(); fetchProducts() }}
          expandedParents={expandedParents}
          childrenByParent={childrenByParent}
          loadingChildren={loadingChildren}
          onToggleExpand={toggleExpand}
        />
      )}

      {lens === 'hierarchy' && <HierarchyLens search={search} />}
      {lens === 'coverage' && <CoverageLens products={products} loading={loading} />}
      {lens === 'health' && <HealthLens />}
      {lens === 'drafts' && <DraftsLens />}

      {tagEditorProductId && (
        <TagEditor
          productId={tagEditorProductId}
          onClose={() => setTagEditorProductId(null)}
          onChanged={() => { fetchProducts(); fetchTags() }}
          allTags={tags}
        />
      )}

      {bundleEditorOpen && (
        <BundleEditor
          onClose={() => setBundleEditorOpen(false)}
          onChanged={fetchProducts}
        />
      )}

      {/* F1 — product drawer. Mounted at workspace level so it sits
          above all lenses. URL-driven open state (?drawer=<id>). */}
      <ProductDrawer
        productId={drawerProductId}
        onClose={() => updateUrl({ drawer: undefined })}
        onChanged={fetchProducts}
      />
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// LensTabs
// ────────────────────────────────────────────────────────────────────
function LensTabs({ current, onChange }: { current: Lens; onChange: (l: Lens) => void }) {
  const tabs: Array<{ key: Lens; label: string; icon: any }> = [
    { key: 'grid', label: 'Grid', icon: LayoutGrid },
    { key: 'hierarchy', label: 'Hierarchy', icon: FolderTree },
    { key: 'coverage', label: 'Coverage', icon: Network },
    { key: 'health', label: 'Health', icon: AlertTriangle },
    { key: 'drafts', label: 'Drafts', icon: Sparkles },
  ]
  return (
    <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`h-7 px-3 text-[12px] font-medium inline-flex items-center gap-1.5 rounded transition-colors ${current === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
        >
          <t.icon size={12} />
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// FilterBar
// ────────────────────────────────────────────────────────────────────
function FilterBar(props: any) {
  const {
    searchInput, setSearchInput,
    statusFilters, channelFilters, marketplaceFilters, productTypeFilters, brandFilters, tagFilters, fulfillmentFilters,
    stockLevel, hasPhotos, filterCount, filtersOpen, setFiltersOpen, facets, tags, updateUrl,
  } = props

  // F2 — listen for the global "/" focus-search event dispatched by
  // CommandPalette and focus the search input here. Same pattern any
  // page can adopt: attach a ref + listen for nexus:focus-search.
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    const onFocusSearch = () => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
    window.addEventListener('nexus:focus-search', onFocusSearch)
    return () => window.removeEventListener('nexus:focus-search', onFocusSearch)
  }, [])

  const toggleArr = (current: string[], val: string) =>
    current.includes(val) ? current.filter((v: string) => v !== val) : [...current, val]

  return (
    <Card>
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex-1 min-w-[240px] max-w-md relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              ref={searchInputRef}
              placeholder="Search SKU, name, brand, GTIN…"
              value={searchInput}
              onChange={(e: any) => setSearchInput(e.target.value)}
              className="pl-7"
            />
          </div>
          <button
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={`h-8 px-3 text-[12px] border rounded inline-flex items-center gap-1.5 ${filtersOpen || filterCount > 0 ? 'border-slate-300 bg-slate-50' : 'border-slate-200 hover:bg-slate-50'}`}
          >
            <Filter size={12} />
            Filters
            {filterCount > 0 && (
              <span className="bg-slate-700 text-white text-[10px] px-1.5 py-0.5 rounded-full font-semibold">{filterCount}</span>
            )}
            <ChevronDown size={12} className={filtersOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
          </button>
          {filterCount > 0 && (
            <button
              onClick={() => updateUrl({ status: '', channels: '', marketplaces: '', productTypes: '', brands: '', tags: '', fulfillment: '', stockLevel: undefined, hasPhotos: undefined, page: undefined })}
              className="h-8 px-2 text-[12px] text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
            >
              <X size={12} /> Clear
            </button>
          )}
        </div>

        {filtersOpen && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 pt-2 border-t border-slate-100">
            <FilterGroup
              label="Status"
              options={['ACTIVE', 'DRAFT', 'INACTIVE']}
              selected={statusFilters}
              counts={facets?.statuses.reduce((m: any, s: any) => { m[s.value] = s.count; return m }, {})}
              onToggle={(v: string) => updateUrl({ status: toggleArr(statusFilters, v).join(',') || undefined, page: undefined })}
            />
            <FilterGroup
              label="Channels"
              options={['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY']}
              selected={channelFilters}
              onToggle={(v: string) => updateUrl({ channels: toggleArr(channelFilters, v).join(',') || undefined, page: undefined })}
            />
            {facets?.marketplaces && facets.marketplaces.length > 0 && (() => {
              // E.5b — Marketplace filter is channel-agnostic (the backend
              // matches `marketplace='IT'` across every ChannelListing
              // regardless of channel). Combine with the Channels filter
              // above to narrow to a single (channel, marketplace) tuple.
              //
              // Dedupe the per-(channel, marketplace) rows from the facet
              // API into one chip per marketplace code, summing counts so
              // a code that exists on both Amazon and eBay shows the
              // combined total.
              const merged = new Map<string, number>()
              for (const m of facets.marketplaces!) {
                merged.set(m.value, (merged.get(m.value) ?? 0) + m.count)
              }
              const codes = Array.from(merged.keys()).sort((a, b) =>
                (merged.get(b) ?? 0) - (merged.get(a) ?? 0),
              )
              const counts = Object.fromEntries(merged)
              return (
                <FilterGroup
                  label="Marketplace"
                  options={codes}
                  selected={marketplaceFilters}
                  counts={counts}
                  renderLabel={(v: string) =>
                    MARKETPLACE_DISPLAY_NAMES[v]
                      ? `${MARKETPLACE_DISPLAY_NAMES[v]} (${v})`
                      : v
                  }
                  onToggle={(v: string) =>
                    updateUrl({
                      marketplaces:
                        toggleArr(marketplaceFilters, v).join(',') || undefined,
                      page: undefined,
                    })
                  }
                />
              )
            })()}
            <FilterGroup
              label="Fulfillment"
              options={['FBA', 'FBM']}
              selected={fulfillmentFilters}
              counts={facets?.fulfillment.reduce((m: any, s: any) => { m[s.value] = s.count; return m }, {})}
              onToggle={(v: string) => updateUrl({ fulfillment: toggleArr(fulfillmentFilters, v).join(',') || undefined, page: undefined })}
            />
            {facets && facets.productTypes.length > 0 && (
              <FilterGroup
                label="Product type"
                options={facets.productTypes.slice(0, 12).map((p: any) => p.value)}
                selected={productTypeFilters}
                counts={facets.productTypes.reduce((m: any, s: any) => { m[s.value] = s.count; return m }, {})}
                renderLabel={(v: string) => IT_TERMS[v] ? `${IT_TERMS[v]} (${v})` : v}
                onToggle={(v: string) => updateUrl({ productTypes: toggleArr(productTypeFilters, v).join(',') || undefined, page: undefined })}
              />
            )}
            {facets && facets.brands.length > 0 && (
              <FilterGroup
                label="Brand"
                options={facets.brands.slice(0, 12).map((p: any) => p.value)}
                selected={brandFilters}
                counts={facets.brands.reduce((m: any, s: any) => { m[s.value] = s.count; return m }, {})}
                onToggle={(v: string) => updateUrl({ brands: toggleArr(brandFilters, v).join(',') || undefined, page: undefined })}
              />
            )}
            {tags.length > 0 && (
              <FilterGroup
                label="Tags"
                options={tags.map((t: Tag) => t.id)}
                selected={tagFilters}
                renderLabel={(id: string) => tags.find((t: Tag) => t.id === id)?.name ?? id}
                onToggle={(v: string) => updateUrl({ tags: toggleArr(tagFilters, v).join(',') || undefined, page: undefined })}
              />
            )}
            <div className="md:col-span-2 lg:col-span-3 flex items-center gap-2 flex-wrap pt-2 border-t border-slate-100">
              <span className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mr-1">Stock</span>
              {(['all', 'in', 'low', 'out'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => updateUrl({ stockLevel: v === 'all' ? undefined : v, page: undefined })}
                  className={`h-7 px-3 text-[11px] border rounded-full font-medium ${stockLevel === v ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'}`}
                >{v}</button>
              ))}
              <span className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold ml-3 mr-1">Photos</span>
              <button
                onClick={() => updateUrl({ hasPhotos: hasPhotos === 'true' ? undefined : 'true', page: undefined })}
                className={`h-7 px-3 text-[11px] border rounded-full font-medium ${hasPhotos === 'true' ? 'bg-emerald-50 text-emerald-700 border-emerald-300' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'}`}
              >Has photos</button>
              <button
                onClick={() => updateUrl({ hasPhotos: hasPhotos === 'false' ? undefined : 'false', page: undefined })}
                className={`h-7 px-3 text-[11px] border rounded-full font-medium ${hasPhotos === 'false' ? 'bg-rose-50 text-rose-700 border-rose-300' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'}`}
              >No photos</button>
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
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">{label}</div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {options.map((opt: string) => {
          const active = selected.includes(opt)
          const count = counts?.[opt]
          return (
            <button
              key={opt}
              onClick={() => onToggle(opt)}
              className={`h-7 px-2 text-[11px] border rounded inline-flex items-center gap-1.5 transition-colors ${active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'}`}
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

// ────────────────────────────────────────────────────────────────────
// SavedViewsButton — load / save / delete / set-default
// ────────────────────────────────────────────────────────────────────
function SavedViewsButton({ open, setOpen, views, onApply, onSaveCurrent, onDelete, onSetDefault }: any) {
  const [saveMode, setSaveMode] = useState(false)
  const [name, setName] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [setOpen])

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5">
        <Bookmark size={12} /> Views <ChevronDown size={12} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 bg-white border border-slate-200 rounded-md shadow-lg z-20 p-2">
          {!saveMode ? (
            <>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 px-2 py-1.5">Saved views</div>
              {views.length === 0 ? (
                <div className="px-2 py-3 text-[12px] text-slate-400 text-center">No saved views yet</div>
              ) : (
                <ul className="space-y-0.5">
                  {views.map((v: SavedView) => (
                    <li key={v.id} className="flex items-center justify-between gap-1 px-2 py-1.5 hover:bg-slate-50 rounded">
                      <button onClick={() => onApply(v)} className="flex-1 min-w-0 text-left text-[12px] text-slate-900 inline-flex items-center gap-1.5">
                        {v.isDefault && <Star size={10} className="text-amber-500 fill-amber-500" />}
                        <span className="truncate">{v.name}</span>
                      </button>
                      <button onClick={() => onSetDefault(v.id)} title="Set as default" className="h-6 w-6 inline-flex items-center justify-center text-slate-400 hover:text-amber-500"><Star size={12} /></button>
                      <button onClick={() => { if (confirm(`Delete view "${v.name}"?`)) onDelete(v.id) }} title="Delete" className="h-6 w-6 inline-flex items-center justify-center text-slate-400 hover:text-rose-600"><Trash2 size={12} /></button>
                    </li>
                  ))}
                </ul>
              )}
              <button onClick={() => setSaveMode(true)} className="w-full mt-1 h-8 px-2 text-[12px] bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 inline-flex items-center justify-center gap-1.5">
                <BookmarkPlus size={12} /> Save current view
              </button>
            </>
          ) : (
            <div className="space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 px-2 py-1">Save current view</div>
              <input
                autoFocus
                type="text"
                placeholder="View name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full h-8 px-2 text-[13px] border border-slate-200 rounded"
              />
              <label className="flex items-center gap-2 px-2 text-[12px] text-slate-700">
                <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
                Use as default on page load
              </label>
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    if (!name.trim()) return
                    const ok = await onSaveCurrent(name.trim(), isDefault)
                    if (ok) { setSaveMode(false); setName(''); setIsDefault(false); setOpen(false) }
                  }}
                  className="flex-1 h-8 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800"
                >Save</button>
                <button onClick={() => { setSaveMode(false); setName('') }} className="flex-1 h-8 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// BulkActionBar — actions across selected products
// ────────────────────────────────────────────────────────────────────
function BulkActionBar({ selectedIds, allTags, onClear, onComplete }: { selectedIds: string[]; allTags: Tag[]; onClear: () => void; onComplete: () => void }) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [tagMenuOpen, setTagMenuOpen] = useState(false)
  const [publishMenuOpen, setPublishMenuOpen] = useState(false)
  const tagMenuRef = useRef<HTMLDivElement>(null)
  const pubMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node)) setTagMenuOpen(false)
      if (pubMenuRef.current && !pubMenuRef.current.contains(e.target as Node)) setPublishMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const run = async (label: string, fn: () => Promise<any>) => {
    setBusy(true)
    setStatus(label)
    try {
      await fn()
      setStatus('Done')
      onComplete()
      setTimeout(() => setStatus(null), 1500)
    } catch (e: any) {
      setStatus(`Error: ${e.message ?? 'failed'}`)
      setTimeout(() => setStatus(null), 3500)
    } finally { setBusy(false) }
  }

  const setStatusBulk = async (s: 'ACTIVE' | 'DRAFT' | 'INACTIVE') => run(
    `Setting ${s}…`,
    async () => {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: selectedIds, status: s }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      // Phase 10 — broadcast so other open pages refresh.
      emitInvalidation({
        type: 'product.updated',
        meta: { productIds: selectedIds, source: 'bulk-status', status: s },
      })
    },
  )

  const duplicate = async () => run(
    'Duplicating…',
    async () => {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk-duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: selectedIds }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      emitInvalidation({
        type: 'product.created',
        meta: { sourceProductIds: selectedIds, source: 'bulk-duplicate' },
      })
    },
  )

  const tagBulk = async (mode: 'add' | 'remove', tagIds: string[]) => run(
    `${mode === 'add' ? 'Tagging' : 'Untagging'}…`,
    async () => {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk-tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: selectedIds, tagIds, mode }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      emitInvalidation({
        type: 'product.updated',
        meta: { productIds: selectedIds, source: 'bulk-tag', mode },
      })
    },
  )

  // Publish: enqueue per-channel via /api/listings/bulk-action.
  // For products without an existing ChannelListing on the target channel,
  // user is redirected to the listing-wizard to set it up first.
  const publish = async (channel: string, marketplace: string) => run(
    `Queuing publish to ${channel} ${marketplace}…`,
    async () => {
      // Step 1: resolve productIds → listingIds for this channel/marketplace
      const params = new URLSearchParams({
        channel, marketplace, includeCoverage: 'false',
      })
      // Use the listings endpoint to find matching listings
      const found = await fetch(`${getBackendUrl()}/api/listings?${params.toString()}&pageSize=500`).then((r) => r.json())
      const ids = (found.listings ?? [])
        .filter((l: any) => selectedIds.includes(l.productId))
        .map((l: any) => l.id)
      if (ids.length === 0) throw new Error('No existing listings on this channel — use the listing wizard to create them first')
      const res = await fetch(`${getBackendUrl()}/api/listings/bulk-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'publish', listingIds: ids }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      emitInvalidation({
        type: 'listing.updated',
        meta: { listingIds: ids, source: 'products-publish', channel, marketplace },
      })
      emitInvalidation({
        type: 'bulk-job.completed',
        meta: { action: 'publish', listingIds: ids },
      })
    },
  )

  return (
    <div className="sticky top-2 z-20">
      <Card>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px] font-semibold text-slate-700">{selectedIds.length} selected</span>
          <div className="h-4 w-px bg-slate-200" />

          <button onClick={() => setStatusBulk('ACTIVE')} disabled={busy} className="h-7 px-3 text-[12px] bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 disabled:opacity-50 inline-flex items-center gap-1.5"><CheckCircle2 size={12} /> Activate</button>
          <button onClick={() => setStatusBulk('DRAFT')} disabled={busy} className="h-7 px-3 text-[12px] bg-slate-50 text-slate-700 border border-slate-200 rounded hover:bg-slate-100 disabled:opacity-50 inline-flex items-center gap-1.5"><EyeOff size={12} /> Draft</button>
          <button onClick={() => setStatusBulk('INACTIVE')} disabled={busy} className="h-7 px-3 text-[12px] bg-rose-50 text-rose-700 border border-rose-200 rounded hover:bg-rose-100 disabled:opacity-50 inline-flex items-center gap-1.5"><XCircle size={12} /> Inactive</button>

          <div className="h-4 w-px bg-slate-200" />

          {/* Tag menu */}
          <div className="relative" ref={tagMenuRef}>
            <button onClick={() => setTagMenuOpen(!tagMenuOpen)} disabled={busy} className="h-7 px-3 text-[12px] bg-white text-slate-700 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5">
              <TagIcon size={12} /> Tag <ChevronDown size={10} />
            </button>
            {tagMenuOpen && (
              <div className="absolute left-0 top-full mt-1 w-64 bg-white border border-slate-200 rounded-md shadow-lg z-30 p-2 max-h-72 overflow-y-auto">
                {allTags.length === 0 ? (
                  <div className="text-[12px] text-slate-400 text-center py-3">No tags yet — create one from a product detail.</div>
                ) : allTags.map((t) => (
                  <div key={t.id} className="flex items-center justify-between px-2 py-1 hover:bg-slate-50 rounded">
                    <span className="text-[12px] text-slate-700 inline-flex items-center gap-1.5">
                      {t.color && <span className="w-2 h-2 rounded-full" style={{ background: t.color }} />}
                      {t.name}
                    </span>
                    <div className="flex items-center gap-1">
                      <button onClick={() => tagBulk('add', [t.id])} className="text-[10px] text-emerald-600 hover:underline">add</button>
                      <button onClick={() => tagBulk('remove', [t.id])} className="text-[10px] text-rose-600 hover:underline">remove</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Publish menu */}
          <div className="relative" ref={pubMenuRef}>
            <button onClick={() => setPublishMenuOpen(!publishMenuOpen)} disabled={busy} className="h-7 px-3 text-[12px] bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 disabled:opacity-50 inline-flex items-center gap-1.5">
              <Eye size={12} /> Publish <ChevronDown size={10} />
            </button>
            {publishMenuOpen && (
              <div className="absolute left-0 top-full mt-1 w-72 bg-white border border-slate-200 rounded-md shadow-lg z-30 p-2 max-h-96 overflow-y-auto">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 px-2 py-1">Amazon EU</div>
                {['IT', 'DE', 'FR', 'ES', 'UK'].map((m) => (
                  <button key={`amz-${m}`} onClick={() => { publish('AMAZON', m); setPublishMenuOpen(false) }} className="w-full text-left px-2 py-1 text-[12px] text-slate-700 hover:bg-slate-50 rounded">
                    Amazon {m} ({COUNTRY_NAMES[m] ?? m})
                  </button>
                ))}
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 px-2 py-1 mt-2">eBay EU</div>
                {['IT', 'DE', 'FR', 'ES', 'UK'].map((m) => (
                  <button key={`ebay-${m}`} onClick={() => { publish('EBAY', m); setPublishMenuOpen(false) }} className="w-full text-left px-2 py-1 text-[12px] text-slate-700 hover:bg-slate-50 rounded">
                    eBay {m} ({COUNTRY_NAMES[m] ?? m})
                  </button>
                ))}
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 px-2 py-1 mt-2">Single-store</div>
                {['SHOPIFY', 'WOOCOMMERCE', 'ETSY'].map((c) => (
                  <button key={c} onClick={() => { publish(c, 'GLOBAL'); setPublishMenuOpen(false) }} className="w-full text-left px-2 py-1 text-[12px] text-slate-700 hover:bg-slate-50 rounded">
                    {c.charAt(0) + c.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button onClick={duplicate} disabled={busy} className="h-7 px-3 text-[12px] bg-white text-slate-700 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5">
            <Copy size={12} /> Duplicate
          </button>

          <Link
            href={`/bulk-operations?productIds=${selectedIds.join(',')}`}
            className="h-7 px-3 text-[12px] bg-violet-50 text-violet-700 border border-violet-200 rounded hover:bg-violet-100 inline-flex items-center gap-1.5"
          >
            <ExternalLink size={12} /> Power edit
          </Link>

          {status && <span className="text-[11px] text-slate-500 ml-2">{status}</span>}
          <button onClick={onClear} disabled={busy} className="ml-auto h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded">
            <X size={14} />
          </button>
        </div>
      </Card>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// GridLens — virtualized table with column picker + inline quick-edit
// ────────────────────────────────────────────────────────────────────
function GridLens(props: any) {
  const {
    products, loading, error, page, pageSize, totalPages, total,
    visibleColumns, setVisibleColumns, columnPickerOpen, setColumnPickerOpen,
    sortBy, onSort, selected, setSelected, onPage, onPageSize, onTagEdit, onChanged,
    // Expand-on-chevron — see ProductsWorkspace for state ownership.
    expandedParents,
    childrenByParent,
    loadingChildren,
    onToggleExpand,
  } = props as {
    products: ProductRow[]
    loading: boolean
    error: string | null
    page: number
    pageSize: number
    totalPages: number
    total: number
    visibleColumns: string[]
    setVisibleColumns: (cols: string[]) => void
    columnPickerOpen: boolean
    setColumnPickerOpen: (open: boolean) => void
    sortBy: string
    onSort: (key: string) => void
    selected: Set<string>
    setSelected: (sel: Set<string>) => void
    onPage: (n: number) => void
    onPageSize: (n: number) => void
    onTagEdit: (id: string) => void
    onChanged: () => void
    expandedParents: Set<string>
    childrenByParent: Record<string, ProductRow[]>
    loadingChildren: Set<string>
    onToggleExpand: (parentId: string) => void
  }

  const visible = useMemo(() => ALL_COLUMNS.filter((c) => visibleColumns.includes(c.key) || c.locked), [visibleColumns])

  const allSelected = products.length > 0 && products.every((p: ProductRow) => selected.has(p.id))
  const toggleSelectAll = () => {
    const next = new Set(selected)
    if (allSelected) products.forEach((p: ProductRow) => next.delete(p.id))
    else products.forEach((p: ProductRow) => next.add(p.id))
    setSelected(next)
  }
  const toggleSelect = (id: string) => {
    const next = new Set(selected)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelected(next)
  }

  if (loading && products.length === 0) {
    return <Card><div className="text-[13px] text-slate-500 py-8 text-center">Loading products…</div></Card>
  }
  if (error) {
    return <Card><div className="text-[13px] text-rose-600 py-8 text-center">Failed to load: {error}</div></Card>
  }
  if (products.length === 0) {
    return <EmptyState icon={Boxes} title="No products match these filters" description="Adjust filters or import products." action={{ label: 'New product', href: '/products/new' }} />
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500">
            <span className="font-semibold text-slate-700 tabular-nums">{total}</span> products · page {page} of {totalPages}
          </span>
          <select
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
            className="h-7 px-2 text-[11px] border border-slate-200 rounded"
          >
            {[50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}/page</option>)}
          </select>
        </div>
        <div className="relative">
          <button
            onClick={() => setColumnPickerOpen(!columnPickerOpen)}
            className="h-7 px-2 text-[12px] border border-slate-200 rounded inline-flex items-center gap-1.5 hover:bg-slate-50"
          >
            <Settings2 size={12} /> Columns ({visibleColumns.length})
          </button>
          {columnPickerOpen && (
            <ColumnPickerMenu visible={visibleColumns} setVisible={setVisibleColumns} onClose={() => setColumnPickerOpen(false)} />
          )}
        </div>
      </div>

      <Card noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="border-b border-slate-200 bg-slate-50 sticky top-0 z-10">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
                </th>
                {/* Chevron column — narrow, no header label. Renders for
                    parents only. Standalones and child rows get an empty
                    cell of the same width so columns line up. */}
                <th className="px-1 py-2 w-6" aria-label="Expand variants" />
                {visible.map((col) => (
                  <th
                    key={col.key}
                    className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-700 text-left ${col.key !== 'thumb' && col.key !== 'actions' ? 'cursor-pointer hover:bg-slate-100' : ''}`}
                    style={{ width: col.width, minWidth: col.width }}
                    onClick={() => {
                      const sortKeys: Record<string, string> = {
                        sku: 'sku', name: 'name', price: 'price-asc', stock: 'stock-asc', updated: 'updated',
                      }
                      if (sortKeys[col.key]) onSort(sortKeys[col.key])
                    }}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {((col.key === 'sku' && sortBy === 'sku') ||
                        (col.key === 'name' && sortBy === 'name') ||
                        (col.key === 'price' && sortBy.startsWith('price')) ||
                        (col.key === 'stock' && sortBy.startsWith('stock')) ||
                        (col.key === 'updated' && sortBy === 'updated')) && (
                        <span className="text-slate-400">↓</span>
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.flatMap((p: ProductRow) => {
                const isSelected = selected.has(p.id)
                const childCount = p.childCount ?? 0
                const canExpand = p.isParent && childCount > 0
                const isExpanded = expandedParents.has(p.id)
                const isLoadingChildren = loadingChildren.has(p.id)
                const children = childrenByParent[p.id] ?? []

                const parentRow = (
                  <tr key={p.id} className={`border-b border-slate-100 hover:bg-slate-50 ${isSelected ? 'bg-blue-50/30' : ''}`}>
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(p.id)} />
                    </td>
                    <td className="px-1 py-2 align-middle">
                      {canExpand ? (
                        <button
                          type="button"
                          onClick={() => onToggleExpand(p.id)}
                          aria-expanded={isExpanded}
                          aria-label={isExpanded ? `Collapse variants of ${p.sku}` : `Expand variants of ${p.sku} (${childCount})`}
                          title={`${childCount} variant${childCount === 1 ? '' : 's'}`}
                          className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-slate-200 text-slate-600"
                        >
                          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      ) : null}
                    </td>
                    {visible.map((col) => (
                      <td key={col.key} className="px-3 py-2 align-middle" style={{ width: col.width, minWidth: col.width }}>
                        <ProductCell col={col.key} product={p} onTagEdit={onTagEdit} onChanged={onChanged} />
                      </td>
                    ))}
                  </tr>
                )

                if (!isExpanded) return [parentRow]

                // Child rows — same shape, indented + tinted to read as nested.
                // Loading and empty states are inline so the user gets
                // feedback without a layout jump.
                const totalCols = 2 + visible.length // checkbox + chevron + visible cells
                const childRows: JSX.Element[] = []

                if (isLoadingChildren) {
                  childRows.push(
                    <tr key={`${p.id}-loading`} className="bg-slate-50/60 border-b border-slate-100">
                      <td colSpan={totalCols} className="px-3 py-2 text-[12px] text-slate-500 italic">
                        Loading variants…
                      </td>
                    </tr>
                  )
                } else if (children.length === 0) {
                  childRows.push(
                    <tr key={`${p.id}-empty`} className="bg-slate-50/60 border-b border-slate-100">
                      <td colSpan={totalCols} className="px-3 py-2 text-[12px] text-slate-500 italic">
                        No variants found{childCount > 0 ? ' (fetch failed — try collapsing and re-opening)' : ''}.
                      </td>
                    </tr>
                  )
                } else {
                  for (const child of children as ProductRow[]) {
                    const childSelected = selected.has(child.id)
                    childRows.push(
                      <tr
                        key={child.id}
                        className={`border-b border-slate-100 bg-slate-50/40 hover:bg-slate-100/60 ${childSelected ? 'bg-blue-50/40' : ''}`}
                      >
                        <td className="px-3 py-2">
                          <input type="checkbox" checked={childSelected} onChange={() => toggleSelect(child.id)} />
                        </td>
                        <td className="px-1 py-2 align-middle">
                          {/* Visual tree-line indent — keeps the chevron
                              column aligned but signals nesting. */}
                          <span className="block h-4 w-4 ml-1 border-l-2 border-b-2 border-slate-300 rounded-bl" />
                        </td>
                        {visible.map((col) => (
                          <td key={col.key} className="px-3 py-2 align-middle" style={{ width: col.width, minWidth: col.width }}>
                            <ProductCell col={col.key} product={child} onTagEdit={onTagEdit} onChanged={onChanged} />
                          </td>
                        ))}
                      </tr>
                    )
                  }
                }

                return [parentRow, ...childRows]
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-[12px] text-slate-500">
          <span>Page <span className="font-semibold text-slate-700 tabular-nums">{page}</span> of <span className="tabular-nums">{totalPages}</span></span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPage(Math.max(1, page - 1))}
              disabled={page === 1}
              className="h-7 px-3 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >Previous</button>
            <button
              onClick={() => onPage(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
              className="h-7 px-3 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >Next</button>
          </div>
        </div>
      )}
    </div>
  )
}

function ProductCell({ col, product, onTagEdit, onChanged }: { col: string; product: ProductRow; onTagEdit: (id: string) => void; onChanged: () => void }) {
  const p = product
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>('')

  const startEdit = (initial: any) => {
    setDraft(String(initial ?? ''))
    setEditing(true)
  }

  const commit = async (field: string) => {
    const value = draft.trim()
    setEditing(false)
    if (value === '' && field !== 'name') return
    let body: any = {}
    if (field === 'price') body.basePrice = Number(value)
    else if (field === 'stock') body.totalStock = Number(value)
    else if (field === 'threshold') body.lowStockThreshold = Number(value)
    else if (field === 'name') body.name = value
    else if (field === 'status') body.status = value
    else if (field === 'fulfillment') body.fulfillmentMethod = value || null
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Update failed')
      // Phase 10 — broadcast so /listings, /bulk-operations,
      // /catalog/organize all refresh within ~200ms. The PATCH routes
      // basePrice / totalStock through the master services in 13c
      // which cascade to ChannelListing — so this also ought to
      // emit listing.updated for those two fields.
      const cascadesToListings = field === 'price' || field === 'stock'
      emitInvalidation({
        type: 'product.updated',
        id: p.id,
        fields: [field],
        meta: { source: 'products-inline-edit' },
      })
      if (cascadesToListings) {
        emitInvalidation({
          type: 'listing.updated',
          meta: { productIds: [p.id], source: 'products-inline-edit', field },
        })
      }
      onChanged()
    } catch (e: any) {
      alert(e.message)
    }
  }

  switch (col) {
    case 'thumb':
      return p.imageUrl ? (
        <img src={p.imageUrl} alt="" className="w-10 h-10 rounded object-cover bg-slate-100" />
      ) : (
        <div className="w-10 h-10 rounded bg-slate-100 flex items-center justify-center text-slate-400">
          <ImageIcon size={14} />
        </div>
      )
    case 'sku':
      return (
        <Link href={`/products/${p.id}/edit`} className="text-[12px] font-mono text-slate-700 hover:text-blue-600 truncate block">
          {p.sku}
        </Link>
      )
    case 'name':
      return editing ? (
        <input
          autoFocus
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit('name')}
          onKeyDown={(e) => { if (e.key === 'Enter') commit('name'); if (e.key === 'Escape') setEditing(false) }}
          className="w-full h-7 px-1.5 text-[13px] border border-blue-300 rounded"
        />
      ) : (
        <button onClick={() => startEdit(p.name)} className="block text-left max-w-full">
          <span className="text-[13px] text-slate-900 truncate block">
            {p.name}
            {p.isParent && <Layers size={10} className="inline ml-1 text-slate-400" />}
          </span>
        </button>
      )
    case 'status':
      return editing ? (
        <select
          autoFocus
          value={draft}
          onChange={(e) => { setDraft(e.target.value); commit('status') }}
          onBlur={() => setEditing(false)}
          className="h-6 px-1 text-[11px] border border-blue-300 rounded"
        >
          <option value="ACTIVE">ACTIVE</option>
          <option value="DRAFT">DRAFT</option>
          <option value="INACTIVE">INACTIVE</option>
        </select>
      ) : (
        <button onClick={() => startEdit(p.status)}>
          <Badge variant={STATUS_VARIANT[p.status] ?? 'default'} size="sm">{p.status}</Badge>
        </button>
      )
    case 'price':
      return editing ? (
        <input
          autoFocus
          type="number"
          step="0.01"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit('price')}
          onKeyDown={(e) => { if (e.key === 'Enter') commit('price'); if (e.key === 'Escape') setEditing(false) }}
          className="w-20 h-7 px-1.5 text-[13px] text-right tabular-nums border border-blue-300 rounded"
        />
      ) : (
        <button onClick={() => startEdit(p.basePrice)} className="block text-right tabular-nums w-full">
          €{p.basePrice.toFixed(2)}
        </button>
      )
    case 'stock': {
      const tone = p.totalStock === 0 ? 'text-rose-600' : p.totalStock <= p.lowStockThreshold ? 'text-amber-600' : 'text-slate-900'
      return editing ? (
        <input
          autoFocus
          type="number"
          min="0"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit('stock')}
          onKeyDown={(e) => { if (e.key === 'Enter') commit('stock'); if (e.key === 'Escape') setEditing(false) }}
          className="w-16 h-7 px-1.5 text-[13px] text-right tabular-nums border border-blue-300 rounded"
        />
      ) : (
        <button onClick={() => startEdit(p.totalStock)} className={`block text-right tabular-nums font-semibold w-full ${tone}`}>
          {p.totalStock}
        </button>
      )
    }
    case 'threshold':
      return editing ? (
        <input
          autoFocus
          type="number"
          min="0"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit('threshold')}
          onKeyDown={(e) => { if (e.key === 'Enter') commit('threshold'); if (e.key === 'Escape') setEditing(false) }}
          className="w-16 h-7 px-1.5 text-[13px] text-right tabular-nums border border-blue-300 rounded"
        />
      ) : (
        <button onClick={() => startEdit(p.lowStockThreshold)} className="block text-right tabular-nums text-slate-500 w-full">
          {p.lowStockThreshold}
        </button>
      )
    case 'brand':
      return <span className="text-[12px] text-slate-700 truncate block">{p.brand ?? <span className="text-slate-400">—</span>}</span>
    case 'productType':
      return <span className="text-[11px] text-slate-700 truncate block">{p.productType ? (IT_TERMS[p.productType] ?? p.productType) : <span className="text-slate-400">—</span>}</span>
    case 'fulfillment':
      return editing ? (
        <select
          autoFocus
          value={draft}
          onChange={(e) => { setDraft(e.target.value); commit('fulfillment') }}
          onBlur={() => setEditing(false)}
          className="h-6 px-1 text-[11px] border border-blue-300 rounded"
        >
          <option value="">—</option>
          <option value="FBA">FBA</option>
          <option value="FBM">FBM</option>
        </select>
      ) : (
        <button onClick={() => startEdit(p.fulfillmentMethod ?? '')}>
          {p.fulfillmentMethod ? (
            <Badge variant={p.fulfillmentMethod === 'FBA' ? 'warning' : 'info'} size="sm">{p.fulfillmentMethod}</Badge>
          ) : <span className="text-slate-400 text-[11px]">—</span>}
        </button>
      )
    case 'coverage':
      if (!p.coverage || Object.keys(p.coverage).length === 0) {
        return <span className="text-[10px] text-slate-400">No listings</span>
      }
      return (
        <div className="flex items-center gap-1 flex-wrap">
          {Object.entries(p.coverage).slice(0, 4).map(([ch, c]) => {
            const tone = c.error > 0 ? 'border-rose-300 bg-rose-50 text-rose-700' : c.live > 0 ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : c.draft > 0 ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-slate-200 bg-white text-slate-400'
            return (
              <Link
                key={ch}
                href={`/listings/${ch.toLowerCase()}?search=${encodeURIComponent(p.sku)}`}
                title={`${ch}: ${c.live} live, ${c.draft} draft, ${c.error} error / ${c.total} total`}
                className={`inline-flex items-center gap-1 px-1.5 h-5 text-[10px] font-mono border rounded ${tone} hover:opacity-80`}
              >
                {ch.slice(0, 3)}<span className="opacity-60">{c.total}</span>
              </Link>
            )
          })}
        </div>
      )
    case 'tags':
      return (
        <div className="flex items-center gap-1 flex-wrap">
          {(p.tags ?? []).slice(0, 3).map((t) => (
            <span key={t.id} className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded" style={{ background: t.color ? `${t.color}20` : '#f1f5f9', color: t.color ?? '#64748b' }}>
              {t.name}
            </span>
          ))}
          <button onClick={() => onTagEdit(p.id)} className="h-4 w-4 inline-flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded text-[10px]">+</button>
        </div>
      )
    case 'photos': {
      const tone = p.photoCount === 0 ? 'text-rose-600' : p.photoCount < 3 ? 'text-amber-600' : 'text-emerald-600'
      return <span className={`text-[12px] tabular-nums font-semibold ${tone}`}>{p.photoCount}</span>
    }
    case 'variants':
      return <span className="text-[12px] tabular-nums text-slate-600">{p.variantCount}</span>
    case 'updated':
      return <span className="text-[11px] text-slate-500">{new Date(p.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
    case 'actions':
      return (
        <div className="flex items-center gap-1 justify-end">
          {/* F1 — "View" opens the drawer instead of navigating. Drawer
              has its own "Open full edit" link for users who want the
              full page. Custom event lets us avoid threading another
              callback through GridLens → ProductCell. */}
          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent('nexus:open-product-drawer', {
                  detail: { productId: p.id },
                }),
              )
            }}
            className="h-6 px-2 text-[11px] text-slate-600 hover:text-blue-600 hover:bg-blue-50 rounded"
            title="Quick view (Esc closes)"
          >
            View
          </button>
          <Link href={`/products/${p.id}/list-wizard`} className="h-6 px-2 text-[11px] text-slate-600 hover:text-emerald-600 hover:bg-emerald-50 rounded">List</Link>
        </div>
      )
    default:
      return null
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
    <div ref={ref} className="absolute right-0 top-full mt-1 w-56 bg-white border border-slate-200 rounded-md shadow-lg z-20 p-1.5 max-h-96 overflow-y-auto">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 px-2 py-1.5">Visible columns</div>
      {togglable.map((c) => (
        <label key={c.key} className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 rounded text-[12px] cursor-pointer">
          <input
            type="checkbox"
            checked={visible.includes(c.key)}
            onChange={() => {
              if (visible.includes(c.key)) setVisible(visible.filter((k) => k !== c.key))
              else setVisible([...visible, c.key])
            }}
          />
          <span className="text-slate-700">{c.label}</span>
        </label>
      ))}
      <div className="border-t border-slate-100 mt-1.5 pt-1.5 px-2 py-1 flex items-center justify-between">
        <button onClick={() => setVisible(DEFAULT_VISIBLE)} className="text-[11px] text-slate-500 hover:text-slate-900">Reset</button>
        <button onClick={onClose} className="text-[11px] text-slate-500 hover:text-slate-900">Close</button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// HierarchyLens — parent + children grouped tree
// ────────────────────────────────────────────────────────────────────
function HierarchyLens({ search }: { search: string }) {
  const [parents, setParents] = useState<any[]>([])
  const [standalones, setStandalones] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      fetch(`${getBackendUrl()}/api/pim/parents-overview?search=${encodeURIComponent(search)}&limit=100`).then((r) => r.json()),
      fetch(`${getBackendUrl()}/api/pim/standalones?search=${encodeURIComponent(search)}&limit=100`).then((r) => r.json()),
    ]).then(([p, s]) => { setParents(p.items ?? []); setStandalones(s.items ?? []) })
      .finally(() => setLoading(false))
  }, [search])

  if (loading) return <Card><div className="text-[13px] text-slate-500 py-8 text-center">Loading hierarchy…</div></Card>

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card title={`Parents (${parents.length})`} description="Products with at least one child variation">
        {parents.length === 0 ? <div className="py-6 text-[12px] text-slate-400 text-center">No parents</div> : (
          <ul className="space-y-1 -my-1">
            {parents.slice(0, 50).map((p) => (
              <li key={p.id}>
                <Link href={`/products/${p.id}/edit?tab=variations`} className="flex items-center justify-between gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-slate-50">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-slate-900 truncate">{p.name}</div>
                    <div className="text-[11px] text-slate-500 font-mono">{p.sku} · {p.childCount ?? 0} children</div>
                  </div>
                  <ChevronDown size={14} className="text-slate-400 -rotate-90" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={`Standalones (${standalones.length})`} description="Products that aren't parents (could be promoted, attached, or kept standalone)">
        {standalones.length === 0 ? <div className="py-6 text-[12px] text-slate-400 text-center">No standalones</div> : (
          <ul className="space-y-1 -my-1">
            {standalones.slice(0, 50).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-slate-50">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-slate-900 truncate">{p.name}</div>
                  <div className="text-[11px] text-slate-500 font-mono">{p.sku}</div>
                </div>
                <Link href="/catalog/organize" className="text-[11px] text-blue-600 hover:underline">Group →</Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// CoverageLens — channel matrix per product
// ────────────────────────────────────────────────────────────────────
function CoverageLens({ products, loading }: { products: ProductRow[]; loading: boolean }) {
  if (loading) return <Card><div className="text-[13px] text-slate-500 py-8 text-center">Loading coverage…</div></Card>
  if (products.length === 0) return <EmptyState icon={Network} title="Nothing to show" description="No products in current filter" />

  const channels = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY']
  return (
    <Card noPadding>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-slate-700 sticky left-0 bg-slate-50 z-10 min-w-[260px]">Product</th>
              {channels.map((c) => (
                <th key={c} className="px-3 py-2 text-center text-[10px] font-semibold uppercase text-slate-500">
                  <span className={`inline-block px-1.5 py-0.5 rounded border ${CHANNEL_TONE[c]}`}>{c}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {products.slice(0, 100).map((p) => (
              <tr key={p.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                <td className="px-3 py-2 sticky left-0 bg-white border-r border-slate-100">
                  <Link href={`/products/${p.id}/edit`} className="block hover:text-blue-600">
                    <div className="text-[13px] font-medium text-slate-900 truncate max-w-xs">{p.name}</div>
                    <div className="text-[11px] text-slate-500 font-mono">{p.sku}</div>
                  </Link>
                </td>
                {channels.map((ch) => {
                  const c = p.coverage?.[ch]
                  if (!c) return <td key={ch} className="px-3 py-2 text-center text-slate-300">—</td>
                  const tone = c.error > 0 ? 'bg-rose-50 text-rose-700 border-rose-200' : c.live > 0 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : c.draft > 0 ? 'bg-slate-50 text-slate-600 border-slate-200' : 'bg-white text-slate-400 border-slate-200'
                  return (
                    <td key={ch} className="px-2 py-2 text-center">
                      <Link href={`/listings/${ch.toLowerCase()}?search=${encodeURIComponent(p.sku)}`} className={`inline-flex items-center px-2 py-1 border rounded text-[11px] hover:opacity-80 ${tone}`}>
                        <span className="font-semibold tabular-nums">{c.live}</span>
                        <span className="opacity-60 mx-0.5">/</span>
                        <span className="opacity-70 tabular-nums">{c.total}</span>
                      </Link>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ────────────────────────────────────────────────────────────────────
// HealthLens — pulls from /api/listings/health and /api/fulfillment overview
// ────────────────────────────────────────────────────────────────────
function HealthLens() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/listings/health`, { cache: 'no-store' })
      .then((r) => r.json())
      .then(setData)
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Card><div className="text-[13px] text-slate-500 py-8 text-center">Loading health…</div></Card>
  if (!data) return <Card><div className="text-[13px] text-rose-600 py-8 text-center">Failed to load health</div></Card>

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <HealthStat label="Errors" value={data.errorCount} tone="danger" />
        <HealthStat label="Suppressed" value={data.suppressedCount} tone="warning" />
        <HealthStat label="Drafts" value={data.draftCount} tone="default" />
        <HealthStat label="Pending sync" value={data.pendingSyncCount} tone="info" />
      </div>
      <Card title="Recent failed listings">
        {data.recentErrors.length === 0 ? (
          <div className="py-6 text-[12px] text-slate-400 text-center">No errors right now</div>
        ) : (
          <ul className="space-y-1 -my-1">
            {data.recentErrors.slice(0, 30).map((e: any) => (
              <li key={e.id}>
                <Link href={`/listings/${e.channel.toLowerCase()}?search=${encodeURIComponent(e.productSku)}`} className="flex items-start justify-between gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-slate-50">
                  <div className="flex items-start gap-2 min-w-0 flex-1">
                    <span className={`inline-block text-[10px] font-semibold uppercase px-1.5 py-0.5 border rounded ${CHANNEL_TONE[e.channel]}`}>{e.channel}</span>
                    <span className="text-[11px] font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">{e.marketplace}</span>
                    <div className="min-w-0">
                      <div className="text-[12px] text-slate-900 truncate">{e.productName}</div>
                      <div className="text-[10px] text-slate-500 font-mono">{e.productSku}</div>
                      {e.lastSyncError && <div className="text-[10px] text-rose-600 truncate mt-0.5">{e.lastSyncError}</div>}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function HealthStat({ label, value, tone }: { label: string; value: number; tone: 'danger' | 'warning' | 'info' | 'default' }) {
  const tones = {
    danger: 'text-rose-600 bg-rose-50',
    warning: 'text-amber-600 bg-amber-50',
    info: 'text-blue-600 bg-blue-50',
    default: 'text-slate-600 bg-slate-100',
  }[tone]
  return (
    <Card>
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded inline-flex items-center justify-center ${tones}`}>
          <AlertTriangle size={18} />
        </div>
        <div>
          <div className="text-[24px] font-semibold tabular-nums text-slate-900">{value}</div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
        </div>
      </div>
    </Card>
  )
}

// ────────────────────────────────────────────────────────────────────
// DraftsLens — folds /listings/drafts
// ────────────────────────────────────────────────────────────────────
function DraftsLens() {
  const [channel, setChannel] = useState('AMAZON')
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/listings/drafts?channel=${channel}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then(setData)
      .finally(() => setLoading(false))
  }, [channel])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1">
        <span className="text-[11px] uppercase tracking-wider text-slate-500 mr-2">Channel:</span>
        {['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'].map((c) => (
          <button
            key={c}
            onClick={() => setChannel(c)}
            className={`h-7 px-3 text-[11px] border rounded inline-flex items-center transition-colors ${channel === c ? `${CHANNEL_TONE[c]} font-semibold` : 'bg-white text-slate-600 border-slate-200'}`}
          >{c}</button>
        ))}
      </div>
      {loading && <Card><div className="text-[13px] text-slate-500 py-8 text-center">Loading drafts…</div></Card>}
      {!loading && data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card title={`Drafts (${data.draftCount})`}>
            {data.drafts.length === 0 ? <div className="py-6 text-[12px] text-slate-400 text-center">No drafts</div> : (
              <ul className="space-y-1 -my-1">
                {data.drafts.slice(0, 30).map((d: any) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-slate-50">
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] text-slate-900 truncate">{d.product.name}</div>
                      <div className="text-[11px] text-slate-500 font-mono">{d.product.sku} · {d.marketplace}</div>
                    </div>
                    <Link href={`/products/${d.productId}/list-wizard?channel=${d.channel}`} className="h-7 px-3 text-[11px] bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100">Publish</Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={`Uncovered (${data.uncoveredCount})`}>
            {data.uncovered.length === 0 ? <div className="py-6 text-[12px] text-slate-400 text-center">All covered</div> : (
              <ul className="space-y-1 -my-1">
                {data.uncovered.slice(0, 30).map((p: any) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-slate-50">
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] text-slate-900 truncate">{p.name}</div>
                      <div className="text-[11px] text-slate-500 font-mono">{p.sku}</div>
                    </div>
                    <Link href={`/products/${p.id}/list-wizard?channel=${channel}`} className="h-7 px-3 text-[11px] bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100">List</Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// TagEditor — drawer for product tags
// ────────────────────────────────────────────────────────────────────
function TagEditor({ productId, onClose, onChanged, allTags }: { productId: string; onClose: () => void; onChanged: () => void; allTags: Tag[] }) {
  const [productTags, setProductTags] = useState<Tag[]>([])
  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState('#3b82f6')
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/${productId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagIds: [] }),
      })
      if (res.ok) {
        const data = await res.json()
        setProductTags(data.tags ?? [])
      }
    } finally { setLoading(false) }
  }, [productId])

  useEffect(() => { refresh() }, [refresh])

  const toggle = async (tag: Tag) => {
    const has = productTags.some((t) => t.id === tag.id)
    if (has) {
      await fetch(`${getBackendUrl()}/api/products/${productId}/tags/${tag.id}`, { method: 'DELETE' })
    } else {
      await fetch(`${getBackendUrl()}/api/products/${productId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagIds: [tag.id] }),
      })
    }
    refresh()
    onChanged()
  }

  const createTag = async () => {
    if (!newTagName.trim()) return
    const res = await fetch(`${getBackendUrl()}/api/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newTagName.trim(), color: newTagColor }),
    })
    if (res.ok) {
      const newTag = await res.json()
      // Attach to current product
      await fetch(`${getBackendUrl()}/api/products/${productId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagIds: [newTag.id] }),
      })
      setNewTagName('')
      onChanged()
      refresh()
    } else {
      const err = await res.json()
      alert(err.error)
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30" />
      <aside onClick={(e) => e.stopPropagation()} className="relative h-full w-full max-w-md bg-white shadow-2xl overflow-y-auto">
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white">
          <div className="text-[13px] font-semibold text-slate-900 inline-flex items-center gap-1.5"><TagIcon size={14} /> Tags</div>
          <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-4">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2">Available tags</div>
            {loading ? <div className="text-[12px] text-slate-500">Loading…</div> : (
              <div className="flex items-center gap-1.5 flex-wrap">
                {allTags.map((t) => {
                  const active = productTags.some((p) => p.id === t.id)
                  return (
                    <button
                      key={t.id}
                      onClick={() => toggle(t)}
                      className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] border rounded transition-colors ${active ? 'border-slate-900' : 'border-slate-200 hover:border-slate-300'}`}
                      style={active ? { background: t.color ? `${t.color}20` : '#f1f5f9', color: t.color ?? '#64748b' } : undefined}
                    >
                      {t.color && <span className="w-1.5 h-1.5 rounded-full" style={{ background: t.color }} />}
                      {t.name}
                      {active && <CheckCircle2 size={10} />}
                    </button>
                  )
                })}
                {allTags.length === 0 && <span className="text-[12px] text-slate-400">No tags yet — create one below.</span>}
              </div>
            )}
          </div>
          <div className="border-t border-slate-100 pt-4 space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Create new tag</div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                placeholder="Tag name"
                className="flex-1 h-8 px-2 text-[13px] border border-slate-200 rounded"
              />
              <input
                type="color"
                value={newTagColor}
                onChange={(e) => setNewTagColor(e.target.value)}
                className="h-8 w-10 border border-slate-200 rounded"
              />
              <button onClick={createTag} className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800">Add</button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// BundleEditor — modal listing all bundles + create new
// ────────────────────────────────────────────────────────────────────
function BundleEditor({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [bundles, setBundles] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [draft, setDraft] = useState<{ wrapperProductId: string; wrapperName: string; name: string; components: Array<{ productId: string; sku: string; name: string; quantity: number }> } | null>(null)

  const fetchBundles = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/bundles`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setBundles(data.items ?? [])
      }
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchBundles() }, [fetchBundles])

  const searchProducts = useCallback(async () => {
    if (!search.trim()) { setSearchResults([]); return }
    const res = await fetch(`${getBackendUrl()}/api/products?search=${encodeURIComponent(search.trim())}&limit=10`)
    if (res.ok) {
      const data = await res.json()
      setSearchResults(data.products ?? [])
    }
  }, [search])

  useEffect(() => { const t = setTimeout(searchProducts, 200); return () => clearTimeout(t) }, [searchProducts])

  const createBundle = async () => {
    if (!draft || !draft.wrapperProductId || !draft.name.trim()) return
    const res = await fetch(`${getBackendUrl()}/api/bundles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: draft.wrapperProductId,
        name: draft.name,
        components: draft.components.map((c) => ({ productId: c.productId, quantity: c.quantity })),
      }),
    })
    if (res.ok) {
      setDraft(null)
      setCreating(false)
      fetchBundles()
      onChanged()
    } else {
      const err = await res.json()
      alert(err.error)
    }
  }

  const deleteBundle = async (id: string) => {
    if (!confirm('Delete this bundle?')) return
    await fetch(`${getBackendUrl()}/api/bundles/${id}`, { method: 'DELETE' })
    fetchBundles()
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-6" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/40" />
      <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-lg shadow-2xl w-full max-w-3xl max-h-[80vh] overflow-y-auto">
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="text-[14px] font-semibold text-slate-900 inline-flex items-center gap-2"><Package size={16} /> Bundles</div>
          <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-4">
          {!creating ? (
            <>
              <button onClick={() => { setCreating(true); setDraft({ wrapperProductId: '', wrapperName: '', name: '', components: [] }) }} className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800 inline-flex items-center gap-1.5">
                <Plus size={12} /> New bundle
              </button>
              {loading ? <div className="text-[13px] text-slate-500 py-6 text-center">Loading…</div> : bundles.length === 0 ? (
                <EmptyState icon={Package} title="No bundles yet" description="Create a bundle to group multiple products into one purchasable unit." />
              ) : (
                <div className="space-y-2">
                  {bundles.map((b) => (
                    <div key={b.id} className="border border-slate-200 rounded p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-semibold text-slate-900">{b.name}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            Wrapper: <span className="font-mono">{b.wrapperProduct?.sku ?? '?'}</span> · Available: <span className="font-semibold tabular-nums">{b.availableStock}</span>
                          </div>
                          <div className="mt-2 flex items-center gap-1 flex-wrap">
                            {b.components.map((c: any, i: number) => (
                              <span key={i} className="text-[10px] font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
                                {c.product?.sku ?? '?'} × {c.quantity}
                              </span>
                            ))}
                          </div>
                        </div>
                        <button onClick={() => deleteBundle(b.id)} className="h-7 w-7 text-slate-400 hover:text-rose-600 inline-flex items-center justify-center rounded">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : draft && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-semibold text-slate-900">New bundle</div>
                <button onClick={() => { setCreating(false); setDraft(null) }} className="text-[12px] text-slate-500 hover:text-slate-900">Cancel</button>
              </div>

              <div>
                <label className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Bundle name</label>
                <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-full h-8 px-2 text-[13px] border border-slate-200 rounded mt-1" placeholder="e.g. Starter kit — Jacket + Helmet + Gloves" />
              </div>

              <div>
                <label className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Wrapper product (the SKU customers actually buy)</label>
                {draft.wrapperProductId ? (
                  <div className="mt-1 px-2 py-1.5 bg-blue-50 border border-blue-200 rounded text-[12px] flex items-center justify-between">
                    <span>{draft.wrapperName}</span>
                    <button onClick={() => setDraft({ ...draft, wrapperProductId: '', wrapperName: '' })} className="text-rose-600">Remove</button>
                  </div>
                ) : (
                  <>
                    <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search SKU or name…" className="w-full h-8 px-2 text-[13px] border border-slate-200 rounded mt-1" />
                    {searchResults.length > 0 && (
                      <div className="mt-1 border border-slate-200 rounded max-h-40 overflow-y-auto">
                        {searchResults.map((p) => (
                          <button key={p.id} onClick={() => { setDraft({ ...draft, wrapperProductId: p.id, wrapperName: `${p.sku} — ${p.name}` }); setSearch('') }} className="w-full text-left px-2 py-1.5 text-[12px] hover:bg-slate-50 border-b border-slate-100 last:border-0">
                            <div className="font-mono text-slate-700">{p.sku}</div>
                            <div className="text-slate-500">{p.name}</div>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div>
                <label className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Components</label>
                {draft.components.length > 0 && (
                  <ul className="mt-1 space-y-1">
                    {draft.components.map((c, i) => (
                      <li key={i} className="flex items-center gap-2 px-2 py-1 bg-slate-50 rounded">
                        <span className="text-[12px] font-mono flex-1 truncate">{c.sku}</span>
                        <input type="number" min="1" value={c.quantity} onChange={(e) => setDraft({ ...draft, components: draft.components.map((cc, j) => j === i ? { ...cc, quantity: Number(e.target.value) || 1 } : cc) })} className="w-16 h-7 px-1 text-right tabular-nums border border-slate-200 rounded text-[12px]" />
                        <button onClick={() => setDraft({ ...draft, components: draft.components.filter((_, j) => j !== i) })} className="text-rose-600"><X size={12} /></button>
                      </li>
                    ))}
                  </ul>
                )}
                {searchResults.length > 0 && search && !draft.wrapperProductId === false && (
                  <div className="mt-1 border border-slate-200 rounded max-h-40 overflow-y-auto">
                    <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-slate-500 bg-slate-50">Add as component</div>
                    {searchResults.map((p) => (
                      <button key={`comp-${p.id}`} onClick={() => { setDraft({ ...draft, components: [...draft.components, { productId: p.id, sku: p.sku, name: p.name, quantity: 1 }] }); setSearch('') }} className="w-full text-left px-2 py-1.5 text-[12px] hover:bg-slate-50 border-b border-slate-100 last:border-0">
                        <div className="font-mono text-slate-700">{p.sku}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button onClick={createBundle} disabled={!draft.wrapperProductId || !draft.name.trim() || draft.components.length === 0} className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50">Create bundle</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
