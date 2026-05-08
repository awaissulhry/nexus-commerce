'use client'

// PRODUCTS REBUILD — universal catalog workspace.
// Five lenses: Grid · Hierarchy · Coverage · Health · Drafts.
// URL-driven state, virtualized table, inline quick-edit, faceted filters,
// saved views, tag + bundle editors, bulk actions across channels.

import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  Boxes, AlertTriangle, LayoutGrid, Sparkles, RefreshCw,
  Settings2, X, ChevronRight, Eye, EyeOff, Tag as TagIcon,
  Package, Plus, FolderTree, Network,
  ExternalLink, Copy, Layers, Image as ImageIcon,
  CheckCircle2, XCircle, AlertCircle, Loader2, Upload,
  DollarSign, Download,
  AlignJustify, Menu as MenuIcon, Equal,
} from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Button } from '@/components/ui/Button'
import { InlineEditTrigger } from '@/components/ui/InlineEditTrigger'
import { getBackendUrl } from '@/lib/backend-url'
import { usePolledList } from '@/lib/sync/use-polled-list'
import {
  emitInvalidation,
  useInvalidationChannel,
} from '@/lib/sync/invalidation-channel'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import ProductDrawer from './_shared/ProductDrawer'
import { parseFilters } from '@/lib/filters'
import {
  type Density,
  DENSITY_CELL_CLASS,
  DENSITY_ROW_HEIGHT,
} from '@/lib/products/theme'
// P.1a — lens components extracted to /_lenses/* in this commit and
// follow-ups. HierarchyLens is the first; CoverageLens, PricingLens,
// HealthLens, DraftsLens follow in the same sweep.
import { HierarchyLens } from './_lenses/HierarchyLens'
import { HealthLens } from './_lenses/HealthLens'
import { DraftsLens } from './_lenses/DraftsLens'
import { CoverageLens } from './_lenses/CoverageLens'
import { PricingLens } from './_lenses/PricingLens'
import { BulkActionBar } from './_components/BulkActionBar'
import { FilterBar } from './_components/FilterBar'
import { SavedViewsButton } from './_components/SavedViewsButton'
import { Pagination } from './_components/Pagination'

// E.3 — lazy-load the heavy modals so they don't ship in /products'
// initial bundle. Each is gated by a boolean state in the workspace,
// so the user only pays the JS download when they actually open one.
// ssr: false because modals are client-only — there's no SSR benefit
// to bundling them server-side.
import dynamic from 'next/dynamic'
const BundleEditor = dynamic(() => import('./_modals/BundleEditor'), {
  ssr: false,
})
const ManageAlertsModal = dynamic(
  () => import('./_modals/ManageAlertsModal'),
  { ssr: false },
)
// AiBulkGenerateModal + CompareProductsModal moved into
// _components/BulkActionBar.tsx (P.1g) — those lazy imports live
// there now, only loaded when an operator opens AI bulk / compare.
import { useToast } from '@/components/ui/Toast'

// ── Types ───────────────────────────────────────────────────────────
type Lens = 'grid' | 'hierarchy' | 'coverage' | 'health' | 'drafts' | 'pricing'

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
  /**
   * P.7 — Product.version for optimistic-concurrency check on inline
   * edits. Sent as If-Match on PATCH /api/products/:id; server
   * returns 409 if the row changed since this list was fetched.
   * Optional because older list responses (and lazy-loaded children
   * fallback) may not include it.
   */
  version?: number
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
  // Catalog hygiene rollup. Counts of top-level products missing each
  // hygiene-relevant field, plus the total. Drives "234 missing X"
  // hints in the filter sidebar.
  hygiene?: {
    total: number
    missingPhotos: number
    missingDescription: number
    missingBrand: number
    missingGtin: number
  }
  // P2 #20 — counts of top-level products with each channel in
  // their syncChannels[] array. Drives "AMAZON (3,200)" inline
  // counts on the Channels filter group.
  channels?: Array<{ value: string; count: number }>
}
type SavedView = {
  id: string
  name: string
  filters: any
  isDefault: boolean
  surface: string
  /** P.3 — alert summary attached server-side. */
  alertSummary?: {
    active: number
    total: number
    firedRecently: number
  }
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
  // F.2 — per-row completeness % computed from name/brand/type/
  // photos/channel-coverage/tags. Hidden by default; operators
  // who care about data quality enable it via the Cols picker.
  { key: 'completeness', label: 'Complete', width: 110 },
  { key: 'updated', label: 'Updated', width: 110 },
  { key: 'actions', label: '', width: 110, locked: true },
]

const DEFAULT_VISIBLE = ['thumb', 'sku', 'name', 'status', 'price', 'stock', 'coverage', 'tags', 'photos', 'updated', 'actions']

// F7 — density modes for the grid. Affects row padding + cell font
// size. Compact gets a power-user up to ~50 rows on a laptop screen;
// P.4 — tokens (Density, DENSITY_CELL_CLASS, DENSITY_ROW_HEIGHT,
// STATUS_VARIANT, CHANNEL_TONE) extracted to lib/products/theme.ts
// so the grid, lenses, drawer, and modal subcomponents reach for the
// same source of truth. Keep imports near where they're used here so
// removing this re-export doesn't ripple through unrelated changes.

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

// MARKETPLACE_DISPLAY_NAMES inlined into _components/FilterBar.tsx
// (P.1h) — workspace no longer references it.

export default function ProductsWorkspace() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { toast } = useToast()

  const lens = (searchParams.get('lens') as Lens) || 'grid'
  const page = parseInt(searchParams.get('page') ?? '1', 10) || 1
  const sortBy = searchParams.get('sortBy') ?? 'updated'
  const pageSize = Math.min(500, parseInt(searchParams.get('pageSize') ?? '100', 10) || 100)

  // F10 — parse the canonical filter contract from 10a. parseFilters
  // accepts BOTH the legacy CSV form (?channels=A,B from pre-Phase-10
  // bookmarks) AND the canonical repeated-key form
  // (?channel=A&channel=B). This page emits CSV today via the manual
  // updateUrl call sites; future cleanup can migrate emission to
  // serializeFilters too. The parse side is the read-side gate that
  // ensures every URL — old or new — produces the same in-memory
  // shape.
  const canonical = useMemo(() => parseFilters(searchParams), [searchParams])
  const search = canonical.search ?? ''
  const statusFilters = canonical.status
  const channelFilters = canonical.channel
  const marketplaceFilters = canonical.marketplace
  // Page-specific dimensions stay on their own URL params (the
  // canonical contract only covers channel/marketplace/status/search).
  const productTypeFilters = searchParams.get('productTypes')?.split(',').filter(Boolean) ?? []
  const brandFilters = searchParams.get('brands')?.split(',').filter(Boolean) ?? []
  const tagFilters = searchParams.get('tags')?.split(',').filter(Boolean) ?? []
  const fulfillmentFilters = searchParams.get('fulfillment')?.split(',').filter(Boolean) ?? []
  const stockLevel = searchParams.get('stockLevel') ?? 'all'
  // P.10 — coverage-gap filter. Products NOT listed on these channels.
  const missingChannelFilters = searchParams.get('missingChannels')?.split(',').filter(Boolean) ?? []

  // F1 — drawer state lives in the URL so back/forward + bookmarks +
  // shared links all work. Open: ?drawer=<productId>. Close: drop the
  // param. The drawer component handles Esc + click-overlay close
  // internally.
  const drawerProductId = searchParams.get('drawer')
  const hasPhotos = searchParams.get('hasPhotos')
  const hasDescription = searchParams.get('hasDescription')
  const hasBrand = searchParams.get('hasBrand')
  const hasGtin = searchParams.get('hasGtin')

  const [searchInput, setSearchInput] = useState(search)
  const [products, setProducts] = useState<ProductRow[]>([])
  const [stats, setStats] = useState<Stats>({ total: 0, active: 0, draft: 0, inStock: 0, outOfStock: 0 })
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // R7.2 — flagged-SKU set from /returns/risk-scores. Cached once
  // per page lifetime; refreshed on workspace reload. Empty Set
  // when the endpoint errors so the badge code can ask `.has()`
  // without nullity guards.
  const [riskFlaggedSkus, setRiskFlaggedSkus] = useState<Set<string>>(new Set())
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/fulfillment/returns/risk-scores`, { cache: 'no-store' })
        if (!res.ok || cancelled) return
        const data = await res.json() as { flagged?: Array<{ sku: string }> }
        if (!cancelled) setRiskFlaggedSkus(new Set((data.flagged ?? []).map((r) => r.sku)))
      } catch { /* non-fatal */ }
    })()
    return () => { cancelled = true }
  }, [])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // E.8 — filtersOpen replaced by FilterBar-local addMenuOpen + editingDim.
  // The bare-F shortcut now fires nexus:open-filter-menu instead.
  const [columnPickerOpen, setColumnPickerOpen] = useState(false)
  const [savedViewMenuOpen, setSavedViewMenuOpen] = useState(false)
  // H.8 — saved-view alert config modal. When set to a view, the
  // ManageAlertsModal opens scoped to that view.
  const [alertConfigView, setAlertConfigView] = useState<SavedView | null>(null)
  const [tagEditorProductId, setTagEditorProductId] = useState<string | null>(null)
  const [bundleEditorOpen, setBundleEditorOpen] = useState(false)
  // F5 — bulk image upload modal. Opens from header "Upload photos"
  // button. Operates across the whole catalog by SKU match, so it's a
  // workspace-level action (not gated by selection).
  const [imageUploadOpen, setImageUploadOpen] = useState(false)

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

  // F7 — density mode. Three settings affect row padding + cell font
  // size; persisted per-user via localStorage. Plumbing matches
  // visibleColumns / pageSize so the user's preferences survive
  // reload + cross-device with the same login.
  const [density, setDensity] = useState<Density>(() => {
    if (typeof window === 'undefined') return 'comfortable'
    try {
      const saved = window.localStorage.getItem('products.density') as Density | null
      return saved && (saved === 'compact' || saved === 'comfortable' || saved === 'spacious')
        ? saved
        : 'comfortable'
    } catch {
      return 'comfortable'
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem('products.density', density)
    } catch {}
  }, [density])

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
    if (missingChannelFilters.length) qs.set('missingChannels', missingChannelFilters.join(','))
    if (stockLevel !== 'all') qs.set('stockLevel', stockLevel)
    if (hasPhotos) qs.set('hasPhotos', hasPhotos)
    if (hasDescription) qs.set('hasDescription', hasDescription)
    if (hasBrand) qs.set('hasBrand', hasBrand)
    if (hasGtin) qs.set('hasGtin', hasGtin)
    qs.set('sort', sortBy)
    qs.set('includeCoverage', 'true')
    qs.set('includeTags', 'true')
    return `/api/products?${qs.toString()}`
  }, [lens, page, pageSize, search, statusFilters, channelFilters, marketplaceFilters, productTypeFilters, brandFilters, tagFilters, fulfillmentFilters, missingChannelFilters, stockLevel, hasPhotos, hasDescription, hasBrand, hasGtin, sortBy])

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

  // Commit 0 — was `catch {}`. Sidecar fetch failures used to be
  // swallowed silently: during a backend outage the user saw stale or
  // empty tag/facet/saved-view UI with no signal that anything went
  // wrong. Now we log to console so dev tools surface the failure;
  // production can attach a logger sink to console.warn if needed.
  // We deliberately do NOT promote these to the page-level error
  // banner because they're sidecars (the products list itself has
  // its own error state via productsError) — failing sidecars
  // shouldn't block the user from working with products.
  const fetchTags = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/tags`, { cache: 'no-store' })
      if (!res.ok) {
        console.warn(`[products] fetchTags: ${res.status} ${res.statusText}`)
        return
      }
      const data = await res.json()
      setTags(data.items ?? [])
    } catch (err) {
      console.warn('[products] fetchTags failed:', err)
    }
  }, [])

  const fetchFacets = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/facets`, { cache: 'no-store' })
      if (!res.ok) {
        console.warn(`[products] fetchFacets: ${res.status} ${res.statusText}`)
        return
      }
      setFacets(await res.json())
    } catch (err) {
      console.warn('[products] fetchFacets failed:', err)
    }
  }, [])

  const fetchSavedViews = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/saved-views?surface=products`, { cache: 'no-store' })
      if (!res.ok) {
        console.warn(`[products] fetchSavedViews: ${res.status} ${res.statusText}`)
        return
      }
      const data = await res.json()
      setSavedViews(data.items ?? [])
    } catch (err) {
      console.warn('[products] fetchSavedViews failed:', err)
    }
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

  // E.1 — stable refs for the row-level callbacks. Without these,
  // ProductRow's React.memo can't skip re-renders because every
  // workspace render creates new arrow refs. updateUrl + setX are
  // already stable; we only need to wrap the composing callbacks.
  const onSort = useCallback(
    (key: string) => updateUrl({ sortBy: key, page: undefined }),
    [updateUrl],
  )
  const onPage = useCallback(
    (p: number) => updateUrl({ page: p === 1 ? undefined : String(p) }),
    [updateUrl],
  )
  const onPageSize = useCallback(
    (s: number) =>
      updateUrl({
        pageSize: s === 100 ? undefined : String(s),
        page: undefined,
      }),
    [updateUrl],
  )
  const onTagEdit = useCallback(
    (id: string) => setTagEditorProductId(id),
    [],
  )
  const onRowChanged = useCallback(() => {
    onTopLevelRefresh()
    fetchProducts()
  }, [onTopLevelRefresh, fetchProducts])

  // E.7 — anchor for shift-click range selection. Tracks the most
  // recent row the user clicked (NOT shift+clicked). Subsequent
  // shift+clicks select every row between the anchor and the clicked
  // row in the *current page's products* array order. Stored as a
  // ref so updating it doesn't trigger a re-render.
  const selectionAnchorRef = useRef<string | null>(null)
  const handleRowToggle = useCallback(
    (id: string, shiftKey: boolean) => {
      const anchorId = selectionAnchorRef.current
      if (shiftKey && anchorId && anchorId !== id) {
        const idxAnchor = products.findIndex((p: ProductRow) => p.id === anchorId)
        const idxClick = products.findIndex((p: ProductRow) => p.id === id)
        if (idxAnchor !== -1 && idxClick !== -1) {
          const lo = Math.min(idxAnchor, idxClick)
          const hi = Math.max(idxAnchor, idxClick)
          // Range select: ALL rows in [lo, hi] become selected. We
          // don't toggle — shift+click is unambiguously additive in
          // every spreadsheet/file-manager UI.
          setSelected((prev) => {
            const next = new Set(prev)
            for (let i = lo; i <= hi; i++) next.add(products[i].id)
            return next
          })
          return
        }
      }
      // Plain click: anchor moves to this row, toggle as usual.
      selectionAnchorRef.current = id
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    [products, setSelected],
  )

  // E.10 — focused row for J/K nav. Tracked by id (stable across
  // pagination + sort changes; index would jump). null = no focus.
  // The visual focus ring lives on ProductRow via the isFocused prop.
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null)
  // Reset focus when pagination / filter / sort changes — the focused
  // id might no longer be on the current page.
  useEffect(() => {
    setFocusedRowId(null)
  }, [
    page,
    search,
    statusFilters.join(','),
    channelFilters.join(','),
    sortBy,
  ])

  // E.7 / E.10 — keyboard shortcuts:
  //   Cmd+A: select all visible (matches Linear / Airtable / Notion)
  //   Esc:   clear selection (preferred when something's selected),
  //          else clear focused row
  //   J:     focus next row
  //   K:     focus previous row
  //   Enter: open drawer for focused row
  //   Space: toggle selection for focused row (alternate path to
  //          shift-click range select)
  // Ignored when the user is typing in a text input.
  useEffect(() => {
    const isTextInput = (el: Element | null) => {
      if (!el) return false
      const tag = el.tagName
      if (tag === 'INPUT') {
        const type = (el as HTMLInputElement).type
        return type !== 'checkbox' && type !== 'radio'
      }
      return tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable
    }
    const onKey = (e: KeyboardEvent) => {
      if (lens !== 'grid') return
      if (isTextInput(document.activeElement)) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault()
        setSelected((prev) => {
          const next = new Set(prev)
          for (const p of products) next.add(p.id)
          return next
        })
        return
      }
      if (e.key === 'Escape') {
        if (selected.size > 0) setSelected(new Set())
        else if (focusedRowId) setFocusedRowId(null)
        return
      }
      // J/K nav (Linear-style) + ArrowUp/ArrowDown aliases for
      // operators who reach for arrow keys before vim bindings.
      // Lower-case match on j/k — Shift+J shouldn't trigger.
      // P.4 — ArrowUp/ArrowDown handle the same row-level cycle.
      // ArrowLeft/Right are reserved for future cell-column nav
      // (P.4b, requires GridLens visible-columns integration).
      const isPrev =
        e.key === 'k' || e.key === 'ArrowUp'
      const isNext =
        e.key === 'j' || e.key === 'ArrowDown'
      if (isPrev || isNext) {
        if (products.length === 0) return
        e.preventDefault()
        // Anchor for navigation: prefer the drawer's open product if
        // one is open (so J/K browses inside the drawer); else the
        // focused row id.
        const anchorId = drawerProductId ?? focusedRowId
        const idx = anchorId
          ? products.findIndex((p: ProductRow) => p.id === anchorId)
          : -1
        const next = isNext
          ? idx < 0
            ? 0
            : (idx + 1) % products.length
          : idx <= 0
            ? products.length - 1
            : idx - 1
        const nextId = products[next].id
        setFocusedRowId(nextId)
        // E.15 — if the drawer is open, swap its product so J/K
        // seamlessly browses without closing it. URL-driven so back/
        // forward and tab-restoration just work.
        if (drawerProductId) {
          updateUrl({ drawer: nextId })
        }
        return
      }
      if (e.key === 'Enter' && focusedRowId) {
        e.preventDefault()
        window.dispatchEvent(
          new CustomEvent('nexus:open-product-drawer', {
            detail: { productId: focusedRowId },
          }),
        )
        return
      }
      if (e.key === ' ' && focusedRowId) {
        e.preventDefault()
        handleRowToggle(focusedRowId, e.shiftKey)
        return
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [
    lens,
    products,
    selected.size,
    focusedRowId,
    handleRowToggle,
    setSelected,
    drawerProductId,
    updateUrl,
  ])

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

  // P.3 — saved-view + alert changes refresh the dropdown so a user
  // editing in one tab (or the alert builder modal) sees the new
  // state without needing a manual reload. The summary fields
  // (alertSummary.firedRecently in particular) need to be fresh
  // because they drive the bell icon highlight.
  useInvalidationChannel(
    ['saved-view.changed', 'saved-view-alert.changed'],
    () => {
      fetchSavedViews()
    },
  )

  // Reset selection when filters change
  useEffect(() => { setSelected(new Set()) }, [page, search, statusFilters.join(','), channelFilters.join(','), marketplaceFilters.join(','), productTypeFilters.join(','), brandFilters.join(','), tagFilters.join(','), fulfillmentFilters.join(','), missingChannelFilters.join(','), stockLevel, hasPhotos, hasDescription, hasBrand, hasGtin])

  // P.15 — page-level keyboard shortcuts. Layered on top of the
  // global CommandPalette which owns Cmd+K / `?` / `/` / 'g <l>'
  // chords. These are /products-specific:
  //
  //   n  → new product (navigates to the create wizard)
  //   f  → toggle the filter panel
  //   r  → refresh the grid
  //
  // Skipped while typing in any input/textarea/contenteditable so
  // they don't hijack edits in inline-edit cells. Skipped on
  // modifier-key combos so they don't conflict with Cmd+R, Ctrl+F,
  // or browser builtins. Same isTypingTarget check the palette uses.
  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      if (target.isContentEditable) return true
      return false
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      const k = e.key.toLowerCase()
      if (k === 'n') {
        e.preventDefault()
        router.push('/products/new')
        return
      }
      if (k === 'f') {
        // E.8 — bare-F now dispatches a custom event so the FilterBar
        // can open its "+ Filter" dimension picker. Accordion is gone;
        // the dimension menu is local to FilterBar.
        e.preventDefault()
        window.dispatchEvent(new Event('nexus:open-filter-menu'))
        return
      }
      if (k === 'r') {
        e.preventDefault()
        void fetchProducts()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [router, fetchProducts])

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
    fulfillmentFilters.length + missingChannelFilters.length +
    (stockLevel !== 'all' ? 1 : 0) + (hasPhotos ? 1 : 0) +
    (hasDescription ? 1 : 0) + (hasBrand ? 1 : 0) + (hasGtin ? 1 : 0)

  return (
    // E.14 — make the debounced search term available to memo'd cells
    // for inline match highlighting. Provider re-render cost is
    // bounded by the same 250ms debounce that gates the URL update,
    // so cells re-highlight at most once per typing pause.
    <SearchContext.Provider value={search}>
    <RiskFlaggedContext.Provider value={riskFlaggedSkus}>
    <div className="space-y-5">
      <PageHeader
        title="Products"
        description={`${stats.total.toLocaleString()} master SKUs · ${stats.active} active · ${stats.draft} draft · ${stats.inStock} in stock · ${stats.outOfStock} out`}
        actions={
          <div className="flex items-center gap-2">
            {/* U.2a — page-header actions migrated to <Button> primitive.
                Secondary outline kept for Upload/Export/Bundles. The
                primary "+ New product" link keeps slate-900 (canonical
                primary on /products); Button's primary is blue-600 so
                we override className on the Link rather than introduce
                a primitive variant change. */}
            <Button
              variant="secondary"
              onClick={() => setImageUploadOpen(true)}
              title="Drop a folder of product photos; we match each file to its SKU"
              icon={<Upload size={12} />}
            >
              Upload photos
            </Button>
            <Button
              variant="secondary"
              onClick={() => exportProductsCsv(products)}
              disabled={products.length === 0}
              title={
                products.length === 0
                  ? 'Nothing to export'
                  : `Download ${products.length} row${products.length === 1 ? '' : 's'} as CSV`
              }
              icon={<Download size={12} />}
            >
              Export
            </Button>
            <Button
              variant="secondary"
              onClick={() => setBundleEditorOpen(true)}
              icon={<Package size={12} />}
            >
              Bundles
            </Button>
            <Link
              href="/products/new"
              className="h-8 px-3 text-md font-medium bg-slate-900 text-white border border-slate-900 rounded-md hover:bg-slate-800 inline-flex items-center justify-center gap-1.5 transition-colors"
            >
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
              <Button
                variant="secondary"
                onClick={() => fetchProducts()}
                icon={<RefreshCw size={12} />}
              >
                Refresh
              </Button>
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
              // P.16 — view-local keys (visibleColumns, density,
              // pageSize) live as state, not URL params. Pull them
              // out before building the URL so they apply via
              // setState and don't pollute the location bar.
              const f = (view.filters ?? {}) as Record<string, any>
              const viewLocal = {
                visibleColumns: f._visibleColumns as string[] | undefined,
                density: f._density as Density | undefined,
                pageSize: f._pageSize as number | undefined,
                // P.3 — view-local column widths. E.12 stores widths
                // in localStorage globally; saving them per-view lets
                // operators have wide-name views vs compact-overview
                // views without manually re-resizing on switch.
                columnWidths: f._columnWidths as
                  | Record<string, number>
                  | undefined,
              }
              if (Array.isArray(viewLocal.visibleColumns)) {
                setVisibleColumns(viewLocal.visibleColumns)
              }
              if (
                viewLocal.density === 'compact' ||
                viewLocal.density === 'comfortable' ||
                viewLocal.density === 'spacious'
              ) {
                setDensity(viewLocal.density)
              }
              // P.3 — push view-local column widths into the
              // localStorage-backed setter via a custom event so
              // VirtualizedGrid (where the state lives) picks them up.
              if (
                viewLocal.columnWidths &&
                typeof viewLocal.columnWidths === 'object'
              ) {
                window.dispatchEvent(
                  new CustomEvent('nexus:apply-column-widths', {
                    detail: { widths: viewLocal.columnWidths },
                  }),
                )
              }
              const next = new URLSearchParams()
              for (const [k, v] of Object.entries(f)) {
                if (k.startsWith('_')) continue // view-local, handled above
                if (v == null || v === '') continue
                next.set(k, Array.isArray(v) ? v.join(',') : String(v))
              }
              if (
                typeof viewLocal.pageSize === 'number' &&
                viewLocal.pageSize !== 100
              ) {
                next.set('pageSize', String(viewLocal.pageSize))
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
              // P.16 — capture grid customization too. Without this
              // a view restored its filters but reset the operator's
              // column config + density to whatever localStorage held
              // — making "Stock review" view useless because it
              // wouldn't switch to compact mode + show the threshold
              // column. Underscore-prefixed keys mark them as
              // view-local (apply via state, not URL).
              const visibleSig = visibleColumns.slice().sort().join(',')
              const defaultSig = DEFAULT_VISIBLE.slice().sort().join(',')
              if (visibleSig !== defaultSig) {
                filters._visibleColumns = visibleColumns
              }
              if (density !== 'comfortable') {
                filters._density = density
              }
              if (pageSize !== 100) {
                filters._pageSize = pageSize
              }
              // P.3 — read current column widths from localStorage
              // (E.12 stores them there) and snapshot into the view.
              try {
                const raw = window.localStorage.getItem(
                  'products.columnWidths',
                )
                if (raw) {
                  const parsed = JSON.parse(raw) as Record<string, number>
                  if (parsed && Object.keys(parsed).length > 0) {
                    filters._columnWidths = parsed
                  }
                }
              } catch {
                /* ignore — view saves without widths if storage failed */
              }
              const res = await fetch(`${getBackendUrl()}/api/saved-views`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, surface: 'products', filters, isDefault }),
              })
              if (res.ok) {
                fetchSavedViews()
                emitInvalidation({
                  type: 'saved-view.changed',
                  meta: { surface: 'products', action: 'created' },
                })
                return true
              }
              const err = await res.json().catch(() => ({}))
              toast.error(err.error ?? 'Save failed')
              return false
            }}
            onDelete={async (id: string) => {
              await fetch(`${getBackendUrl()}/api/saved-views/${id}`, { method: 'DELETE' })
              fetchSavedViews()
              emitInvalidation({
                type: 'saved-view.changed',
                id,
                meta: { surface: 'products', action: 'deleted' },
              })
            }}
            onSetDefault={async (id: string) => {
              await fetch(`${getBackendUrl()}/api/saved-views/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isDefault: true }),
              })
              fetchSavedViews()
              emitInvalidation({
                type: 'saved-view.changed',
                id,
                meta: { surface: 'products', action: 'set-default' },
              })
            }}
            onAlerts={(view: SavedView) => {
              setAlertConfigView(view)
              setSavedViewMenuOpen(false)
            }}
          />
          {/* E.6 — Bundles button moved to the page-header More menu. */}
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
        missingChannelFilters={missingChannelFilters}
        stockLevel={stockLevel}
        hasPhotos={hasPhotos}
        hasDescription={hasDescription}
        hasBrand={hasBrand}
        hasGtin={hasGtin}
        filterCount={filterCount}
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
          productLookup={products}
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
          onSort={onSort}
          selected={selected}
          setSelected={setSelected}
          onRowToggle={handleRowToggle}
          focusedRowId={focusedRowId}
          filterCount={filterCount}
          onClearFilters={() => updateUrl({ status: '', channels: '', marketplaces: '', productTypes: '', brands: '', tags: '', fulfillment: '', missingChannels: '', stockLevel: undefined, hasPhotos: undefined, hasDescription: undefined, hasBrand: undefined, hasGtin: undefined, page: undefined })}
          onPage={onPage}
          onPageSize={onPageSize}
          onTagEdit={onTagEdit}
          onChanged={onRowChanged}
          expandedParents={expandedParents}
          childrenByParent={childrenByParent}
          loadingChildren={loadingChildren}
          onToggleExpand={toggleExpand}
          density={density}
          onDensityChange={setDensity}
        />
      )}

      {lens === 'hierarchy' && <HierarchyLens search={search} />}
      {lens === 'coverage' && <CoverageLens products={products} loading={loading} />}
      {lens === 'pricing' && <PricingLens products={products} loading={loading} />}
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

      {imageUploadOpen && (
        <BulkImageUploadModal
          onClose={() => setImageUploadOpen(false)}
          onComplete={() => {
            setImageUploadOpen(false)
            fetchProducts()
          }}
        />
      )}

      {alertConfigView && (
        <ManageAlertsModal
          view={alertConfigView}
          onClose={() => setAlertConfigView(null)}
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
    </RiskFlaggedContext.Provider>
    </SearchContext.Provider>
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
    { key: 'pricing', label: 'Pricing', icon: DollarSign },
    { key: 'health', label: 'Health', icon: AlertTriangle },
    { key: 'drafts', label: 'Drafts', icon: Sparkles },
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
// ────────────────────────────────────────────────────────────────────
// BulkImageUploadModal (F5)
// ────────────────────────────────────────────────────────────────────
/**
 * F5 — drag-drop a folder of product photos and the system matches
 * each filename to its SKU.
 *
 * Phases: drop → preview → uploading → done
 *
 * Drop: dropzone accepts files OR a folder (webkitdirectory). On
 *   drop we call POST /api/products/images/resolve with the filenames
 *   only — no bytes — to get the per-file match preview cheap.
 * Preview: each file shows matched SKU + slot OR an "unmatched" row.
 *   The user can untick rows they don't want to upload, or rename
 *   the SKU inline for an unmatched file.
 * Uploading: per-file POST /api/products/images/upload with
 *   concurrency 4. Progress bar + per-file status. One failure
 *   doesn't stop the batch.
 * Done: counts + emit product.updated invalidations so the grid +
 *   any open drawer refresh.
 *
 * No client-side image compression today — Cloudinary handles
 * resizing + format conversion at delivery time. Keeps the upload
 * code simple; a 10 MB DSLR JPEG goes through fine under the 50 MB
 * multipart limit.
 */

interface ResolutionPreview {
  filename: string
  ok: boolean
  sku?: string
  productId?: string
  type?: 'MAIN' | 'ALT' | 'LIFESTYLE'
  position?: number | null
  reason?: string
}

interface QueuedFile {
  file: File
  filename: string
  preview: ResolutionPreview
  /** User overrides — defaults from preview, editable inline. */
  selected: boolean
  overrideSku: string | null
  status: 'pending' | 'uploading' | 'success' | 'failed' | 'skipped'
  error?: string
  uploadedUrl?: string
}

const UPLOAD_CONCURRENCY = 4

function BulkImageUploadModal({
  onClose,
  onComplete,
}: {
  onClose: () => void
  onComplete: () => void
}) {
  const [phase, setPhase] = useState<'drop' | 'preview' | 'uploading' | 'done'>(
    'drop',
  )
  const [queue, setQueue] = useState<QueuedFile[]>([])
  const [error, setError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const acceptedImages = (files: File[]) =>
    files.filter((f) => /\.(jpe?g|png|webp|gif|tiff?|avif)$/i.test(f.name))

  const handleFiles = async (raw: File[]) => {
    setError(null)
    const files = acceptedImages(raw)
    if (files.length === 0) {
      setError('No image files in drop (.jpg, .png, .webp, .gif, .tiff, .avif)')
      return
    }
    if (files.length > 1000) {
      setError(`Too many files (${files.length}); max 1000 per batch`)
      return
    }
    setResolving(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/images/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filenames: files.map((f) => f.name) }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json = (await res.json()) as { resolutions: ResolutionPreview[] }
      const previewByFilename = new Map<string, ResolutionPreview>()
      for (const r of json.resolutions) previewByFilename.set(r.filename, r)
      const next: QueuedFile[] = files.map((file) => {
        const preview = previewByFilename.get(file.name) ?? {
          filename: file.name,
          ok: false,
          reason: 'no resolver result',
        }
        return {
          file,
          filename: file.name,
          preview,
          selected: preview.ok,
          overrideSku: null,
          status: 'pending',
        }
      })
      setQueue(next)
      setPhase('preview')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setResolving(false)
    }
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // DataTransferItems is the only API that walks dropped folders;
    // .files is flat.
    const items = e.dataTransfer.items
    if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
      const entries: FileSystemEntry[] = []
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry()
        if (entry) entries.push(entry)
      }
      const files = await readEntriesRecursive(entries)
      if (files.length > 0) {
        await handleFiles(files)
        return
      }
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleFiles(Array.from(e.dataTransfer.files))
    }
  }

  const upload = async () => {
    const eligible = queue.filter((q) => q.selected && (q.preview.ok || q.overrideSku))
    if (eligible.length === 0) {
      setError('Select at least one matched file to upload.')
      return
    }
    setError(null)
    setPhase('uploading')
    // Mark non-eligible as skipped up-front so the done screen totals
    // line up with what the user saw.
    setQueue((prev) =>
      prev.map((q) =>
        eligible.includes(q) ? q : { ...q, status: 'skipped' },
      ),
    )

    // Worker pool — keep up to UPLOAD_CONCURRENCY POSTs in flight.
    let cursor = 0
    const total = eligible.length
    const succeeded: string[] = []
    const runOne = async () => {
      while (true) {
        const idx = cursor
        cursor += 1
        if (idx >= total) return
        const item = eligible[idx]
        setQueue((prev) =>
          prev.map((q) =>
            q.file === item.file ? { ...q, status: 'uploading' } : q,
          ),
        )
        try {
          const fd = new FormData()
          fd.append('file', item.file, item.filename)
          const sku = item.overrideSku ?? item.preview.sku
          const url = sku
            ? `${getBackendUrl()}/api/products/images/upload?sku=${encodeURIComponent(sku)}`
            : `${getBackendUrl()}/api/products/images/upload`
          const res = await fetch(url, { method: 'POST', body: fd })
          if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.error ?? `HTTP ${res.status}`)
          }
          const json = await res.json()
          if (json.productId) succeeded.push(json.productId)
          setQueue((prev) =>
            prev.map((q) =>
              q.file === item.file
                ? { ...q, status: 'success', uploadedUrl: json.url }
                : q,
            ),
          )
        } catch (e) {
          setQueue((prev) =>
            prev.map((q) =>
              q.file === item.file
                ? {
                    ...q,
                    status: 'failed',
                    error: e instanceof Error ? e.message : String(e),
                  }
                : q,
            ),
          )
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(UPLOAD_CONCURRENCY, total) }, () => runOne()),
    )

    // Phase 10 — broadcast so /products grid + drawer refresh inline.
    if (succeeded.length > 0) {
      emitInvalidation({
        type: 'product.updated',
        meta: {
          productIds: Array.from(new Set(succeeded)),
          source: 'bulk-image-upload',
        },
      })
    }
    setPhase('done')
  }

  const counts = useMemo(() => {
    const matched = queue.filter((q) => q.preview.ok || q.overrideSku).length
    const unmatched = queue.length - matched
    const selected = queue.filter(
      (q) => q.selected && (q.preview.ok || q.overrideSku),
    ).length
    const succeeded = queue.filter((q) => q.status === 'success').length
    const failed = queue.filter((q) => q.status === 'failed').length
    const skipped = queue.filter((q) => q.status === 'skipped').length
    const inFlight = queue.filter((q) => q.status === 'uploading').length
    return { matched, unmatched, selected, succeeded, failed, skipped, inFlight }
  }, [queue])

  const setOverrideSku = (file: File, sku: string) => {
    setQueue((prev) =>
      prev.map((q) =>
        q.file === file ? { ...q, overrideSku: sku || null, selected: true } : q,
      ),
    )
  }

  const toggleSelect = (file: File) => {
    setQueue((prev) =>
      prev.map((q) =>
        q.file === file ? { ...q, selected: !q.selected } : q,
      ),
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between flex-shrink-0">
          <div>
            <div className="text-lg font-semibold text-slate-900">
              Upload product photos
            </div>
            <div className="text-sm text-slate-500">
              We match each file to its SKU by filename. Add{' '}
              <span className="font-mono">-1</span>,{' '}
              <span className="font-mono">-2</span>,{' '}
              <span className="font-mono">-MAIN</span>, or{' '}
              <span className="font-mono">-LIFESTYLE</span> for slot
              control.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {phase === 'drop' && (
          <div className="p-5 space-y-3">
            <div
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onDrop={onDrop}
              className="border-2 border-dashed border-slate-300 rounded-lg p-10 text-center text-base text-slate-600 hover:border-purple-300 hover:bg-purple-50/40 transition-colors"
            >
              {resolving ? (
                <div className="inline-flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-purple-600" />
                  Resolving SKUs…
                </div>
              ) : (
                <>
                  <Upload className="w-6 h-6 text-slate-400 mx-auto mb-2" />
                  <div className="text-slate-700 font-medium mb-1">
                    Drop a folder or files here
                  </div>
                  <div className="text-sm text-slate-500">
                    or pick from disk
                  </div>
                  <div className="mt-3 flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="h-7 px-3 text-sm border border-slate-200 rounded hover:bg-white"
                    >
                      Choose files
                    </button>
                    <button
                      type="button"
                      onClick={() => folderInputRef.current?.click()}
                      className="h-7 px-3 text-sm border border-slate-200 rounded hover:bg-white"
                    >
                      Choose folder
                    </button>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*"
                    className="hidden"
                    onChange={(e) =>
                      e.target.files &&
                      handleFiles(Array.from(e.target.files))
                    }
                  />
                  {/* webkitdirectory is non-standard but supported in
                      Chrome / Edge / Safari / Firefox modern. */}
                  <input
                    ref={folderInputRef}
                    type="file"
                    multiple
                    /* eslint-disable @typescript-eslint/no-explicit-any */
                    {...({
                      webkitdirectory: '',
                      directory: '',
                    } as any)}
                    /* eslint-enable @typescript-eslint/no-explicit-any */
                    className="hidden"
                    onChange={(e) =>
                      e.target.files &&
                      handleFiles(Array.from(e.target.files))
                    }
                  />
                </>
              )}
            </div>
            {error && (
              <div className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800 flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="text-sm text-slate-500 pt-1 border-t border-slate-100">
              <div className="font-medium mb-1">Filename conventions</div>
              <ul className="space-y-0.5 list-disc pl-4">
                <li>
                  <span className="font-mono">XV-G-RACE-PRO-BLK-M.jpg</span>{' '}
                  → product&apos;s ALT image
                </li>
                <li>
                  <span className="font-mono">
                    XV-G-RACE-PRO-BLK-M-1.jpg
                  </span>{' '}
                  → MAIN (first position)
                </li>
                <li>
                  <span className="font-mono">
                    XV-G-RACE-PRO-BLK-M-MAIN.jpg
                  </span>{' '}
                  → MAIN
                </li>
                <li>
                  <span className="font-mono">
                    XV-G-RACE-PRO-BLK-M-LIFESTYLE-2.jpg
                  </span>{' '}
                  → LIFESTYLE
                </li>
              </ul>
            </div>
          </div>
        )}

        {(phase === 'preview' || phase === 'uploading') && (
          <>
            <div className="px-5 py-2 border-b border-slate-100 flex items-center justify-between gap-3 flex-shrink-0 text-base text-slate-700">
              <div>
                {counts.matched} matched
                {counts.unmatched > 0 && (
                  <>
                    ,{' '}
                    <span className="text-rose-700">
                      {counts.unmatched} unmatched
                    </span>
                  </>
                )}
                {phase === 'uploading' && (
                  <>
                    {' · '}
                    <span className="text-purple-700">
                      {counts.succeeded}/{counts.selected} done
                    </span>
                    {counts.failed > 0 && (
                      <span className="text-rose-700">
                        , {counts.failed} failed
                      </span>
                    )}
                  </>
                )}
              </div>
              {phase === 'preview' && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setQueue((prev) =>
                        prev.map((q) => ({
                          ...q,
                          selected: q.preview.ok || !!q.overrideSku,
                        })),
                      )
                    }
                    className="h-7 px-2 text-sm text-slate-700 hover:bg-slate-100 rounded-md"
                  >
                    Select matched
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setQueue((prev) =>
                        prev.map((q) => ({ ...q, selected: false })),
                      )
                    }
                    className="h-7 px-2 text-sm text-slate-700 hover:bg-slate-100 rounded-md"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-1.5">
              {queue.map((q) => {
                const matched = q.preview.ok || !!q.overrideSku
                const sku = q.overrideSku ?? q.preview.sku
                return (
                  <div
                    key={q.filename}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-base border ${
                      q.status === 'success'
                        ? 'bg-emerald-50 border-emerald-200'
                        : q.status === 'failed'
                          ? 'bg-rose-50 border-rose-200'
                          : q.status === 'uploading'
                            ? 'bg-purple-50 border-purple-200'
                            : matched
                              ? 'bg-white border-slate-200'
                              : 'bg-amber-50 border-amber-200'
                    }`}
                  >
                    {phase === 'preview' && (
                      <input
                        type="checkbox"
                        checked={q.selected && matched}
                        disabled={!matched}
                        onChange={() => toggleSelect(q.file)}
                      />
                    )}
                    {phase === 'uploading' && (
                      <span className="w-4 h-4 inline-flex items-center justify-center">
                        {q.status === 'success' ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                        ) : q.status === 'failed' ? (
                          <XCircle className="w-4 h-4 text-rose-600" />
                        ) : q.status === 'uploading' ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-600" />
                        ) : q.status === 'skipped' ? (
                          <span className="text-slate-400 text-xs">—</span>
                        ) : (
                          <span className="text-slate-300 text-xs">·</span>
                        )}
                      </span>
                    )}
                    <span className="font-mono text-sm text-slate-700 min-w-0 flex-1 truncate">
                      {q.filename}
                    </span>
                    {matched ? (
                      <>
                        <span className="text-slate-400 text-xs">→</span>
                        <span className="text-slate-900 font-medium">
                          {sku}
                        </span>
                        <span className="text-xs text-slate-500 uppercase tracking-wider">
                          {q.preview.type ?? 'ALT'}
                          {q.preview.position
                            ? ` · #${q.preview.position}`
                            : ''}
                        </span>
                      </>
                    ) : (
                      phase === 'preview' && (
                        <input
                          type="text"
                          placeholder="enter SKU"
                          value={q.overrideSku ?? ''}
                          onChange={(e) =>
                            setOverrideSku(q.file, e.target.value.trim())
                          }
                          className="h-6 px-1.5 text-sm border border-amber-300 rounded bg-white w-32 font-mono"
                        />
                      )
                    )}
                    {q.status === 'failed' && (
                      <span
                        className="text-xs text-rose-700 truncate max-w-[200px]"
                        title={q.error}
                      >
                        {q.error}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>

            {error && (
              <div className="mx-5 mb-3 border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800 flex items-start gap-2 flex-shrink-0">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {phase === 'preview' && (
              <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between gap-3 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setQueue([])
                    setError(null)
                    setPhase('drop')
                  }}
                  className="h-8 px-3 text-base text-slate-700 hover:bg-slate-100 rounded-md"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={upload}
                  disabled={counts.selected === 0}
                  className="h-8 px-3 text-base bg-purple-600 text-white rounded-md hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                >
                  <Upload className="w-3 h-3" />
                  Upload {counts.selected} photo
                  {counts.selected === 1 ? '' : 's'}
                </button>
              </div>
            )}

            {phase === 'uploading' && (
              <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between gap-3 flex-shrink-0 text-sm text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin text-purple-600" />
                <span className="flex-1 text-slate-700">
                  Uploading {counts.inFlight} in flight ·{' '}
                  {counts.succeeded + counts.failed}/{counts.selected}{' '}
                  complete
                </span>
              </div>
            )}
          </>
        )}

        {phase === 'done' && (
          <div className="p-5 space-y-3">
            <div className="text-base text-slate-700">
              <span className="text-emerald-700 font-medium">
                {counts.succeeded} uploaded
              </span>
              {counts.failed > 0 && (
                <span className="text-rose-700">, {counts.failed} failed</span>
              )}
              {counts.skipped > 0 && (
                <span className="text-slate-500"> · {counts.skipped} skipped</span>
              )}
              .
            </div>
            {counts.failed > 0 && (
              <ul className="border border-rose-200 bg-rose-50 rounded-md p-2 max-h-48 overflow-y-auto text-sm text-rose-800 space-y-1">
                {queue
                  .filter((q) => q.status === 'failed')
                  .map((q) => (
                    <li key={q.filename}>
                      <span className="font-mono">{q.filename}</span> —{' '}
                      {q.error}
                    </li>
                  ))}
              </ul>
            )}
            <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  setQueue([])
                  setError(null)
                  setPhase('drop')
                }}
                className="h-8 px-3 text-base text-slate-700 hover:bg-slate-100 rounded-md"
              >
                Upload more
              </button>
              <button
                type="button"
                onClick={onComplete}
                className="h-8 px-3 text-base bg-slate-900 text-white rounded-md hover:bg-slate-800"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Walk a list of FileSystemEntry (the result of webkitGetAsEntry on
 * each DataTransferItem) and flatten into a File array. We only care
 * about files; subdirectories are descended recursively.
 */
async function readEntriesRecursive(
  entries: FileSystemEntry[],
): Promise<File[]> {
  const out: File[] = []
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      )
      out.push(file)
      return
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      // readEntries returns batches; loop until empty.
      while (true) {
        const batch: FileSystemEntry[] = await new Promise((resolve, reject) =>
          reader.readEntries(resolve, reject),
        )
        if (batch.length === 0) break
        for (const child of batch) await walk(child)
      }
    }
  }
  for (const entry of entries) await walk(entry)
  return out
}

// ────────────────────────────────────────────────────────────────────
// MobileProductList (H.9) — card list for narrow viewports
// ────────────────────────────────────────────────────────────────────
/**
 * H.9 — mobile-only card list.
 *
 * Renders the same product set as the desktop grid, but as one
 * tap-friendly card per row. Image thumbnail + name + SKU + price/
 * stock + status pill. Tap anywhere on the card opens the product
 * drawer via the same custom event the grid uses; long-tap the
 * checkbox in the corner toggles selection.
 *
 * Parents render their chevron-expand exactly like the desktop
 * grid; children appear inline indented below their parent. The
 * 30s polling layer + invalidation channel are unaffected — this
 * is purely a presentation swap.
 *
 * Not virtualized: pageSize caps at 500, real mobile sessions
 * scroll at most a few dozen rows before tapping in. The cost of
 * windowing here is more code than it saves.
 */
function MobileProductList({
  products,
  selected,
  toggleSelect,
  expandedParents,
  childrenByParent,
  loadingChildren,
  onToggleExpand,
}: {
  products: ProductRow[]
  selected: Set<string>
  toggleSelect: (id: string, shiftKey: boolean) => void
  expandedParents: Set<string>
  childrenByParent: Record<string, ProductRow[]>
  loadingChildren: Set<string>
  onToggleExpand: (parentId: string) => void
}) {
  const openDrawer = (id: string) => {
    window.dispatchEvent(
      new CustomEvent('nexus:open-product-drawer', { detail: { productId: id } }),
    )
  }
  if (products.length === 0) {
    return (
      <div className="border border-slate-200 rounded-md py-12 text-center text-md text-slate-400">
        No products match these filters
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      {products.map((p) => {
        const isExpanded = expandedParents.has(p.id)
        const childCount = p.childCount ?? 0
        const canExpand = p.isParent && childCount > 0
        const isLoading = loadingChildren.has(p.id)
        const kids = childrenByParent[p.id] ?? []
        return (
          <div key={p.id} className="space-y-1.5">
            <MobileProductCard
              p={p}
              isChild={false}
              selected={selected.has(p.id)}
              toggleSelect={() => toggleSelect(p.id, false)}
              onOpen={() => openDrawer(p.id)}
              chevron={
                canExpand
                  ? {
                      isExpanded,
                      onClick: () => onToggleExpand(p.id),
                      childCount,
                    }
                  : undefined
              }
            />
            {isExpanded && (
              <div className="ml-6 space-y-1 border-l-2 border-slate-200 pl-2">
                {isLoading ? (
                  <div className="text-base text-slate-500 italic px-2 py-1.5 bg-slate-50/60 rounded">
                    Loading variants…
                  </div>
                ) : kids.length === 0 ? (
                  <div className="text-base text-slate-500 italic px-2 py-1.5 bg-slate-50/60 rounded">
                    No variants found
                  </div>
                ) : (
                  kids.map((c) => (
                    <MobileProductCard
                      key={c.id}
                      p={c}
                      isChild
                      selected={selected.has(c.id)}
                      toggleSelect={() => toggleSelect(c.id, false)}
                      onOpen={() => openDrawer(c.id)}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function MobileProductCard({
  p,
  isChild,
  selected,
  toggleSelect,
  onOpen,
  chevron,
}: {
  p: ProductRow
  isChild: boolean
  selected: boolean
  toggleSelect: () => void
  onOpen: () => void
  chevron?: { isExpanded: boolean; onClick: () => void; childCount: number }
}) {
  const stock = Number(p.totalStock ?? 0)
  const stockTone =
    stock === 0
      ? 'text-rose-600'
      : stock <= 5
        ? 'text-amber-600'
        : 'text-emerald-700'
  const status = p.status ?? 'DRAFT'
  const statusColor: Record<string, string> = {
    ACTIVE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    DRAFT: 'bg-slate-50 text-slate-600 border-slate-200',
    INACTIVE: 'bg-slate-50 text-slate-500 border-slate-200',
  }
  return (
    <div
      onClick={onOpen}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border bg-white cursor-pointer active:bg-slate-50 ${
        isChild
          ? 'border-slate-100 bg-slate-50/40'
          : selected
            ? 'border-blue-300 bg-blue-50/40'
            : 'border-slate-200'
      }`}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          toggleSelect()
        }}
        aria-label={selected ? 'Deselect' : 'Select'}
        className={`w-5 h-5 rounded flex-shrink-0 border-2 inline-flex items-center justify-center ${
          selected
            ? 'bg-blue-600 border-blue-600 text-white'
            : 'border-slate-300 bg-white'
        }`}
      >
        {selected && <CheckCircle2 className="w-3 h-3" />}
      </button>
      {p.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={p.imageUrl}
          alt=""
          className="w-12 h-12 rounded object-cover bg-slate-100 flex-shrink-0"
        />
      ) : (
        <div className="w-12 h-12 rounded bg-slate-100 flex items-center justify-center text-slate-400 flex-shrink-0">
          <Package className="w-5 h-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-md text-slate-900 font-medium truncate">
          {p.name ?? '—'}
        </div>
        <div className="text-sm text-slate-500 font-mono truncate flex items-center gap-1.5">
          <span>{p.sku}</span>
          {chevron && (
            <span className="text-slate-300">
              · {chevron.childCount} variant
              {chevron.childCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-1 text-sm">
          <span className="tabular-nums text-slate-700">
            €{Number(p.basePrice ?? 0).toFixed(2)}
          </span>
          <span className="text-slate-300">·</span>
          <span className={`tabular-nums ${stockTone}`}>
            {stock.toLocaleString()} pcs
          </span>
          <span
            className={`ml-auto inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${
              statusColor[status] ?? statusColor.DRAFT
            }`}
          >
            {status}
          </span>
        </div>
      </div>
      {chevron && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            chevron.onClick()
          }}
          aria-label={chevron.isExpanded ? 'Collapse variants' : 'Expand variants'}
          className="w-7 h-7 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 flex-shrink-0"
        >
          {/* E.22 — single ChevronRight that rotates 90° instead of
              swapping icons. Same smoothness as the desktop ProductRow. */}
          <ChevronRight
            className={`w-4 h-4 transition-transform duration-150 ${chevron.isExpanded ? 'rotate-90' : ''}`}
          />
        </button>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// VirtualizedGrid — flat-row TanStack Virtual table for the grid lens
// ────────────────────────────────────────────────────────────────────
/**
 * Virtualization for /products grid. Replaces the prior `<tbody>`
 * fan-out which rendered every row up-front. Approach:
 *
 *   1. Flatten parents + (optionally) their expanded children into a
 *      single FlatRow[] that the virtualizer treats as a list. Loading
 *      / empty placeholders for an expanded-but-empty parent are flat
 *      rows too, so the row count is always exact.
 *   2. Use display: grid on the table + flex on each row for column
 *      alignment. Drop the native CSS-table semantics so we can
 *      absolutely-position rows without breaking column widths.
 *   3. measureElement on each row so wrapped tag chips or multi-line
 *      names don't push the next row over their estimated slot.
 *   4. overscan 12 — enough to keep scrolling smooth without rendering
 *      a full screenful of off-screen rows.
 *   5. The viewport is a fixed-height scroll container (75vh) so the
 *      virtualizer has a defined window. Falls back to overflow:auto
 *      when the user shrinks the page.
 *
 * Selection, sorting, chevron-expand, and inline editing all behave
 * exactly like the prior render — virtualization is a pure perf
 * concern, not a UX change.
 */
type FlatRow =
  | { kind: 'parent'; product: ProductRow }
  | { kind: 'child'; product: ProductRow; parentId: string }
  | { kind: 'loading'; parentId: string }
  | { kind: 'empty'; parentId: string; childCount: number }

function VirtualizedGrid({
  products,
  visible,
  density,
  cellPad,
  selected,
  toggleSelect,
  toggleSelectAll,
  allSelected,
  sortBy,
  onSort,
  expandedParents,
  childrenByParent,
  loadingChildren,
  onToggleExpand,
  onTagEdit,
  onChanged,
  focusedRowId,
}: {
  products: ProductRow[]
  visible: typeof ALL_COLUMNS
  density: Density
  cellPad: string
  selected: Set<string>
  toggleSelect: (id: string, shiftKey: boolean) => void
  toggleSelectAll: () => void
  allSelected: boolean
  sortBy: string
  onSort: (key: string) => void
  expandedParents: Set<string>
  childrenByParent: Record<string, ProductRow[]>
  loadingChildren: Set<string>
  onToggleExpand: (parentId: string) => void
  onTagEdit: (id: string) => void
  onChanged: () => void
  focusedRowId: string | null
}) {
  // Build the flat row list. Order: each parent followed by its
  // expanded children (or a loading/empty placeholder). Memo deps
  // cover everything that can change row identity.
  const flatRows: FlatRow[] = useMemo(() => {
    const rows: FlatRow[] = []
    for (const p of products) {
      rows.push({ kind: 'parent', product: p })
      if (!expandedParents.has(p.id)) continue
      if (loadingChildren.has(p.id)) {
        rows.push({ kind: 'loading', parentId: p.id })
        continue
      }
      const kids = childrenByParent[p.id] ?? []
      if (kids.length === 0) {
        rows.push({
          kind: 'empty',
          parentId: p.id,
          childCount: p.childCount ?? 0,
        })
        continue
      }
      for (const k of kids) {
        rows.push({ kind: 'child', product: k, parentId: p.id })
      }
    }
    return rows
  }, [products, expandedParents, childrenByParent, loadingChildren])

  // E.12 — column resize. Per-column overrides hydrated from
  // localStorage on mount, persisted on commit. The width state is
  // ONLY committed on mouseUp; the live drag updates a CSS custom
  // property directly on the table root via tableRootRef so no
  // React re-render fires per pixel of drag (the cells reference
  // `var(--col-<key>-width)` which updates live).
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    () => {
      if (typeof window === 'undefined') return {}
      try {
        const raw = window.localStorage.getItem('products.columnWidths')
        return raw ? JSON.parse(raw) : {}
      } catch {
        return {}
      }
    },
  )
  useEffect(() => {
    try {
      window.localStorage.setItem(
        'products.columnWidths',
        JSON.stringify(columnWidths),
      )
    } catch {
      /* ignore quota errors */
    }
  }, [columnWidths])
  // P.3 — listen for view-applied widths and replace state. Triggered
  // by SavedViewsButton's onApply when the view carries _columnWidths.
  useEffect(() => {
    const onApplyWidths = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { widths?: Record<string, number> }
        | undefined
      if (detail?.widths && typeof detail.widths === 'object') {
        setColumnWidths(detail.widths)
      }
    }
    window.addEventListener('nexus:apply-column-widths', onApplyWidths)
    return () =>
      window.removeEventListener('nexus:apply-column-widths', onApplyWidths)
  }, [])
  const colWidth = useCallback(
    (key: string, fallback?: number) =>
      columnWidths[key] ?? fallback ?? 100,
    [columnWidths],
  )
  // CSS variables for every visible column; cells reference these via
  // `var(--col-<key>-width)`. Set as inline style on the table root
  // so the cascade picks them up everywhere underneath.
  const tableRootRef = useRef<HTMLDivElement>(null)
  const cssVarStyle = useMemo(() => {
    const style: Record<string, string> = {}
    for (const c of visible) {
      style[`--col-${c.key}-width`] = `${colWidth(c.key, c.width)}px`
    }
    return style as React.CSSProperties
  }, [visible, colWidth])
  // Total table width = checkbox(32) + chevron(24) + sum(effective widths).
  // Used for both header + body min-width so horizontal overflow
  // works correctly inside the scroll container.
  const totalWidth = useMemo(
    () =>
      32 +
      24 +
      visible.reduce(
        (acc, c) => acc + colWidth(c.key, c.width),
        0,
      ),
    [visible, colWidth],
  )

  // E.9 — right-click context menu state. Tracks the click position
  // (so the menu pops where the cursor was) and which product was
  // right-clicked. null means closed. Document-level listeners close
  // it on outside click + Escape; the menu itself stops propagation.
  const [contextMenu, setContextMenu] = useState<
    { x: number; y: number; product: ProductRow } | null
  >(null)
  useEffect(() => {
    if (!contextMenu) return
    const onAway = () => setContextMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('mousedown', onAway)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', onAway, true)
    return () => {
      document.removeEventListener('mousedown', onAway)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('scroll', onAway, true)
    }
  }, [contextMenu])
  const onRowContextMenu = useCallback(
    (e: React.MouseEvent, product: ProductRow) => {
      e.preventDefault()
      setContextMenu({ x: e.clientX, y: e.clientY, product })
    },
    [],
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => DENSITY_ROW_HEIGHT[density],
    overscan: 12,
    // Stable keys so toggling expand doesn't re-mount unrelated rows.
    getItemKey: (index) => {
      const r = flatRows[index]
      if (!r) return index
      if (r.kind === 'parent') return `p:${r.product.id}`
      if (r.kind === 'child') return `c:${r.product.id}`
      if (r.kind === 'loading') return `l:${r.parentId}`
      return `e:${r.parentId}`
    },
  })

  // E.10 — keep the J/K-focused row in view. Find its flat-row index
  // then ask the virtualizer to scroll it within the viewport. align:
  // 'auto' avoids unnecessary scrolling when the row is already
  // visible.
  useEffect(() => {
    if (!focusedRowId) return
    const idx = flatRows.findIndex(
      (r) =>
        (r.kind === 'parent' || r.kind === 'child') &&
        r.product.id === focusedRowId,
    )
    if (idx >= 0) {
      rowVirtualizer.scrollToIndex(idx, { align: 'auto' })
    }
  }, [focusedRowId, flatRows, rowVirtualizer])

  const sortKeys: Record<string, string> = {
    sku: 'sku',
    name: 'name',
    price: 'price-asc',
    stock: 'stock-asc',
    updated: 'updated',
  }
  const totalCols = 2 + visible.length

  return (
    <Card noPadding>
      <div
        ref={containerRef}
        className="overflow-auto relative"
        style={{ maxHeight: '75vh' }}
      >
        <div ref={tableRootRef} style={{ minWidth: totalWidth, ...cssVarStyle }}>
          {/* Header — sticky, flex-aligned to the same column widths
              as the body rows. */}
          <div
            className="flex border-b border-slate-200 bg-slate-50 sticky top-0 z-10"
            role="row"
          >
            <div
              className="px-3 py-2 flex items-center"
              style={{ width: 32, minWidth: 32 }}
              role="columnheader"
            >
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
              />
            </div>
            <div
              className="px-1 py-2"
              style={{ width: 24, minWidth: 24 }}
              role="columnheader"
              aria-label="Expand variants"
            />
            {visible.map((col) => {
              const sortable =
                col.key !== 'thumb' && col.key !== 'actions' && !!sortKeys[col.key]
              // P.20 — aria-sort surfaces the current sort state to
              // screen readers. We track ascending/descending only
              // for price + stock (the other sort keys are
              // direction-implicit per the sortKeys map). Defaults
              // to 'none' for sortable columns the user hasn't
              // touched, 'ascending' / 'descending' for the active
              // one based on sortBy suffix.
              const isActive =
                (col.key === 'sku' && sortBy === 'sku') ||
                (col.key === 'name' && sortBy === 'name') ||
                (col.key === 'price' && sortBy.startsWith('price')) ||
                (col.key === 'stock' && sortBy.startsWith('stock')) ||
                (col.key === 'updated' && sortBy === 'updated')
              const sortDir: 'ascending' | 'descending' | 'none' = !sortable
                ? 'none'
                : !isActive
                ? 'none'
                : sortBy.endsWith('-asc')
                ? 'ascending'
                : 'descending'
              return (
                <div
                  key={col.key}
                  role="columnheader"
                  aria-sort={sortable ? sortDir : undefined}
                  // P.20 — keyboard sortability. tabIndex=0 makes
                  // the header focusable; Enter / Space trigger the
                  // sort the same way a click does.
                  tabIndex={sortable ? 0 : undefined}
                  onKeyDown={(e) => {
                    if (!sortable) return
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSort(sortKeys[col.key])
                    }
                  }}
                  className={`relative px-3 py-2 text-sm font-semibold uppercase tracking-wider text-slate-700 text-left flex items-center group/sort ${sortable ? 'cursor-pointer hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:bg-slate-100' : ''}`}
                  style={{
                    width: `var(--col-${col.key}-width)`,
                    minWidth: `var(--col-${col.key}-width)`,
                  }}
                  onClick={() => {
                    if (sortable) onSort(sortKeys[col.key])
                  }}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {isActive ? (
                      <span className="text-slate-400" aria-hidden="true">
                        {sortDir === 'ascending' ? '↑' : '↓'}
                      </span>
                    ) : sortable ? (
                      // E.16 — show ↕ on hover for sortable columns that
                      // aren't currently the active sort. Telegraphs
                      // sortability without cluttering the resting state.
                      <span
                        className="text-slate-300 opacity-0 group-hover/sort:opacity-100 transition-opacity"
                        aria-hidden="true"
                      >
                        ↕
                      </span>
                    ) : null}
                  </span>
                  {/* E.12 — resize handle. Mouse-down captures starting
                      width + clientX, then mousemove updates the CSS
                      variable directly on the table root (zero React
                      re-renders during drag). mouseUp commits to state
                      + localStorage. */}
                  <ColumnResizeHandle
                    columnKey={col.key}
                    fallbackWidth={col.width ?? 100}
                    tableRootRef={tableRootRef}
                    onCommit={(w) =>
                      setColumnWidths((prev) => ({ ...prev, [col.key]: w }))
                    }
                  />
                </div>
              )
            })}
          </div>

          {/* Body — relative spacer of total height, virtualized rows
              absolute-positioned within. */}
          <div
            role="rowgroup"
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((vRow) => {
              const row = flatRows[vRow.index]
              if (!row) return null
              // E.1 — pre-compute per-row booleans so React.memo can skip
              // re-renders for rows whose selection / expansion didn't change.
              const productId =
                row.kind === 'parent' || row.kind === 'child'
                  ? row.product.id
                  : null
              const isSelected = productId ? selected.has(productId) : false
              const isExpanded = productId
                ? expandedParents.has(productId)
                : false
              const isFocused = productId ? focusedRowId === productId : false
              const productForMenu =
                row.kind === 'parent' || row.kind === 'child'
                  ? row.product
                  : null
              return (
                <div
                  key={vRow.key}
                  data-index={vRow.index}
                  ref={rowVirtualizer.measureElement}
                  role="row"
                  className="border-b border-slate-100 flex"
                  onContextMenu={
                    productForMenu
                      ? (e) => onRowContextMenu(e, productForMenu)
                      : undefined
                  }
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vRow.start}px)`,
                  }}
                >
                  {row.kind === 'parent' && (
                    <ProductRow
                      product={row.product}
                      isChild={false}
                      isSelected={isSelected}
                      isExpanded={isExpanded}
                      isFocused={isFocused}
                      visible={visible}
                      cellPad={cellPad}
                      onToggleSelect={toggleSelect}
                      onToggleExpand={onToggleExpand}
                      onTagEdit={onTagEdit}
                      onChanged={onChanged}
                    />
                  )}
                  {row.kind === 'child' && (
                    <ProductRow
                      product={row.product}
                      isChild={true}
                      isSelected={isSelected}
                      isExpanded={isExpanded}
                      isFocused={isFocused}
                      visible={visible}
                      cellPad={cellPad}
                      onToggleSelect={toggleSelect}
                      onToggleExpand={onToggleExpand}
                      onTagEdit={onTagEdit}
                      onChanged={onChanged}
                    />
                  )}
                  {row.kind === 'loading' && (
                    <div
                      className="bg-slate-50/60 px-3 py-2 text-base text-slate-500 italic flex-1"
                      role="cell"
                      aria-colspan={totalCols}
                    >
                      Loading variants…
                    </div>
                  )}
                  {row.kind === 'empty' && (
                    <div
                      className="bg-slate-50/60 px-3 py-2 text-base text-slate-500 italic flex-1"
                      role="cell"
                      aria-colspan={totalCols}
                    >
                      No variants found
                      {row.childCount > 0
                        ? ' (fetch failed — try collapsing and re-opening)'
                        : ''}
                      .
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
      {contextMenu && (
        <RowContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          product={contextMenu.product}
          onClose={() => setContextMenu(null)}
          onChanged={onChanged}
        />
      )}
    </Card>
  )
}

// E.12 — column resize handle. Sits absolute-right on each header
// cell. mouseDown captures starting clientX + starting width;
// document-level listeners track mousemove (updates the CSS variable
// directly via tableRootRef — zero React updates during drag) and
// mouseUp (commits the final width to state + localStorage via
// onCommit, then removes the listeners).
//
// Width is clamped to [60, 600]. The handle visually disappears when
// not hovered/dragged so headers stay clean; expands to a 4-px-wide
// hit zone via padding.
function ColumnResizeHandle({
  columnKey,
  fallbackWidth,
  tableRootRef,
  onCommit,
}: {
  columnKey: string
  fallbackWidth: number
  tableRootRef: React.RefObject<HTMLDivElement | null>
  onCommit: (width: number) => void
}) {
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const root = tableRootRef.current
      if (!root) return
      // Read the current rendered width — covers both saved overrides
      // and the default (since the CSS variable is set on the root).
      const computed = parseFloat(
        getComputedStyle(root).getPropertyValue(`--col-${columnKey}-width`),
      )
      const startW = Number.isFinite(computed) ? computed : fallbackWidth
      dragRef.current = { startX: e.clientX, startW }
      const onMove = (ev: MouseEvent) => {
        const ctx = dragRef.current
        if (!ctx) return
        const delta = ev.clientX - ctx.startX
        const next = Math.max(60, Math.min(600, ctx.startW + delta))
        // Direct DOM mutation — no React state update during drag.
        // Cells inherit the new width via CSS variable cascade.
        root.style.setProperty(`--col-${columnKey}-width`, `${next}px`)
      }
      const onUp = () => {
        const ctx = dragRef.current
        dragRef.current = null
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        if (!ctx) return
        // Commit the final value (read from the CSS var which is the
        // source of truth post-drag) so totalWidth updates + the new
        // width persists in localStorage.
        const finalComputed = parseFloat(
          getComputedStyle(root).getPropertyValue(
            `--col-${columnKey}-width`,
          ),
        )
        if (Number.isFinite(finalComputed)) onCommit(finalComputed)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [columnKey, fallbackWidth, tableRootRef, onCommit],
  )
  return (
    <div
      onMouseDown={onMouseDown}
      onClick={(e) => e.stopPropagation()}
      role="separator"
      aria-label={`Resize ${columnKey} column`}
      title={`Resize ${columnKey}`}
      className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-blue-400 active:bg-blue-500 transition-colors"
    />
  )
}

// E.9 — right-click context menu for a product row. Pops at the
// click position; closes on outside-click, Escape, or scroll. Actions
// are scoped to a single product (the right-clicked one) — bulk
// actions stay in the bottom-rising bulk action bar. Status flips
// and duplicate hit the existing bulk-status / bulk-duplicate
// endpoints with a one-element productIds array.
function RowContextMenu({
  x,
  y,
  product,
  onClose,
  onChanged,
}: {
  x: number
  y: number
  product: ProductRow
  onClose: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  // Clamp position to viewport so the menu doesn't render off-screen
  // when right-clicked near the right or bottom edge. 240×340 = the
  // menu's max footprint (8 items + gutters + label header).
  const W = 240
  const H = 340
  const adjX = Math.min(x, window.innerWidth - W - 8)
  const adjY = Math.min(y, window.innerHeight - H - 8)
  const flip = async (status: 'ACTIVE' | 'DRAFT' | 'INACTIVE') => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: [product.id], status }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      emitInvalidation({
        type: 'product.updated',
        meta: { productIds: [product.id], source: 'row-context-menu', status },
      })
      onChanged()
    } finally {
      setBusy(false)
      onClose()
    }
  }
  const duplicate = async () => {
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/bulk-duplicate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productIds: [product.id] }),
        },
      )
      if (!res.ok) throw new Error((await res.json()).error)
      emitInvalidation({
        type: 'product.created',
        meta: { sourceProductIds: [product.id], source: 'row-context-menu' },
      })
      onChanged()
    } finally {
      setBusy(false)
      onClose()
    }
  }
  const item = (
    icon: React.ReactNode,
    label: string,
    onClick: () => void,
    disabled = false,
  ) => (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={(e) => {
        e.stopPropagation()
        if (disabled || busy) return
        onClick()
      }}
      className="w-full flex items-center gap-2 h-8 px-2.5 text-base text-left rounded text-slate-700 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent dark:text-slate-200 dark:hover:bg-slate-800"
    >
      <span className="text-slate-500 dark:text-slate-400" aria-hidden="true">
        {icon}
      </span>
      <span className="flex-1">{label}</span>
    </button>
  )
  // Stop the menu's own mousedown from triggering the outside-click
  // close handler; click-outside still works for clicks elsewhere.
  return (
    <div
      role="menu"
      aria-label={`Actions for ${product.sku}`}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: adjX, top: adjY }}
      className="fixed z-50 w-60 bg-white border border-slate-200 rounded-md shadow-xl p-1 dark:bg-slate-900 dark:border-slate-800 animate-fade-in"
    >
      <div className="px-2.5 py-1.5 text-xs uppercase tracking-wider text-slate-500 font-semibold border-b border-slate-100 mb-1 truncate dark:text-slate-400 dark:border-slate-800">
        {product.sku}
      </div>
      {item(<Eye size={14} />, 'Open in drawer', () => {
        window.dispatchEvent(
          new CustomEvent('nexus:open-product-drawer', {
            detail: { productId: product.id },
          }),
        )
        onClose()
      })}
      {item(<ExternalLink size={14} />, 'Open edit page', () => {
        window.location.href = `/products/${product.id}/edit`
      })}
      {item(<Sparkles size={14} />, 'Open list wizard', () => {
        window.location.href = `/products/${product.id}/list-wizard`
      })}
      <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
      {product.status !== 'ACTIVE' &&
        item(<CheckCircle2 size={14} />, 'Activate', () => flip('ACTIVE'))}
      {product.status !== 'DRAFT' &&
        item(<EyeOff size={14} />, 'Set to draft', () => flip('DRAFT'))}
      {product.status !== 'INACTIVE' &&
        item(<XCircle size={14} />, 'Set to inactive', () =>
          flip('INACTIVE'),
        )}
      <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
      {item(<Copy size={14} />, 'Duplicate', duplicate)}
    </div>
  )
}

/**
 * Renders one product row's cells (checkbox + chevron + visible
 * columns). Used by both parent and child rows; child rows get a
 * tinted background + tree-line glyph in the chevron column.
 */
// E.1 — ProductRow as a memoized component.
//
// Was previously `renderProductRow({...})` returning a Fragment, which
// meant every parent re-render (including every keystroke in the search
// box) re-ran the full row render for every visible virtualized row.
// At ~30 visible rows + ProductCell switch branches, that's the bulk
// of /products' perceived slowness.
//
// Memoization needs *boolean* per-row props (isSelected, isExpanded)
// rather than the parent's Sets — otherwise React.memo's shallow
// compare sees a new Set ref on every selection change and re-renders
// every row anyway. The caller (VirtualizedGrid) computes these
// booleans once per visible row, so a single selection change
// re-renders exactly two rows (old + new).
const ProductRow = memo(function ProductRow({
  product,
  isChild,
  isSelected,
  isExpanded,
  isFocused,
  visible,
  cellPad,
  onToggleSelect,
  onToggleExpand,
  onTagEdit,
  onChanged,
}: {
  product: ProductRow
  isChild: boolean
  isSelected: boolean
  isExpanded: boolean
  isFocused: boolean
  visible: typeof ALL_COLUMNS
  cellPad: string
  onToggleSelect: (id: string, shiftKey: boolean) => void
  onToggleExpand: (parentId: string) => void
  onTagEdit: (id: string) => void
  onChanged: () => void
}) {
  const childCount = product.childCount ?? 0
  const canExpand = !isChild && product.isParent && childCount > 0
  // E.10 — focus ring (ring-2 ring-blue-500) applied to every cell of
  // the J/K-focused row. inset-ring prevents the ring from offsetting
  // the row position; combined with bg, gives the Linear-style glow.
  const focusRing = isFocused ? 'ring-2 ring-inset ring-blue-500' : ''
  const rowBg = isChild
    ? isSelected
      ? `bg-blue-50/40 ${focusRing}`
      : `bg-slate-50/40 hover:bg-slate-100/60 ${focusRing}`
    : isSelected
      ? `bg-blue-50/30 ${focusRing}`
      : `hover:bg-slate-50 ${focusRing}`
  return (
    <>
      <div
        className={`px-3 py-2 flex items-center ${rowBg}`}
        style={{ width: 32, minWidth: 32 }}
        role="cell"
      >
        <input
          type="checkbox"
          checked={isSelected}
          // E.7 — onClick (not onChange) so we can capture shiftKey
          // from the mouse event for range-select. preventDefault
          // stops the native toggle; the parent's setSelected runs
          // through onToggleSelect and the next render reflects.
          // onChange is no-op'd to satisfy React's controlled-input
          // contract without firing a redundant toggle.
          onChange={() => {}}
          onClick={(e) => {
            e.preventDefault()
            onToggleSelect(product.id, e.shiftKey)
          }}
          onKeyDown={(e) => {
            if (e.key === ' ') {
              e.preventDefault()
              onToggleSelect(product.id, e.shiftKey)
            }
          }}
        />
      </div>
      <div
        className={`px-1 py-2 flex items-center ${rowBg}`}
        style={{ width: 24, minWidth: 24 }}
        role="cell"
      >
        {canExpand ? (
          <button
            type="button"
            onClick={() => onToggleExpand(product.id)}
            aria-expanded={isExpanded}
            aria-label={
              isExpanded
                ? `Collapse variants of ${product.sku}`
                : `Expand variants of ${product.sku} (${childCount})`
            }
            title={`${childCount} variant${childCount === 1 ? '' : 's'}`}
            // E.22 — single ChevronRight that rotates 90° on expand
            // (was: swap between ChevronRight + ChevronDown). One
            // element, smooth transform, no jitter on toggle.
            className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-slate-200 text-slate-500 hover:text-slate-900"
          >
            <ChevronRight
              size={14}
              className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
            />
          </button>
        ) : isChild ? (
          <span className="block h-4 w-4 ml-1 border-l-2 border-b-2 border-slate-300 rounded-bl" />
        ) : null}
      </div>
      {visible.map((col) => (
        <div
          key={col.key}
          role="cell"
          className={`${cellPad} flex items-center ${rowBg} overflow-hidden`}
          // E.12 — CSS variables drive width so column resize updates
          // every cell live without a React re-render.
          style={{
            width: `var(--col-${col.key}-width)`,
            minWidth: `var(--col-${col.key}-width)`,
          }}
        >
          <ProductCell
            col={col.key}
            product={product}
            onTagEdit={onTagEdit}
            onChanged={onChanged}
          />
        </div>
      ))}
    </>
  )
})

// ────────────────────────────────────────────────────────────────────
// GridLens — virtualized table with column picker + inline quick-edit
// ────────────────────────────────────────────────────────────────────
function GridLens(props: any) {
  const {
    products, loading, error, page, pageSize, totalPages, total,
    visibleColumns, setVisibleColumns, columnPickerOpen, setColumnPickerOpen,
    sortBy, onSort, selected, setSelected, onRowToggle, focusedRowId, onPage, onPageSize, onTagEdit, onChanged,
    // Expand-on-chevron — see ProductsWorkspace for state ownership.
    expandedParents,
    childrenByParent,
    loadingChildren,
    onToggleExpand,
    // F7 — density driven from workspace state, persisted to localStorage.
    density,
    onDensityChange,
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
    setSelected: Dispatch<SetStateAction<Set<string>>>
    /** E.7 — shift-aware toggle from the workspace. Plain click
     *  toggles the row + sets the range anchor; shift+click selects
     *  the range from anchor to clicked row. */
    onRowToggle: (id: string, shiftKey: boolean) => void
    /** E.10 — id of the row currently focused for J/K navigation;
     *  null when no row is focused. Drives the focus ring on
     *  ProductRow + auto-scroll on change. */
    focusedRowId: string | null
    onPage: (n: number) => void
    onPageSize: (n: number) => void
    onTagEdit: (id: string) => void
    onChanged: () => void
    expandedParents: Set<string>
    childrenByParent: Record<string, ProductRow[]>
    loadingChildren: Set<string>
    onToggleExpand: (parentId: string) => void
    density: Density
    onDensityChange: (d: Density) => void
  }
  const cellPad = DENSITY_CELL_CLASS[density] ?? DENSITY_CELL_CLASS.comfortable

  // F7 — render columns in user-defined order (not ALL_COLUMNS order).
  // Locked columns are auto-prepended/appended if missing from the
  // saved order (defensive: a partial localStorage state could omit
  // them). Locked-leading vs locked-trailing distinguished by their
  // position in ALL_COLUMNS — leading locks (thumb/sku/name) prepend,
  // trailing locks (actions) append.
  const visible = useMemo(() => {
    const byKey = new Map(ALL_COLUMNS.map((c) => [c.key, c]))
    const ordered = visibleColumns
      .map((k) => byKey.get(k))
      .filter((c): c is (typeof ALL_COLUMNS)[number] => !!c)
    // Re-add any locked columns missing from the saved order, preserving
    // their original leading/trailing position.
    const orderedKeys = new Set(ordered.map((c) => c.key))
    const missingLeading: typeof ALL_COLUMNS = []
    const missingTrailing: typeof ALL_COLUMNS = []
    let seenUnlocked = false
    for (const c of ALL_COLUMNS) {
      if (orderedKeys.has(c.key)) {
        if (!c.locked) seenUnlocked = true
        continue
      }
      if (c.locked) {
        if (seenUnlocked) missingTrailing.push(c)
        else missingLeading.push(c)
      }
      // Non-locked missing columns stay hidden — that's the user's choice.
    }
    return [...missingLeading, ...ordered, ...missingTrailing]
  }, [visibleColumns])

  const allSelected = products.length > 0 && products.every((p: ProductRow) => selected.has(p.id))
  // E.1 / E.7 — stable refs so ProductRow's React.memo can skip re-
  // renders when an unrelated row's selection changes. toggleSelect
  // delegates to the workspace's shift-aware handler so range select
  // works from any row's checkbox.
  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (products.every((p: ProductRow) => prev.has(p.id))) {
        products.forEach((p: ProductRow) => next.delete(p.id))
      } else {
        products.forEach((p: ProductRow) => next.add(p.id))
      }
      return next
    })
  }, [products, setSelected])
  // Adapter: ProductRow's onToggleSelect is (id, shiftKey?) so we
  // forward both to the workspace's handler. Stable because onRowToggle
  // is itself useCallback'd in the workspace.
  const toggleSelect = onRowToggle

  if (loading && products.length === 0) {
    // E.11 — skeleton rows replace the plain "Loading…" text. The
    // grid shape is preserved so the UI doesn't reflow when real
    // data lands. Six rows is enough to fill a standard viewport
    // without claiming the whole 75vh container.
    return (
      <Card noPadding>
        <div role="status" aria-live="polite" className="sr-only">
          Loading products…
        </div>
        <div className="p-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 px-3 py-3 border-b border-slate-100 last:border-b-0"
              aria-hidden="true"
            >
              <div className="w-4 h-4 rounded bg-slate-200 animate-pulse flex-shrink-0" />
              <div className="w-10 h-10 rounded bg-slate-200 animate-pulse flex-shrink-0" />
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="h-3.5 bg-slate-200 rounded animate-pulse w-1/2" />
                <div className="h-3 bg-slate-100 rounded animate-pulse w-3/4" />
              </div>
              <div className="w-14 h-4 bg-slate-200 rounded animate-pulse flex-shrink-0" />
              <div className="w-10 h-4 bg-slate-200 rounded animate-pulse flex-shrink-0" />
              <div className="w-20 h-4 bg-slate-200 rounded animate-pulse flex-shrink-0 hidden md:block" />
            </div>
          ))}
        </div>
      </Card>
    )
  }
  if (error) {
    return <Card><div role="alert" aria-live="assertive" className="text-md text-rose-600 py-8 text-center">Failed to load: {error}</div></Card>
  }
  if (products.length === 0) {
    // E.13 — empty state distinguishes "filters too narrow" from
    // "catalog is empty". The workspace passes filterCount (number
    // of active dimensions) + onClearFilters; when filters are
    // active we surface the count and a one-click clear instead of
    // making the operator hunt down which filter to remove.
    const filtered = (props as any).filterCount > 0
    return (
      <Card>
        <div className="py-12 px-6 text-center max-w-md mx-auto space-y-3">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-slate-100 text-slate-400 mb-1">
            <Boxes className="w-6 h-6" />
          </div>
          <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {filtered ? 'No products match these filters' : 'No products yet'}
          </div>
          <div className="text-base text-slate-500 dark:text-slate-400">
            {filtered
              ? `${(props as any).filterCount} filter${(props as any).filterCount === 1 ? '' : 's'} applied. Try removing a filter or starting fresh.`
              : 'Import a feed, drop a CSV, or create your first SKU.'}
          </div>
          <div className="flex items-center justify-center gap-2 pt-2 flex-wrap">
            {filtered && (
              <button
                type="button"
                onClick={() => (props as any).onClearFilters?.()}
                className="h-8 px-3 text-base bg-slate-900 text-white rounded-md hover:bg-slate-800 inline-flex items-center gap-1.5"
              >
                <X size={12} /> Clear all filters
              </button>
            )}
            <Link
              href="/products/new"
              className={`h-8 px-3 text-base inline-flex items-center gap-1.5 rounded ${filtered ? 'border border-slate-200 text-slate-700 hover:bg-slate-50' : 'bg-slate-900 text-white hover:bg-slate-800'}`}
            >
              <Plus size={12} /> New product
            </Link>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      {/* P.20 — visually-hidden live status region. Screen readers
          announce the row count + page on every load so blind users
          aren't stuck wondering whether the grid finished loading.
          Sighted users see the same info in the count strip below. */}
      <div role="status" aria-live="polite" className="sr-only">
        Showing {products.length} of {total} products on page {page} of {totalPages}.
      </div>
      {/* U.6 — sticky toolbar so the row count, density toggle, and
          column picker stay reachable while scrolling long grids. The
          translucent backdrop keeps body content visible behind the
          bar; rounded corners + shadow give it a panel feel without
          claiming a full Card. */}
      <div className="sticky top-0 z-30 -mx-2 px-2 py-1.5 flex items-center gap-2 justify-between bg-white/85 backdrop-blur border-b border-slate-200">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-500">
            <span className="font-semibold text-slate-700 tabular-nums">{total}</span> products · page {page} of {totalPages}
          </span>
          <select
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
            className="h-7 px-2 text-sm border border-slate-200 rounded"
          >
            {[50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}/page</option>)}
          </select>
        </div>
        {/* F7 — density picker. Three-segment toggle adjacent to the
            columns picker. Persisted per-user via localStorage. */}
        <div className="inline-flex items-center border border-slate-200 rounded overflow-hidden h-7 text-sm">
          {(['compact', 'comfortable', 'spacious'] as const).map((d) => {
            // U.6 — Lucide icons replace the ASCII glyphs (≡ ☰ ☲) which
            // didn't visually align across fonts. The icon vocabulary
            // walks 4 → 3 → 2 horizontal lines so the density gradient
            // reads at a glance.
            const Icon = d === 'compact' ? AlignJustify : d === 'comfortable' ? MenuIcon : Equal
            const labelTitle = `${d.charAt(0).toUpperCase()}${d.slice(1)} row density`
            return (
              <button
                key={d}
                type="button"
                onClick={() => onDensityChange(d)}
                title={labelTitle}
                aria-label={labelTitle}
                aria-pressed={density === d}
                className={`px-2 h-full inline-flex items-center justify-center ${
                  density === d
                    ? 'bg-slate-900 text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )
          })}
        </div>
        <div className="relative">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setColumnPickerOpen(!columnPickerOpen)}
            icon={<Settings2 size={12} />}
          >
            Columns ({visibleColumns.length})
          </Button>
          {columnPickerOpen && (
            <ColumnPickerMenu visible={visibleColumns} setVisible={setVisibleColumns} onClose={() => setColumnPickerOpen(false)} />
          )}
        </div>
      </div>

      {/* Desktop grid — virtualized table. Hidden below md where the
          card list takes over. */}
      <div className="hidden md:block">
        <VirtualizedGrid
          products={products}
          visible={visible}
          density={density}
          cellPad={cellPad}
          selected={selected}
          toggleSelect={toggleSelect}
          toggleSelectAll={toggleSelectAll}
          allSelected={allSelected}
          sortBy={sortBy}
          onSort={onSort}
          expandedParents={expandedParents}
          childrenByParent={childrenByParent}
          loadingChildren={loadingChildren}
          onToggleExpand={onToggleExpand}
          onTagEdit={onTagEdit}
          onChanged={onChanged}
          focusedRowId={focusedRowId}
        />
      </div>
      {/* Mobile card list — md:hidden. Shows the same product set
          but as tap-friendly cards. Selection works (long-press on
          the checkbox region in the corner) but the daily-driver
          mobile flow is browse + open-drawer. */}
      <div className="md:hidden">
        <MobileProductList
          products={products}
          selected={selected}
          toggleSelect={toggleSelect}
          expandedParents={expandedParents}
          childrenByParent={childrenByParent}
          loadingChildren={loadingChildren}
          onToggleExpand={onToggleExpand}
        />
      </div>

      {totalPages > 1 && (
        <Pagination page={page} totalPages={totalPages} onPage={onPage} />
      )}
    </div>
  )
}

// E.1 — memo'd so a row that didn't change skips its 9-column re-render.
// onTagEdit + onChanged come from useCallback'd refs in the workspace,
// so they're stable across renders.
// E.14 — search-term highlighting context. Workspace publishes the
// debounced URL search term here; cells consume it via useContext to
// wrap matches in <mark>. Context (not prop) so the search term
// doesn't have to thread through 4 levels of props + bust memo on
// every input change. Search updates are already debounced 250ms,
// so re-renders are bounded.
const SearchContext = createContext<string>('')

// R7.2 — flagged-SKU context. ProductCell reads it to render the
// "high return rate" badge on the SKU cell when the product's SKU
// is in the set. Same context-not-prop reasoning as SearchContext:
// avoids busting the cell's memo when the set is otherwise stable
// across the workspace lifetime.
const RiskFlaggedContext = createContext<Set<string>>(new Set())

// R7.2 — small inline badge surfaced on flagged SKUs. Click jumps
// to the returns analytics page where the operator sees the bucket
// math (rate vs mean, σ above) and decides whether to act on the
// listing (size chart, photos, copy).
function RiskBadge({ sku }: { sku: string }) {
  const flagged = useContext(RiskFlaggedContext)
  if (!flagged.has(sku)) return null
  return (
    <Link
      href="/fulfillment/returns/analytics"
      className="inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wider px-1 py-0.5 bg-rose-50 text-rose-700 border border-rose-200 rounded hover:bg-rose-100"
      title="High return rate (>2σ above productType mean) — click for analytics"
    >
      ↩ HI
    </Link>
  )
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query || !text) return <>{text}</>
  // Case-insensitive split on the query. Escape regex metachars so
  // operators searching for SKUs with `.`, `[`, `(`, etc don't blow
  // up the regex. Matches stay in the result array as odd-indexed
  // entries when split() includes a capturing group.
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(${escaped})`, 'ig')
  const parts = text.split(re)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark
            key={i}
            className="bg-yellow-100 text-slate-900 rounded-sm px-0.5"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}

const ProductCell = memo(function ProductCell({ col, product, onTagEdit, onChanged }: { col: string; product: ProductRow; onTagEdit: (id: string) => void; onChanged: () => void }) {
  // E.14 — pull the active search query so SKU + name cells can wrap
  // matches in <mark>. Other cells ignore it.
  const searchQuery = useContext(SearchContext)
  const p = product
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>('')
  // P.7 — inline error string. Replaces the previous alert() flow so
  // a failed save shows up under the cell instead of a modal popup.
  // null = no error; non-null = banner visible. Cleared on next edit
  // attempt or when the user clicks the dismiss x.
  const [cellError, setCellError] = useState<string | null>(null)

  const startEdit = (initial: any) => {
    setDraft(String(initial ?? ''))
    setEditing(true)
    setCellError(null)
  }

  const commit = async (field: string) => {
    const value = draft.trim()
    setEditing(false)
    if (value === '' && field !== 'name' && field !== 'brand' && field !== 'productType') return
    const body: any = {}
    if (field === 'price') body.basePrice = Number(value)
    else if (field === 'stock') body.totalStock = Number(value)
    else if (field === 'threshold') body.lowStockThreshold = Number(value)
    else if (field === 'name') body.name = value
    else if (field === 'status') body.status = value
    else if (field === 'fulfillment') body.fulfillmentMethod = value || null
    else if (field === 'brand') body.brand = value || null
    else if (field === 'productType') body.productType = value || null
    try {
      // P.7 — If-Match optimistic-concurrency. Commit 0 added the
      // server-side CAS check on PATCH /api/products/:id. We send
      // version as the matcher; on 409 the server tells us the
      // current version and we surface it inline + refresh the row.
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (typeof p.version === 'number') headers['If-Match'] = String(p.version)
      const res = await fetch(`${getBackendUrl()}/api/products/${p.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}))
        if (res.status === 409 && errJson?.code === 'VERSION_CONFLICT') {
          // Refresh the grid so the operator sees the current value
          // before retrying. The inline banner stays until cleared.
          setCellError(
            `Another change landed first (version ${errJson.currentVersion ?? '?'}) — refreshing.`,
          )
          onChanged()
          return
        }
        throw new Error(errJson?.error ?? `Update failed (${res.status})`)
      }
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
      setCellError(null)
      onChanged()
    } catch (e: any) {
      setCellError(e instanceof Error ? e.message : String(e))
    }
  }

  // P.7 — small inline banner shown beneath the editable cell when
  // the most recent commit failed. Click x to dismiss; opening any
  // edit clears it automatically. Kept tiny so it doesn't push the
  // row height meaningfully; long messages truncate.
  const errorBanner = cellError ? (
    <div className="mt-0.5 inline-flex items-start gap-1 px-1.5 py-0.5 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded max-w-full">
      <AlertCircle size={10} className="mt-0.5 flex-shrink-0" />
      <span className="truncate" title={cellError}>{cellError}</span>
      <button
        onClick={() => setCellError(null)}
        className="hover:bg-rose-100 rounded px-0.5"
        aria-label="Dismiss error"
      >
        <X size={10} />
      </button>
    </div>
  ) : null

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
        <div className="inline-flex items-center gap-1.5 min-w-0">
          <Link href={`/products/${p.id}/edit`} className="text-base font-mono text-slate-700 hover:text-blue-600 truncate">
            <Highlight text={p.sku} query={searchQuery} />
          </Link>
          {/* R7.2 — high-return-rate badge. The /returns/risk-scores
              endpoint flags SKUs >2σ above their productType's mean
              return rate (with min-bucket gates). Click → analytics
              page where the operator can drill into the SKU's
              context. */}
          <RiskBadge sku={p.sku} />
        </div>
      )
    case 'name':
      return (
        <>
          {editing ? (
            <input
              autoFocus
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commit('name')}
              onKeyDown={(e) => { if (e.key === 'Enter') commit('name'); if (e.key === 'Escape') setEditing(false) }}
              className="w-full h-7 px-1.5 text-md border border-blue-300 rounded"
            />
          ) : (
            <InlineEditTrigger onClick={() => startEdit(p.name)} label="name" align="left">
              <span className="text-md text-slate-900">
                <Highlight text={p.name} query={searchQuery} />
                {p.isParent && <Layers size={10} className="inline ml-1 text-slate-400" />}
              </span>
            </InlineEditTrigger>
          )}
          {errorBanner}
        </>
      )
    case 'status':
      return (
        <>
          {editing ? (
            <select
              autoFocus
              value={draft}
              onChange={(e) => { setDraft(e.target.value); commit('status') }}
              onBlur={() => setEditing(false)}
              className="h-6 px-1 text-sm border border-blue-300 rounded"
            >
              <option value="ACTIVE">ACTIVE</option>
              <option value="DRAFT">DRAFT</option>
              <option value="INACTIVE">INACTIVE</option>
            </select>
          ) : (
            <InlineEditTrigger
              onClick={() => startEdit(p.status)}
              label="status"
              size="sm"
              hideIcon
              className="w-auto"
            >
              <StatusBadge status={p.status} size="sm" />
            </InlineEditTrigger>
          )}
          {errorBanner}
        </>
      )
    case 'price':
      return (
        <>
          {editing ? (
            <input
              autoFocus
              type="number"
              step="0.01"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commit('price')}
              onKeyDown={(e) => { if (e.key === 'Enter') commit('price'); if (e.key === 'Escape') setEditing(false) }}
              className="w-20 h-7 px-1.5 text-md text-right tabular-nums border border-blue-300 rounded"
            />
          ) : (
            <InlineEditTrigger
              onClick={() => startEdit(p.basePrice)}
              label="base price"
              align="right"
            >
              <span className="tabular-nums">€{p.basePrice.toFixed(2)}</span>
            </InlineEditTrigger>
          )}
          {errorBanner}
        </>
      )
    case 'stock': {
      const tone = p.totalStock === 0 ? 'text-rose-600' : p.totalStock <= p.lowStockThreshold ? 'text-amber-600' : 'text-slate-900'
      return (
        <>
          {editing ? (
            <input
              autoFocus
              type="number"
              min="0"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commit('stock')}
              onKeyDown={(e) => { if (e.key === 'Enter') commit('stock'); if (e.key === 'Escape') setEditing(false) }}
              className="w-16 h-7 px-1.5 text-md text-right tabular-nums border border-blue-300 rounded"
            />
          ) : (
            <InlineEditTrigger
              onClick={() => startEdit(p.totalStock)}
              label="total stock"
              align="right"
            >
              <span className={`tabular-nums font-semibold ${tone}`}>{p.totalStock}</span>
            </InlineEditTrigger>
          )}
          {errorBanner}
        </>
      )
    }
    case 'threshold':
      return (
        <>
          {editing ? (
            <input
              autoFocus
              type="number"
              min="0"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commit('threshold')}
              onKeyDown={(e) => { if (e.key === 'Enter') commit('threshold'); if (e.key === 'Escape') setEditing(false) }}
              className="w-16 h-7 px-1.5 text-md text-right tabular-nums border border-blue-300 rounded"
            />
          ) : (
            <InlineEditTrigger
              onClick={() => startEdit(p.lowStockThreshold)}
              label="low-stock threshold"
              align="right"
            >
              <span className="tabular-nums text-slate-500">{p.lowStockThreshold}</span>
            </InlineEditTrigger>
          )}
          {errorBanner}
        </>
      )
    case 'brand':
      // P.7 — brand is now inline-editable (was read-only). Free-text;
      // datalist suggestions deferred — the filter sidebar already
      // shows the existing brand list so operators have visibility
      // when they want to stay consistent.
      return (
        <>
          {editing ? (
            <input
              autoFocus
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commit('brand')}
              onKeyDown={(e) => { if (e.key === 'Enter') commit('brand'); if (e.key === 'Escape') setEditing(false) }}
              className="w-full h-7 px-1.5 text-base border border-blue-300 rounded"
            />
          ) : (
            <InlineEditTrigger
              onClick={() => startEdit(p.brand ?? '')}
              label="brand"
              align="left"
              empty={!p.brand}
            >
              <span className="text-base text-slate-700">
                {p.brand ?? 'Add brand'}
              </span>
            </InlineEditTrigger>
          )}
          {errorBanner}
        </>
      )
    case 'productType':
      // P.7 — productType is now inline-editable (was read-only). The
      // displayed label uses the IT_TERMS glossary lookup; the input
      // edits the raw English/canonical key so saves go to the right
      // value regardless of the displayed translation.
      return (
        <>
          {editing ? (
            <input
              autoFocus
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commit('productType')}
              onKeyDown={(e) => { if (e.key === 'Enter') commit('productType'); if (e.key === 'Escape') setEditing(false) }}
              className="w-full h-7 px-1.5 text-sm border border-blue-300 rounded"
            />
          ) : (
            <InlineEditTrigger
              onClick={() => startEdit(p.productType ?? '')}
              label="product type"
              align="left"
              size="sm"
              empty={!p.productType}
            >
              <span className="text-sm text-slate-700">
                {p.productType ? (IT_TERMS[p.productType] ?? p.productType) : 'Add type'}
              </span>
            </InlineEditTrigger>
          )}
          {errorBanner}
        </>
      )
    case 'fulfillment':
      return (
        <>
          {editing ? (
            <select
              autoFocus
              value={draft}
              onChange={(e) => { setDraft(e.target.value); commit('fulfillment') }}
              onBlur={() => setEditing(false)}
              className="h-6 px-1 text-sm border border-blue-300 rounded"
            >
              <option value="">—</option>
              <option value="FBA">FBA</option>
              <option value="FBM">FBM</option>
            </select>
          ) : (
            <InlineEditTrigger
              onClick={() => startEdit(p.fulfillmentMethod ?? '')}
              label="fulfillment method"
              size="sm"
              hideIcon={!!p.fulfillmentMethod}
              empty={!p.fulfillmentMethod}
              className="w-auto"
            >
              {p.fulfillmentMethod ? (
                <Badge variant={p.fulfillmentMethod === 'FBA' ? 'warning' : 'info'} size="sm">{p.fulfillmentMethod}</Badge>
              ) : <span className="text-sm">Set FBA/FBM</span>}
            </InlineEditTrigger>
          )}
          {errorBanner}
        </>
      )
    case 'coverage': {
      // F8 — surface ALL canonical channels per row, not just the ones
      // already listed. Missing channels render as a gray "+" placeholder
      // that deep-links into the listing wizard with that channel
      // pre-selected (Phase 7 query param). At a glance the user sees
      // both coverage AND gaps; the M/N count tells them where they
      // are without doing the math.
      const ALL_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'] as const
      const covered = p.coverage ?? {}
      const coveredCount = Object.keys(covered).length
      return (
        <div className="flex items-center gap-1 flex-wrap">
          <span
            className="text-xs text-slate-400 mr-0.5 tabular-nums"
            title={`${coveredCount} of ${ALL_CHANNELS.length} channels listed`}
          >
            {coveredCount}/{ALL_CHANNELS.length}
          </span>
          {ALL_CHANNELS.map((ch) => {
            const c = covered[ch]
            if (c) {
              const tone =
                c.error > 0
                  ? 'border-rose-300 bg-rose-50 text-rose-700'
                  : c.live > 0
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                  : c.draft > 0
                  ? 'border-slate-200 bg-slate-50 text-slate-600'
                  : 'border-slate-200 bg-white text-slate-400'
              return (
                <Link
                  key={ch}
                  href={`/listings/${ch.toLowerCase()}?search=${encodeURIComponent(p.sku)}`}
                  title={`${ch}: ${c.live} live, ${c.draft} draft, ${c.error} error / ${c.total} total`}
                  className={`inline-flex items-center gap-1 px-1.5 h-5 text-xs font-mono border rounded ${tone} hover:opacity-80`}
                >
                  {ch.slice(0, 3)}
                  <span className="opacity-60">{c.total}</span>
                </Link>
              )
            }
            // Missing — render an actionable placeholder that takes the
            // user straight to the listing wizard, pre-selecting this
            // channel via Phase 7's connection-status flow.
            return (
              <Link
                key={ch}
                href={`/products/${p.id}/list-wizard?channel=${ch}`}
                title={`Not listed on ${ch} — click to start a listing`}
                className="inline-flex items-center gap-0.5 px-1.5 h-5 text-xs font-mono border border-dashed border-slate-300 bg-white text-slate-400 rounded hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50"
              >
                {ch.slice(0, 3)}
                <span className="text-xs leading-none">+</span>
              </Link>
            )
          })}
        </div>
      )
    }
    case 'tags': {
      // E.17 — inline tag remove + overflow indicator. Each chip
      // shows an X on hover; clicking removes that tag from this
      // product via /api/products/bulk-tag (mode='remove'). When
      // there are more than 3 tags, a +N more pill bridges to the
      // editor for the full list.
      const tags = p.tags ?? []
      const visible = tags.slice(0, 3)
      const overflow = tags.length - visible.length
      const removeTag = async (tagId: string) => {
        try {
          const res = await fetch(
            `${getBackendUrl()}/api/products/bulk-tag`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                productIds: [p.id],
                tagIds: [tagId],
                mode: 'remove',
              }),
            },
          )
          if (!res.ok) throw new Error('Failed')
          emitInvalidation({
            type: 'product.updated',
            meta: { productIds: [p.id], source: 'inline-tag-remove' },
          })
          onChanged()
        } catch {
          /* swallow — refetch will reveal the actual state */
        }
      }
      return (
        <div className="flex items-center gap-1 flex-wrap">
          {visible.map((t) => (
            <span
              key={t.id}
              className="group/tag inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs rounded"
              style={{
                background: t.color ? `${t.color}20` : '#f1f5f9',
                color: t.color ?? '#64748b',
              }}
            >
              {t.name}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  void removeTag(t.id)
                }}
                aria-label={`Remove tag ${t.name}`}
                className="opacity-0 group-hover/tag:opacity-100 inline-flex items-center justify-center w-3 h-3 rounded-full hover:bg-rose-100 hover:text-rose-700 transition-opacity"
              >
                <X size={10} />
              </button>
            </span>
          ))}
          {overflow > 0 && (
            <button
              type="button"
              onClick={() => onTagEdit(p.id)}
              title={tags
                .slice(3)
                .map((t) => t.name)
                .join(', ')}
              className="inline-flex items-center px-1.5 py-0.5 text-xs rounded bg-slate-100 text-slate-600 hover:bg-slate-200"
            >
              +{overflow} more
            </button>
          )}
          <button
            onClick={() => onTagEdit(p.id)}
            aria-label="Edit tags"
            title="Edit tags"
            className="h-4 w-4 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded text-xs"
          >
            +
          </button>
        </div>
      )
    }
    case 'photos': {
      const tone = p.photoCount === 0 ? 'text-rose-600' : p.photoCount < 3 ? 'text-amber-600' : 'text-emerald-600'
      return <span className={`text-base tabular-nums font-semibold ${tone}`}>{p.photoCount}</span>
    }
    case 'variants':
      return <span className="text-base tabular-nums text-slate-600">{p.variantCount}</span>
    case 'completeness': {
      // F.2 — completeness % from 6 dimensions: name, brand, type,
      // photos, channel coverage, tags. Each contributes ~16.7%.
      // Tone breaks at 50/80 for color (rose/amber/emerald) so the
      // grid surfaces "products that need work" at a glance. Tooltip
      // (via title attribute) lists what's missing.
      const checks: Array<[string, boolean]> = [
        ['name', !!(p.name && p.name.trim().length > 0 && p.name !== 'Untitled product')],
        ['brand', !!p.brand],
        ['type', !!p.productType],
        ['photos', p.photoCount > 0],
        ['channels', p.channelCount > 0],
        ['tags', (p.tags?.length ?? 0) > 0],
      ]
      const passed = checks.filter(([, ok]) => ok).length
      const score = Math.round((passed / checks.length) * 100)
      const missing = checks.filter(([, ok]) => !ok).map(([k]) => k)
      const tone =
        score >= 80
          ? 'bg-emerald-500'
          : score >= 50
            ? 'bg-amber-500'
            : 'bg-rose-500'
      const textTone =
        score >= 80
          ? 'text-emerald-700'
          : score >= 50
            ? 'text-amber-700'
            : 'text-rose-700'
      return (
        <div
          className="flex items-center gap-2 w-full"
          title={
            missing.length === 0
              ? 'All quality checks pass'
              : `Missing: ${missing.join(', ')}`
          }
        >
          <span className={`text-sm tabular-nums font-semibold ${textTone}`}>
            {score}%
          </span>
          <div className="flex-1 h-1.5 bg-slate-100 rounded overflow-hidden">
            <div
              className={`h-full ${tone}`}
              style={{ width: `${score}%` }}
            />
          </div>
        </div>
      )
    }
    case 'updated':
      return <span className="text-sm text-slate-500">{new Date(p.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
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
            className="h-6 px-2 text-sm text-slate-600 hover:text-blue-600 hover:bg-blue-50 rounded"
            title="Quick view (Esc closes)"
          >
            View
          </button>
          <Link href={`/products/${p.id}/list-wizard`} className="h-6 px-2 text-sm text-slate-600 hover:text-emerald-600 hover:bg-emerald-50 rounded">List</Link>
        </div>
      )
    default:
      return null
  }
})

function ColumnPickerMenu({ visible, setVisible, onClose }: { visible: string[]; setVisible: (v: string[]) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  // F7 — drag-drop column reorder. Native HTML5 dragstart/dragover/drop
  // (no library). Tracks the drag source key in state; on drop, splices
  // the array. Only togglable columns participate — locked columns
  // (thumb/sku/name/actions) keep their positions in the rendered
  // table via the visible useMemo's missingLeading/missingTrailing
  // logic.
  const [dragKey, setDragKey] = useState<string | null>(null)
  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose])
  const togglable = ALL_COLUMNS.filter((c) => !c.locked && c.label)

  // The picker shows columns in the user's current order (visible[])
  // for togglable rows that ARE visible, then non-visible togglable
  // rows at the end. So drag-reorder only happens within visible.
  const visibleTogglable = visible
    .map((k) => togglable.find((c) => c.key === k))
    .filter((c): c is (typeof togglable)[number] => !!c)
  const hiddenTogglable = togglable.filter((c) => !visible.includes(c.key))

  const onDragStart = (key: string) => (e: React.DragEvent) => {
    setDragKey(key)
    e.dataTransfer.effectAllowed = 'move'
  }
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }
  const onDrop = (targetKey: string) => (e: React.DragEvent) => {
    e.preventDefault()
    if (!dragKey || dragKey === targetKey) {
      setDragKey(null)
      return
    }
    const next = [...visible]
    const fromIdx = next.indexOf(dragKey)
    const toIdx = next.indexOf(targetKey)
    if (fromIdx === -1 || toIdx === -1) {
      setDragKey(null)
      return
    }
    next.splice(fromIdx, 1)
    next.splice(toIdx, 0, dragKey)
    setVisible(next)
    setDragKey(null)
  }

  return (
    <div ref={ref} className="absolute right-0 top-full mt-1 w-64 bg-white border border-slate-200 rounded-md shadow-lg z-20 p-1.5 max-h-[480px] overflow-y-auto">
      <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 px-2 py-1.5 flex items-center justify-between">
        <span>Visible (drag to reorder)</span>
      </div>
      {visibleTogglable.map((c) => (
        <div
          key={c.key}
          draggable
          onDragStart={onDragStart(c.key)}
          onDragOver={onDragOver}
          onDrop={onDrop(c.key)}
          className={`flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 rounded text-base cursor-move ${dragKey === c.key ? 'opacity-40' : ''}`}
        >
          <span className="text-slate-300 font-mono select-none">⠿</span>
          <input
            type="checkbox"
            checked
            onChange={() => setVisible(visible.filter((k) => k !== c.key))}
          />
          <span className="text-slate-700">{c.label}</span>
        </div>
      ))}
      {hiddenTogglable.length > 0 && (
        <>
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 px-2 py-1.5 mt-1">
            Hidden
          </div>
          {hiddenTogglable.map((c) => (
            <label key={c.key} className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 rounded text-base cursor-pointer">
              <span className="text-transparent select-none">⠿</span>
              <input
                type="checkbox"
                checked={false}
                onChange={() => setVisible([...visible, c.key])}
              />
              <span className="text-slate-700">{c.label}</span>
            </label>
          ))}
        </>
      )}
      <div className="border-t border-slate-100 mt-1.5 pt-1.5 px-2 py-1 flex items-center justify-between">
        <button onClick={() => setVisible(DEFAULT_VISIBLE)} className="text-sm text-slate-500 hover:text-slate-900">Reset order</button>
        <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-900">Close</button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Secondary lenses (Hierarchy, Coverage, Pricing, Health, Drafts)
// ────────────────────────────────────────────────────────────────────
// P.1a-e — extracted to ./_lenses/* in dedicated commits.
// Imports at the top of this file route the workspace's lens-switch
// JSX to those files. Only the GridLens body remains inline below.

// ────────────────────────────────────────────────────────────────────
// TagEditor — drawer for product tags
// ────────────────────────────────────────────────────────────────────
function TagEditor({ productId, onClose, onChanged, allTags }: { productId: string; onClose: () => void; onChanged: () => void; allTags: Tag[] }) {
  const { toast } = useToast()
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
      toast.error(err.error ?? 'Failed to create tag')
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30" />
      <aside onClick={(e) => e.stopPropagation()} className="relative h-full w-full max-w-md bg-white shadow-2xl overflow-y-auto">
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white">
          <div className="text-md font-semibold text-slate-900 inline-flex items-center gap-1.5"><TagIcon size={14} /> Tags</div>
          <button onClick={onClose} aria-label="Close" className="h-7 w-7 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center rounded hover:bg-slate-100"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-4">
          <div>
            <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold mb-2">Available tags</div>
            {loading ? <div className="text-base text-slate-500">Loading…</div> : (
              <div className="flex items-center gap-1.5 flex-wrap">
                {allTags.map((t) => {
                  const active = productTags.some((p) => p.id === t.id)
                  return (
                    <button
                      key={t.id}
                      onClick={() => toggle(t)}
                      className={`inline-flex items-center gap-1 px-2 py-1 text-sm border rounded transition-colors ${active ? 'border-slate-900' : 'border-slate-200 hover:border-slate-300'}`}
                      style={active ? { background: t.color ? `${t.color}20` : '#f1f5f9', color: t.color ?? '#64748b' } : undefined}
                    >
                      {t.color && <span className="w-1.5 h-1.5 rounded-full" style={{ background: t.color }} />}
                      {t.name}
                      {active && <CheckCircle2 size={10} />}
                    </button>
                  )
                })}
                {allTags.length === 0 && <span className="text-base text-slate-400">No tags yet — create one below.</span>}
              </div>
            )}
          </div>
          <div className="border-t border-slate-100 pt-4 space-y-2">
            <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold">Create new tag</div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                placeholder="Tag name"
                className="flex-1 h-8 px-2 text-md border border-slate-200 rounded"
              />
              <input
                type="color"
                value={newTagColor}
                onChange={(e) => setNewTagColor(e.target.value)}
                className="h-8 w-10 border border-slate-200 rounded"
              />
              <button onClick={createTag} className="h-8 px-3 text-base bg-slate-900 text-white rounded-md hover:bg-slate-800">Add</button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// P.19 — CSV export of the loaded grid view
// ────────────────────────────────────────────────────────────────────
/**
 * Pure client-side CSV export of the currently-loaded ProductRow[].
 * No new endpoint — dumps the array the grid is rendering, in the
 * filter + sort order the operator sees. Honours pageSize, so:
 *
 *   - At pageSize=100 (default), the operator gets the visible page
 *   - Bumping pageSize to 500 (the cap) captures most catalogs in
 *     one click; Xavia's ~3,200 SKUs needs page-through but each
 *     export still represents exactly what's on screen
 *
 * The column set mirrors the grid + adds a couple of fields that
 * are useful in spreadsheets (createdAt, channelCount). Coverage
 * is flattened to a "channels" string like "AMAZON:2/2,EBAY:0/1"
 * because nested objects don't survive a CSV round-trip. Tags are
 * joined with "|" for the same reason.
 *
 * Mirrors the export pattern in /fulfillment/replenishment so
 * operators see consistent CSV ergonomics across the app.
 */
function exportProductsCsv(products: ProductRow[]): void {
  const header = [
    'SKU',
    'Name',
    'Brand',
    'Type',
    'Status',
    'Price',
    'Stock',
    'Low @',
    'Fulfillment',
    'Photos',
    'Channels listed',
    'Channel coverage',
    'Tags',
    'Variants',
    'Is parent',
    'Parent ID',
    'Updated',
    'Created',
    'ID',
  ]
  const rows: string[][] = [header]
  for (const p of products) {
    const coverageCells = Object.entries(p.coverage ?? {}).map(
      ([ch, c]) => `${ch}:${c.live}/${c.total}`,
    )
    rows.push([
      p.sku,
      p.name,
      p.brand ?? '',
      p.productType ?? '',
      p.status,
      p.basePrice.toFixed(2),
      String(p.totalStock),
      String(p.lowStockThreshold),
      p.fulfillmentMethod ?? '',
      String(p.photoCount),
      String(p.channelCount),
      coverageCells.join(','),
      (p.tags ?? []).map((t) => t.name).join('|'),
      String(p.variantCount),
      p.isParent ? 'true' : '',
      p.parentId ?? '',
      p.updatedAt,
      p.createdAt,
      p.id,
    ])
  }
  const csv = rows
    .map((r) =>
      r
        .map((cell) => {
          const needsQuote = /[",\n]/.test(cell)
          return needsQuote ? `"${cell.replace(/"/g, '""')}"` : cell
        })
        .join(','),
    )
    .join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `products-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

