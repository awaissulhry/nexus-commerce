'use client'

// PRODUCTS REBUILD — universal catalog workspace.
// Five lenses: Grid · Hierarchy · Coverage · Health · Drafts.
// URL-driven state, virtualized table, inline quick-edit, faceted filters,
// saved views, tag + bundle editors, bulk actions across channels.

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  Boxes, AlertTriangle, LayoutGrid, Sparkles, RefreshCw,
  Settings2, X,
  Package, Plus, FolderTree, Network,
  Upload,
  DollarSign, Download,
  AlignJustify, Menu as MenuIcon, Equal,
  Trash2,
  GitBranch,
  Globe,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
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
} from '@/lib/products/theme'
// P.1a — lens components extracted to /_lenses/* in this commit and
// follow-ups. HierarchyLens is the first; CoverageLens, PricingLens,
// HealthLens, DraftsLens follow in the same sweep.
import { HierarchyLens } from './_lenses/HierarchyLens'
import { HealthLens } from './_lenses/HealthLens'
import { DraftsLens } from './_lenses/DraftsLens'
import { CoverageLens } from './_lenses/CoverageLens'
import { PricingLens } from './_lenses/PricingLens'
import { WorkflowLens } from './_lenses/WorkflowLens'
import { ReadinessLens } from './_lenses/ReadinessLens'
import { TranslationsLens } from './_lenses/TranslationsLens'
import { BulkActionBar } from './_components/BulkActionBar'
import { FilterBar } from './_components/FilterBar'
import { SavedViewsButton } from './_components/SavedViewsButton'
import { Pagination } from './_components/Pagination'
import { MobileProductList } from './_components/MobileProductList'
import { ColumnPickerMenu } from './_components/ColumnPickerMenu'
import { TagEditor } from './_components/TagEditor'
import { VirtualizedGrid } from './_components/GridView'
import { HygieneStrip } from './_components/HygieneStrip'
import { QuickFilters } from './_components/QuickFilters'

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
const BulkImageUploadModal = dynamic(
  () => import('./_modals/BulkImageUploadModal'),
  { ssr: false },
)
// AiBulkGenerateModal + CompareProductsModal moved into
// _components/BulkActionBar.tsx (P.1g) — those lazy imports live
// there now, only loaded when an operator opens AI bulk / compare.
import { useToast } from '@/components/ui/Toast'

// ── Types ───────────────────────────────────────────────────────────
type Lens = 'grid' | 'hierarchy' | 'coverage' | 'health' | 'drafts' | 'pricing' | 'workflow' | 'readiness' | 'translations'

// ProductRow + Tag types moved to ./_types.ts (P.1f) so GridView and
// the workspace share a canonical shape.
import type { ProductRow, Tag } from './_types'

type Stats = { total: number; active: number; draft: number; inStock: number; outOfStock: number }
// Tag now imported from ./_types alongside ProductRow.
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
  // W2.12 — PIM family facet. First row (value='null') is the "no
  // family attached" backlog bucket; rest are real family ids.
  families?: Array<{
    value: string
    label: string
    code: string | null
    count: number
  }>
  // W3.9 — Workflow stage facet. Same shape as families.
  workflowStages?: Array<{
    value: string
    label: string
    workflowLabel: string | null
    count: number
  }>
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

// ALL_COLUMNS + DEFAULT_VISIBLE moved to ./_columns.ts (P.1l) so
// ColumnPickerMenu can share the same source of truth.
import { ALL_COLUMNS, DEFAULT_VISIBLE } from './_columns'

// F7 — density modes for the grid. Affects row padding + cell font
// size. Compact gets a power-user up to ~50 rows on a laptop screen;
// P.4 — tokens (Density, DENSITY_CELL_CLASS, DENSITY_ROW_HEIGHT,
// STATUS_VARIANT, CHANNEL_TONE) extracted to lib/products/theme.ts
// so the grid, lenses, drawer, and modal subcomponents reach for the
// same source of truth. Keep imports near where they're used here so
// removing this re-export doesn't ripple through unrelated changes.

// IT_TERMS glossary moved to ./_components/GridView.tsx (P.1f) where
// the productType cell consumes it. The workspace no longer
// references it directly.

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
  // W5.5 — multi-column sort. URL param `sorts` carries comma-
  // separated `field:dir` pairs. When non-empty, takes priority
  // over legacy `sort=` (W5.4 backend handles the override).
  const sortStack = searchParams.get('sorts')?.split(',').filter(Boolean) ?? []
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
  // W2.12 — PIM family filter. URL param `families` carries comma-separated
  // family ids; the literal 'null' represents "no family attached".
  const familyFilters = searchParams.get('families')?.split(',').filter(Boolean) ?? []
  // W3.9 — Workflow stage filter. Same shape; param `workflowStages`.
  const workflowStageFilters = searchParams.get('workflowStages')?.split(',').filter(Boolean) ?? []
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
  // F.1 — recycle-bin lens. ?deleted=true flips the workspace into
  // soft-deleted-rows-only mode: the grid filters to deletedAt NOT
  // NULL, the bulk-action bar swaps Activate/Draft/Inactive/Tag/
  // Publish/AI fill for a single Restore action, and the page
  // header surfaces a back-to-active toggle.
  const showDeleted = searchParams.get('deleted') === 'true'

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
    // U.30 — was `if (lens !== 'grid') return null` which meant
    // CoverageLens + PricingLens got empty `products` on direct
    // navigation: workspace skipped the fetch and both lenses
    // rendered "No products to map / price" against a 279-row
    // catalog. Coverage + Pricing both consume `products` from the
    // workspace; they need the data fetched whichever lens lands
    // first. (Hierarchy / Health / Drafts have their own fetches
    // and don't read `products`.)
    if (lens !== 'grid' && lens !== 'coverage' && lens !== 'pricing') {
      return null
    }
    const qs = new URLSearchParams()
    qs.set('page', String(page))
    qs.set('limit', String(pageSize))
    if (search) qs.set('search', search)
    if (statusFilters.length) qs.set('status', statusFilters.join(','))
    if (channelFilters.length) qs.set('channels', channelFilters.join(','))
    if (marketplaceFilters.length) qs.set('marketplaces', marketplaceFilters.join(','))
    if (productTypeFilters.length) qs.set('productTypes', productTypeFilters.join(','))
    if (brandFilters.length) qs.set('brands', brandFilters.join(','))
    if (familyFilters.length) qs.set('families', familyFilters.join(','))
    if (workflowStageFilters.length) qs.set('workflowStages', workflowStageFilters.join(','))
    if (tagFilters.length) qs.set('tags', tagFilters.join(','))
    if (fulfillmentFilters.length) qs.set('fulfillment', fulfillmentFilters.join(','))
    if (missingChannelFilters.length) qs.set('missingChannels', missingChannelFilters.join(','))
    if (stockLevel !== 'all') qs.set('stockLevel', stockLevel)
    if (hasPhotos) qs.set('hasPhotos', hasPhotos)
    if (hasDescription) qs.set('hasDescription', hasDescription)
    if (hasBrand) qs.set('hasBrand', hasBrand)
    if (hasGtin) qs.set('hasGtin', hasGtin)
    if (showDeleted) qs.set('deleted', 'true')
    qs.set('sort', sortBy)
    if (sortStack.length > 0) qs.set('sorts', sortStack.join(','))
    qs.set('includeCoverage', 'true')
    qs.set('includeTags', 'true')
    return `/api/products?${qs.toString()}`
  }, [lens, page, pageSize, search, statusFilters, channelFilters, marketplaceFilters, productTypeFilters, brandFilters, familyFilters, workflowStageFilters, tagFilters, fulfillmentFilters, missingChannelFilters, stockLevel, hasPhotos, hasDescription, hasBrand, hasGtin, showDeleted, sortBy, sortStack.join(',')])

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

  // W5.1 — Family-completeness bulk fetch. Only triggered when the
  // familyCompleteness column is visible to keep grid loads cheap.
  // Sequential per-product on the server (~30ms each); 50 ids ≈ 1.5s
  // worst case, but rendered async with skeleton placeholders so the
  // grid doesn't block on it.
  useEffect(() => {
    if (!visibleColumns.includes('familyCompleteness')) return
    if (products.length === 0) return
    let cancelled = false
    const ids = products.map((p) => p.id)
    fetch(`${getBackendUrl()}/api/products/family-completeness/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIds: ids }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { results?: Record<string, unknown> }) => {
        if (cancelled) return
        const map = data.results ?? {}
        setProducts((prev) =>
          prev.map((p) => {
            const r = map[p.id] as
              | { score: number; filled: number; totalRequired: number; familyId: string | null }
              | { error: string }
              | undefined
            if (!r || 'error' in r) return p
            return {
              ...p,
              familyCompleteness: {
                score: r.score,
                filled: r.filled,
                totalRequired: r.totalRequired,
                familyId: r.familyId,
              },
            }
          }),
        )
      })
      .catch(() => {
        // Silent — column shows skeletons forever rather than
        // surfacing a banner. The legacy 'completeness' column keeps
        // working regardless.
      })
    return () => {
      cancelled = true
    }
    // Re-run when the visible product set changes — pagination,
    // filter, or refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products.map((p) => p.id).join(','), visibleColumns.includes('familyCompleteness')])
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

  // U.33 — these were inline arrows in JSX (recreated every render),
  // which busted child memo on GridLens + ProductDrawer. The
  // onClearFilters payload is a static object literal so we memoize
  // once; the drawer onClose just maps to one updateUrl call.
  const onClearFilters = useCallback(() => {
    updateUrl({
      status: '',
      channels: '',
      marketplaces: '',
      productTypes: '',
      brands: '',
      families: '',
      workflowStages: '',
      tags: '',
      fulfillment: '',
      missingChannels: '',
      stockLevel: undefined,
      hasPhotos: undefined,
      hasDescription: undefined,
      hasBrand: undefined,
      hasGtin: undefined,
      page: undefined,
    })
  }, [updateUrl])
  const onCloseDrawer = useCallback(
    () => updateUrl({ drawer: undefined }),
    [updateUrl],
  )

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
  useEffect(() => { setSelected(new Set()) }, [page, search, statusFilters.join(','), channelFilters.join(','), marketplaceFilters.join(','), productTypeFilters.join(','), brandFilters.join(','), familyFilters.join(','), workflowStageFilters.join(','), tagFilters.join(','), fulfillmentFilters.join(','), missingChannelFilters.join(','), stockLevel, hasPhotos, hasDescription, hasBrand, hasGtin])

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
    productTypeFilters.length + brandFilters.length + familyFilters.length + workflowStageFilters.length + tagFilters.length +
    fulfillmentFilters.length + missingChannelFilters.length +
    (stockLevel !== 'all' ? 1 : 0) + (hasPhotos ? 1 : 0) +
    (hasDescription ? 1 : 0) + (hasBrand ? 1 : 0) + (hasGtin ? 1 : 0)

  return (
    // P.1f — SearchContext + RiskFlaggedContext moved into VirtualizedGrid
    // (the only consumer of these contexts). The workspace now passes
    // search + riskFlaggedSkus down as props on <GridLens>, which
    // forwards them to <VirtualizedGrid>.
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
            {/* F.1 — recycle-bin toggle. Subdued styling so it doesn't
                steal attention from the primary actions; flips active
                when the operator is inside the bin so it's obvious how
                to get back. Uses the same updateUrl path as every other
                URL-state change so back/forward survives the toggle. */}
            <Button
              variant="secondary"
              onClick={() =>
                updateUrl({
                  deleted: showDeleted ? undefined : 'true',
                  page: undefined,
                })
              }
              title={
                showDeleted
                  ? 'Back to active products'
                  : 'View soft-deleted products'
              }
              className={
                showDeleted
                  ? 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800 dark:hover:bg-rose-900/40'
                  : ''
              }
              icon={<Trash2 size={12} />}
            >
              {/* U.30 — was empty when !showDeleted, leaving the button
                  with only an icon and no accessible name. Always
                  render a label; on desktop, hide it via sr-only when
                  inactive so the icon-only chrome stays compact but
                  screen readers still announce a button. */}
              {showDeleted ? (
                'Recycle bin'
              ) : (
                <span className="sr-only">Open recycle bin</span>
              )}
            </Button>
            <Link
              href="/products/new"
              className="h-8 px-3 text-md font-medium bg-slate-900 text-white border border-slate-900 rounded-md hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100 dark:hover:bg-slate-200 inline-flex items-center justify-center gap-1.5 transition-colors"
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

      {/* W5.5 — multi-column sort chip stack. Renders above lens
          switcher when active; hidden when sortStack is empty. */}
      {sortStack.length > 0 && (
        <SortStackBar
          stack={sortStack}
          onChange={(next) =>
            updateUrl({
              sorts: next.length > 0 ? next.join(',') : undefined,
              page: undefined,
            })
          }
        />
      )}

      {/* Lens switcher + saved views menu */}
      <div className="flex items-center gap-2 flex-wrap">
        <LensTabs current={lens} onChange={(next) => updateUrl({ lens: next === 'grid' ? undefined : next, page: undefined })} />
        {/* W5.5 — Add-sort entry-point in the lens row. Always
            visible so the operator can layer sorts even from the
            grid lens. Opens a small inline picker. */}
        <AddSortButton
          activeStack={sortStack}
          onAdd={(field, dir) =>
            updateUrl({
              sorts: [...sortStack, `${field}:${dir}`].join(','),
              page: undefined,
            })
          }
        />

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
              if (familyFilters.length) filters.families = familyFilters
              if (workflowStageFilters.length) filters.workflowStages = workflowStageFilters
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

      {/* U.27 — catalog hygiene strip. Hidden in the recycle-bin
          scope (deleted rows aren't actionable). */}
      {lens === 'grid' && !showDeleted && (
        <HygieneStrip
          hygiene={facets?.hygiene}
          hasPhotos={hasPhotos}
          hasDescription={hasDescription}
          hasBrand={hasBrand}
          hasGtin={hasGtin}
          updateUrl={updateUrl}
        />
      )}

      {/* U.36 — quick-filters row. Surfaces Status / Stock /
          Marketplace / Channels permanently so daily-driver
          filtering is zero-click. The accordion below stays for
          advanced filters (Product type / Brand / Tags / Fulfillment
          / Missing on…). Hidden in recycle-bin and on non-grid
          lenses. */}
      {lens === 'grid' && !showDeleted && (
        <QuickFilters
          statusFilters={statusFilters}
          stockLevel={stockLevel}
          marketplaceFilters={marketplaceFilters}
          channelFilters={channelFilters}
          updateUrl={updateUrl}
        />
      )}

      {/* Filter bar */}
      <FilterBar
        searchInput={searchInput}
        setSearchInput={setSearchInput}
        statusFilters={statusFilters}
        channelFilters={channelFilters}
        marketplaceFilters={marketplaceFilters}
        productTypeFilters={productTypeFilters}
        brandFilters={brandFilters}
        familyFilters={familyFilters}
        workflowStageFilters={workflowStageFilters}
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

      {/* U.22 — bulk action toolbar. Permanent + sticky-top, rendered
          whenever the grid lens is active (regardless of selection
          count). When 0 rows are selected the bar shows a muted "0
          selected — tick rows to bulk-edit" hint with disabled
          buttons; selecting one or more rows activates the actions
          inline. Replaces E.4's bottom-rising bar so the affordance
          is always visible at a stable location. */}
      {lens === 'grid' && (
        <BulkActionBar
          selectedIds={Array.from(selected)}
          allTags={tags}
          onClear={() => setSelected(new Set())}
          onComplete={() => { setSelected(new Set()); fetchProducts(); fetchTags() }}
          productLookup={products}
          showDeleted={showDeleted}
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
          onClearFilters={onClearFilters}
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
          searchTerm={search}
          riskFlaggedSkus={riskFlaggedSkus}
        />
      )}

      {lens === 'hierarchy' && <HierarchyLens search={search} />}
      {lens === 'coverage' && <CoverageLens products={products} loading={loading} />}
      {lens === 'pricing' && <PricingLens products={products} loading={loading} />}
      {lens === 'health' && <HealthLens />}
      {lens === 'drafts' && <DraftsLens />}
      {lens === 'workflow' && <WorkflowLens />}
      {lens === 'readiness' && <ReadinessLens products={products} loading={loading} />}
      {lens === 'translations' && <TranslationsLens products={products} loading={loading} />}

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
        onClose={onCloseDrawer}
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
    { key: 'pricing', label: 'Pricing', icon: DollarSign },
    { key: 'health', label: 'Health', icon: AlertTriangle },
    // DR-C.1 — was 'Drafts', renamed to disambiguate from
    // /products/drafts (the wizard-resume surface). This lens
    // shows per-channel publish readiness: draft listings ready
    // to push + uncovered products on the selected channel. The
    // URL key stays `lens=drafts` for bookmark stability.
    { key: 'drafts', label: 'Channel coverage', icon: Sparkles },
    // W3.7 — Wave 3 workflow lens. Pipeline view: per-stage product
    // count + sample products + SLA hints. Empty when no workflows
    // exist (operator gets an actionable EmptyState pointing at
    // /settings/pim/workflows).
    { key: 'workflow', label: 'Workflow', icon: GitBranch },
    // W3.11 — Salsify channel-readiness matrix. Per-product per-
    // channel score + missing-fields tooltip. Reuses the FilterBar
    // products[] so filters compose cleanly.
    { key: 'readiness', label: 'Readiness', icon: AlertTriangle },
    // W5.6 — Akeneo per-locale completeness. Products × supported
    // locales matrix; cell = N/4 fields filled in that language.
    { key: 'translations', label: 'Translations', icon: Globe },
  ]
  return (
    <div className="inline-flex items-center bg-slate-100 dark:bg-slate-800 rounded-md p-0.5">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`h-7 px-3 text-base font-medium inline-flex items-center gap-1.5 rounded transition-colors ${current === t.key ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'}`}
        >
          <t.icon size={12} />
          {t.label}
        </button>
      ))}
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
    sortBy, onSort, selected, setSelected, onRowToggle, focusedRowId, onPage, onPageSize, onTagEdit, onChanged,
    // Expand-on-chevron — see ProductsWorkspace for state ownership.
    expandedParents,
    childrenByParent,
    loadingChildren,
    onToggleExpand,
    // F7 — density driven from workspace state, persisted to localStorage.
    density,
    onDensityChange,
    // P.1f — passed-through context values now that GridView owns the
    // SearchContext + RiskFlaggedContext providers internally.
    searchTerm,
    riskFlaggedSkus,
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
    searchTerm: string
    riskFlaggedSkus: Set<string>
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
              className="flex items-center gap-3 px-3 py-3 border-b border-slate-100 dark:border-slate-800 last:border-b-0"
              aria-hidden="true"
            >
              <div className="w-4 h-4 rounded bg-slate-200 dark:bg-slate-800 animate-pulse flex-shrink-0" />
              <div className="w-10 h-10 rounded bg-slate-200 dark:bg-slate-800 animate-pulse flex-shrink-0" />
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="h-3.5 bg-slate-200 dark:bg-slate-800 rounded animate-pulse w-1/2" />
                <div className="h-3 bg-slate-100 dark:bg-slate-800 rounded animate-pulse w-3/4" />
              </div>
              <div className="w-14 h-4 bg-slate-200 dark:bg-slate-800 rounded animate-pulse flex-shrink-0" />
              <div className="w-10 h-4 bg-slate-200 dark:bg-slate-800 rounded animate-pulse flex-shrink-0" />
              <div className="w-20 h-4 bg-slate-200 dark:bg-slate-800 rounded animate-pulse flex-shrink-0 hidden md:block" />
            </div>
          ))}
        </div>
      </Card>
    )
  }
  if (error) {
    return <Card><div role="alert" aria-live="assertive" className="text-md text-rose-600 dark:text-rose-400 py-8 text-center">Failed to load: {error}</div></Card>
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
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 mb-1">
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
                className="h-8 px-3 text-base bg-slate-900 text-white rounded-md hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200 inline-flex items-center gap-1.5"
              >
                <X size={12} /> Clear all filters
              </button>
            )}
            <Link
              href="/products/new"
              className={`h-8 px-3 text-base inline-flex items-center gap-1.5 rounded ${filtered ? 'border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800' : 'bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200'}`}
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
      {/* U.22 — config row (count, page-size, density, columns picker)
          is no longer sticky; the BulkActionBar above owns the
          always-visible sticky slot. Operators set density / columns /
          page-size once and forget; pulling the action bar to the top
          gives the high-frequency surface the better real estate. */}
      <div className="-mx-2 px-2 py-1.5 flex items-center gap-2 justify-between border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-500 dark:text-slate-400">
            <span className="font-semibold text-slate-700 dark:text-slate-300 tabular-nums">{total}</span> products · page {page} of {totalPages}
          </span>
          <select
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value))}
            className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
          >
            {[50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}/page</option>)}
          </select>
        </div>
        {/* F7 — density picker. Three-segment toggle adjacent to the
            columns picker. Persisted per-user via localStorage. */}
        <div className="inline-flex items-center border border-slate-200 dark:border-slate-700 rounded overflow-hidden h-7 text-sm">
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
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'
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

      {/* U.25 — was `hidden md:block` which forced tablet portrait
          (768-1023px) to render the 9-column virtualized grid →
          horizontal overflow past the viewport. Bumped to `lg:` so
          tablets get the card list (better one-handed flow + no
          h-scroll); the desktop grid kicks in at 1024px+ where the
          full column set actually fits. */}
      <div className="hidden lg:block">
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
          searchTerm={searchTerm}
          riskFlaggedSkus={riskFlaggedSkus}
        />
      </div>
      {/* Mobile + tablet card list — lg:hidden. Shows the same product
          set but as tap-friendly cards (U.25 — extended to tablet so
          the 9-column virtualized grid doesn't h-overflow at 768-1023px).
          Selection works via the corner checkbox; the daily-driver
          mobile flow is browse + open-drawer. */}
      <div className="lg:hidden">
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

// ────────────────────────────────────────────────────────────────────
// W5.5 — Multi-column sort UI
// ────────────────────────────────────────────────────────────────────

const SORT_FIELD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'sku', label: 'SKU' },
  { value: 'name', label: 'Name' },
  { value: 'basePrice', label: 'Price' },
  { value: 'totalStock', label: 'Stock' },
  { value: 'status', label: 'Status' },
  { value: 'brand', label: 'Brand' },
  { value: 'productType', label: 'Type' },
  { value: 'photos', label: 'Photo count' },
  { value: 'channels', label: 'Channel count' },
  { value: 'variants', label: 'Variant count' },
  { value: 'updated', label: 'Updated' },
  { value: 'created', label: 'Created' },
]

const SORT_FIELD_LABELS: Record<string, string> = Object.fromEntries(
  SORT_FIELD_OPTIONS.map((o) => [o.value, o.label]),
)

function SortStackBar({
  stack,
  onChange,
}: {
  stack: string[]
  onChange: (next: string[]) => void
}) {
  const removeAt = (idx: number) =>
    onChange(stack.filter((_, i) => i !== idx))
  const flipDir = (idx: number) =>
    onChange(
      stack.map((p, i) => {
        if (i !== idx) return p
        const [field, dir] = p.split(':')
        return `${field}:${dir === 'desc' ? 'asc' : 'desc'}`
      }),
    )
  return (
    <div className="flex items-center gap-1.5 flex-wrap text-sm">
      <span className="text-slate-500 dark:text-slate-400 uppercase tracking-wider font-semibold text-xs">
        Sorting by
      </span>
      {stack.map((pair, idx) => {
        const [field, dir] = pair.split(':')
        const label = SORT_FIELD_LABELS[field] ?? field
        return (
          <span
            key={`${pair}-${idx}`}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 rounded text-sm border border-blue-200 dark:border-blue-800"
          >
            <button
              type="button"
              onClick={() => flipDir(idx)}
              className="inline-flex items-center gap-0.5 hover:underline"
              title="Toggle ascending / descending"
            >
              {idx > 0 && (
                <span className="text-blue-500 dark:text-blue-400 text-xs mr-0.5">
                  then
                </span>
              )}
              <span>{label}</span>
              <span className="text-xs">{dir === 'desc' ? '↓' : '↑'}</span>
            </button>
            <button
              type="button"
              onClick={() => removeAt(idx)}
              aria-label={`Remove ${label} sort`}
              className="ml-0.5 text-blue-500 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-100 inline-flex items-center justify-center w-3.5 h-3.5"
            >
              ×
            </button>
          </span>
        )
      })}
      <button
        type="button"
        onClick={() => onChange([])}
        className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:underline ml-1"
      >
        clear
      </button>
    </div>
  )
}

function AddSortButton({
  activeStack,
  onAdd,
}: {
  activeStack: string[]
  onAdd: (field: string, dir: 'asc' | 'desc') => void
}) {
  const [open, setOpen] = useState(false)
  const usedFields = new Set(activeStack.map((p) => p.split(':')[0]))
  const available = SORT_FIELD_OPTIONS.filter((o) => !usedFields.has(o.value))

  if (available.length === 0) return null
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        title="Add a sort dimension"
        className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-800 rounded text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
      >
        + Sort
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute right-0 top-full mt-1 z-40 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md shadow-lg py-1 min-w-[200px] text-sm">
            <div className="px-3 py-1 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              Add sort by
            </div>
            {available.map((opt) => (
              <div
                key={opt.value}
                className="flex items-center justify-between px-2 py-0.5 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <span className="text-slate-700 dark:text-slate-300 px-1">
                  {opt.label}
                </span>
                <span className="inline-flex">
                  <button
                    type="button"
                    onClick={() => {
                      onAdd(opt.value, 'asc')
                      setOpen(false)
                    }}
                    className="px-1.5 py-0.5 text-xs hover:bg-slate-200 dark:hover:bg-slate-700 rounded"
                    title="Ascending"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onAdd(opt.value, 'desc')
                      setOpen(false)
                    }}
                    className="px-1.5 py-0.5 text-xs hover:bg-slate-200 dark:hover:bg-slate-700 rounded ml-0.5"
                    title="Descending"
                  >
                    ↓
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

