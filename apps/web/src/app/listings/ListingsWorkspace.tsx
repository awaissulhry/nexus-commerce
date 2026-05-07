'use client'

// SYNDICATION — universal /listings workspace.
// Lens-driven (Grid · Health · Matrix · Drafts), URL state, channel/market
// presets via props, bulk actions, column picker, detail drawer.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  Boxes, AlertTriangle, LayoutGrid, Sparkles, Search, RefreshCw,
  ExternalLink, Filter, Settings2, X, ChevronDown,
  Eye, EyeOff, CheckCircle2, Tag, Link2,
  ArrowUpRight, Layers, Package, MoreHorizontal, Plus, Pause, Play,
  TrendingUp, TrendingDown, Edit3,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Skeleton } from '@/components/ui/Skeleton'
import { Tooltip } from '@/components/ui/Tooltip'
import { Tabs } from '@/components/ui/Tabs'
import { IconButton } from '@/components/ui/IconButton'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { InlineEditTrigger } from '@/components/ui/InlineEditTrigger'
import { COUNTRY_NAMES } from '@/lib/country-names'
import { getBackendUrl } from '@/lib/backend-url'
import { usePolledList } from '@/lib/sync/use-polled-list'
import {
  emitInvalidation,
  useInvalidationChannel,
} from '@/lib/sync/invalidation-channel'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'

// ── Types ───────────────────────────────────────────────────────────
type Lens = 'grid' | 'health' | 'matrix' | 'drafts'

type Listing = {
  id: string
  productId: string
  channel: string
  marketplace: string
  listingStatus: string
  syncStatus: string | null
  lastSyncStatus: string | null
  lastSyncError: string | null
  lastSyncedAt: string | null
  syncRetryCount: number
  price: number | null
  salePrice: number | null
  masterPrice: number | null
  quantity: number | null
  stockBuffer: number
  masterQuantity: number | null
  pricingRule: string | null
  priceAdjustmentPercent: number | null
  isPublished: boolean
  followMasterTitle: boolean
  followMasterPrice: boolean
  followMasterQuantity: boolean
  title: string | null
  externalListingId: string | null
  externalParentId: string | null
  listingUrl: string | null
  variationTheme: string | null
  validationStatus: string | null
  validationErrors: string[]
  version: number
  updatedAt: string
  currency: string | null
  language: string | null
  marketplaceName: string | null
  product: {
    id: string
    sku: string
    name: string
    amazonAsin: string | null
    basePrice: number | null
    totalStock: number
    isParent: boolean
    parentId: string | null
    thumbnailUrl: string | null
  }
}

type Marketplace = {
  channel: string
  code: string
  name: string
  currency: string
  language: string
  isActive: boolean
}

type Facets = {
  total: number
  errorCount: number
  channels: Array<{ value: string; count: number }>
  marketplaces: Array<{ channel: string; marketplace: string; count: number }>
  statuses: Array<{ value: string; count: number }>
  syncStatuses: Array<{ value: string; count: number }>
}

interface Props {
  /** When set, lens is locked to this channel (per-channel page). */
  lockChannel?: string
  /** When set, lens is locked to this marketplace code. */
  lockMarketplace?: string
  /** Page title override. */
  titleOverride?: string
  /** Breadcrumbs override. */
  breadcrumbs?: Array<{ label: string; href?: string }>
}

const ALL_COLUMNS = [
  { key: 'thumb', label: '', width: 40 },
  { key: 'product', label: 'Product', width: 280 },
  { key: 'channel', label: 'Channel', width: 100 },
  { key: 'marketplace', label: 'Market', width: 80 },
  { key: 'status', label: 'Status', width: 110 },
  { key: 'syncStatus', label: 'Sync', width: 90 },
  { key: 'price', label: 'Price', width: 110 },
  { key: 'pricingRule', label: 'Rule', width: 110 },
  { key: 'masterDelta', label: 'vs Master', width: 90 },
  { key: 'quantity', label: 'Stock', width: 80 },
  { key: 'follow', label: 'Follow', width: 80 },
  { key: 'externalId', label: 'External ID', width: 140 },
  { key: 'lastSync', label: 'Last Sync', width: 110 },
  { key: 'actions', label: '', width: 140 },
] as const

const DEFAULT_VISIBLE = ['thumb', 'product', 'channel', 'marketplace', 'status', 'syncStatus', 'price', 'quantity', 'lastSync', 'actions']

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'default' | 'info'> = {
  ACTIVE: 'success',
  PUBLISHED: 'success',
  IN_SYNC: 'success',
  DRAFT: 'default',
  PENDING: 'warning',
  PENDING_REVIEW: 'warning',
  SYNCING: 'info',
  IDLE: 'default',
  SUPPRESSED: 'danger',
  ENDED: 'default',
  ERROR: 'danger',
  FAILED: 'danger',
  INACTIVE: 'default',
  SUCCESS: 'success',
}

const CHANNEL_TONE: Record<string, string> = {
  AMAZON: 'bg-orange-50 text-orange-700 border-orange-200',
  EBAY: 'bg-blue-50 text-blue-700 border-blue-200',
  SHOPIFY: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  WOOCOMMERCE: 'bg-violet-50 text-violet-700 border-violet-200',
  ETSY: 'bg-rose-50 text-rose-700 border-rose-200',
}

// ── Component ───────────────────────────────────────────────────────
export default function ListingsWorkspace({ lockChannel, lockMarketplace, titleOverride, breadcrumbs }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const pathname = usePathname()

  // URL-driven state: lens, page, search, filters, sort
  const lens = (searchParams.get('lens') as Lens) || 'grid'
  const page = parseInt(searchParams.get('page') ?? '1', 10) || 1
  const search = searchParams.get('search') ?? ''
  const sortBy = searchParams.get('sortBy') ?? 'updatedAt'
  const sortDir = (searchParams.get('sortDir') as 'asc' | 'desc') ?? 'desc'

  const channelFilters = useMemo(() => {
    if (lockChannel) return [lockChannel]
    const v = searchParams.get('channel')
    return v ? v.split(',') : []
  }, [searchParams, lockChannel])

  const marketplaceFilters = useMemo(() => {
    if (lockMarketplace) return [lockMarketplace]
    const v = searchParams.get('marketplace')
    return v ? v.split(',') : []
  }, [searchParams, lockMarketplace])

  const statusFilters = useMemo(() => {
    const v = searchParams.get('listingStatus')
    return v ? v.split(',') : []
  }, [searchParams])

  const syncStatusFilters = useMemo(() => {
    const v = searchParams.get('syncStatus')
    return v ? v.split(',') : []
  }, [searchParams])

  const hasError = searchParams.get('hasError') === 'true'
  const lowStock = searchParams.get('lowStock') === 'true'
  const publishedOnly = searchParams.get('published') === 'true'

  // Local UI state
  const [searchInput, setSearchInput] = useState(search)
  const [visibleColumns, setVisibleColumns] = useState<string[]>(() => {
    if (typeof window === 'undefined') return DEFAULT_VISIBLE
    try {
      const saved = window.localStorage.getItem('listings.visibleColumns')
      return saved ? JSON.parse(saved) : DEFAULT_VISIBLE
    } catch { return DEFAULT_VISIBLE }
  })
  const [columnPickerOpen, setColumnPickerOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drawerListingId, setDrawerListingId] = useState<string | null>(null)

  // Persist column choices
  useEffect(() => {
    try {
      window.localStorage.setItem('listings.visibleColumns', JSON.stringify(visibleColumns))
    } catch {}
  }, [visibleColumns])

  // Debounce search → URL
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== search) updateUrl({ search: searchInput || undefined, page: undefined })
    }, 250)
    return () => clearTimeout(t)
  }, [searchInput])

  // ── URL helpers ────────────────────────────────────────────────────
  const updateUrl = useCallback((patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }, [searchParams, pathname, router])

  // ── Data fetching ──────────────────────────────────────────────────
  // Phase 10 — Grid lens uses usePolledList. The hook owns the fetch
  // + 30s interval + ETag round-trip + visibility refresh +
  // invalidation listening, so we only build the URL here. Other
  // lenses (Health, Matrix, Drafts) keep their bespoke fetches —
  // they're one-shot views without aggressive polling needs.
  const gridUrl = useMemo(() => {
    if (lens !== 'grid') return null
    const qs = new URLSearchParams()
    qs.set('page', String(page))
    qs.set('pageSize', '50')
    qs.set('sortBy', sortBy)
    qs.set('sortDir', sortDir)
    if (search) qs.set('search', search)
    // Repeated-key URL params per Phase 10a canonical form. The
    // /api/listings handler accepts both repeated and CSV via
    // csvParam(); switching to repeated here matches the contract
    // every other Phase 10 page now follows.
    for (const c of channelFilters) qs.append('channel', c)
    for (const m of marketplaceFilters) qs.append('marketplace', m)
    for (const s of statusFilters) qs.append('listingStatus', s)
    for (const s of syncStatusFilters) qs.append('syncStatus', s)
    if (hasError) qs.set('hasError', 'true')
    if (lowStock) qs.set('lowStock', 'true')
    if (publishedOnly) qs.set('published', 'true')
    return `/api/listings?${qs.toString()}`
  }, [lens, page, search, sortBy, sortDir, channelFilters, marketplaceFilters, statusFilters, syncStatusFilters, hasError, lowStock, publishedOnly])

  const {
    data: gridData,
    loading: gridLoading,
    error: gridError,
    lastFetchedAt: gridFetchedAt,
    refetch: refetchGrid,
  } = usePolledList<{ listings: Listing[]; total: number; totalPages: number }>({
    url: gridUrl,
    intervalMs: 30_000,
    invalidationTypes: [
      'product.updated',
      'product.deleted',
      'listing.updated',
      'listing.created',
      'listing.deleted',
      'wizard.submitted',
      'bulk-job.completed',
    ],
  })
  const grid = useMemo(() => ({
    listings: gridData?.listings ?? [],
    total: gridData?.total ?? 0,
    totalPages: gridData?.totalPages ?? 0,
    loading: gridLoading,
    error: gridError,
  }), [gridData, gridLoading, gridError])
  // Backwards-compat alias so the rest of the file (refresh button +
  // bulk action complete) keeps calling `fetchGrid`.
  const fetchGrid = refetchGrid

  const [facets, setFacets] = useState<Facets | null>(null)
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([])

  // S.0.5 / M-1 — facets URL carries the current filters. With the
  // backend now applying them as a shared `where`, this gives chips
  // contextual counts (e.g. once you filter to AMAZON, the Status chip
  // shows "ACTIVE: 5 · DRAFT: 3" within Amazon, not the whole catalog).
  // The URL changes whenever any filter changes, which re-fires
  // fetchFacets via the effect below.
  const facetsUrl = useMemo(() => {
    const qs = new URLSearchParams()
    for (const c of channelFilters) qs.append('channel', c)
    for (const m of marketplaceFilters) qs.append('marketplace', m)
    for (const s of statusFilters) qs.append('listingStatus', s)
    for (const s of syncStatusFilters) qs.append('syncStatus', s)
    if (hasError) qs.set('hasError', 'true')
    if (lowStock) qs.set('lowStock', 'true')
    if (publishedOnly) qs.set('published', 'true')
    if (search) qs.set('search', search)
    const q = qs.toString()
    return `/api/listings/facets${q ? `?${q}` : ''}`
  }, [channelFilters, marketplaceFilters, statusFilters, syncStatusFilters, hasError, lowStock, publishedOnly, search])

  const fetchFacets = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}${facetsUrl}`, { cache: 'no-store' })
      if (res.ok) setFacets(await res.json())
    } catch {}
  }, [facetsUrl])

  const fetchMarketplaces = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/marketplaces`, { cache: 'no-store' })
      if (res.ok) setMarketplaces(await res.json())
    } catch {}
  }, [])

  // Refetch facets whenever the URL changes (i.e. any filter changes).
  // Marketplaces are static reference data; load once.
  useEffect(() => { fetchFacets() }, [fetchFacets])
  useEffect(() => { fetchMarketplaces() }, [fetchMarketplaces])

  // Phase 10 — when something else changes data we render (a product
  // edit on /products, a bulk-action on /bulk-operations, a wizard
  // submit), refresh the facets in tandem with the grid. usePolledList
  // already handles the grid; we just hook facets in here.
  useInvalidationChannel(
    [
      'product.updated',
      'product.deleted',
      'listing.updated',
      'listing.created',
      'listing.deleted',
      'wizard.submitted',
      'bulk-job.completed',
    ],
    () => fetchFacets(),
  )

  // Reset selection when filters change
  useEffect(() => { setSelected(new Set()) }, [page, search, channelFilters.join(','), marketplaceFilters.join(','), statusFilters.join(','), syncStatusFilters.join(','), hasError, lowStock, publishedOnly])

  // ── Computed ───────────────────────────────────────────────────────
  const channelLabel = lockChannel
    ? lockChannel.charAt(0) + lockChannel.slice(1).toLowerCase()
    : null
  const title = titleOverride ?? (channelLabel
    ? `${channelLabel}${lockMarketplace ? ` · ${COUNTRY_NAMES[lockMarketplace] ?? lockMarketplace}` : ''} Listings`
    : 'All Listings')
  const description = lockChannel
    ? `Manage listings on ${channelLabel}${lockMarketplace ? ` ${lockMarketplace}` : ''}. All lenses, filters, and bulk actions are scoped to this view.`
    : 'Every published listing across all channels and marketplaces. Switch lenses, filter, and bulk-edit.'

  const visible = useMemo(() => ALL_COLUMNS.filter((c) => visibleColumns.includes(c.key)), [visibleColumns])

  return (
    <div className="space-y-5">
      <PageHeader
        title={title}
        description={description}
        breadcrumbs={breadcrumbs}
      />

      {/* Lens switcher + global stats strip */}
      <div className="flex items-center gap-2 flex-wrap">
        <LensTabs
          current={lens}
          onChange={(next) => updateUrl({ lens: next === 'grid' ? undefined : next, page: undefined })}
        />
        <div className="ml-auto flex items-center gap-3">
          {facets && (
            <div className="flex items-center gap-3 text-base text-slate-500">
              <span><span className="font-semibold text-slate-700 tabular-nums">{facets.total}</span> total</span>
              <span className="text-slate-300">·</span>
              <span className={facets.errorCount > 0 ? 'text-rose-600' : ''}>
                <span className="font-semibold tabular-nums">{facets.errorCount}</span> errors
              </span>
            </div>
          )}
          {lens === 'grid' && (
            <FreshnessIndicator
              lastFetchedAt={gridFetchedAt}
              onRefresh={() => { fetchGrid(); fetchFacets() }}
              loading={gridLoading}
              error={!!gridError}
            />
          )}
          {lens !== 'grid' && (
            <button
              onClick={() => { fetchGrid(); fetchFacets() }}
              className="h-8 px-3 text-base border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <RefreshCw size={12} /> Refresh
            </button>
          )}
        </div>
      </div>

      {/* Filters bar (visible on Grid + Drafts lens; Health and Matrix have their own). */}
      {(lens === 'grid' || lens === 'drafts') && (
        <FilterBar
          lockChannel={lockChannel}
          lockMarketplace={lockMarketplace}
          searchInput={searchInput}
          setSearchInput={setSearchInput}
          channelFilters={channelFilters}
          marketplaceFilters={marketplaceFilters}
          statusFilters={statusFilters}
          syncStatusFilters={syncStatusFilters}
          hasError={hasError}
          lowStock={lowStock}
          publishedOnly={publishedOnly}
          marketplaces={marketplaces}
          facets={facets}
          updateUrl={updateUrl}
          filtersOpen={filtersOpen}
          setFiltersOpen={setFiltersOpen}
        />
      )}

      {/* Bulk action bar — visible when grid rows are selected */}
      {lens === 'grid' && selected.size > 0 && (
        <BulkActionBar
          selectedIds={Array.from(selected)}
          onClear={() => setSelected(new Set())}
          onComplete={() => { setSelected(new Set()); fetchGrid(); fetchFacets() }}
        />
      )}

      {/* Lens body */}
      {lens === 'grid' && (
        <GridLens
          grid={grid}
          visible={visible}
          visibleColumns={visibleColumns}
          setVisibleColumns={setVisibleColumns}
          columnPickerOpen={columnPickerOpen}
          setColumnPickerOpen={setColumnPickerOpen}
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={(key) => {
            const dir = sortBy === key && sortDir === 'desc' ? 'asc' : 'desc'
            updateUrl({ sortBy: key, sortDir: dir, page: undefined })
          }}
          page={page}
          onPage={(p) => updateUrl({ page: p === 1 ? undefined : String(p) })}
          selected={selected}
          setSelected={setSelected}
          onOpenDrawer={(id) => setDrawerListingId(id)}
          onResync={async (id) => {
            try {
              await fetch(`${getBackendUrl()}/api/listings/${id}/resync`, { method: 'POST' })
              fetchGrid()
            } catch {}
          }}
        />
      )}

      {lens === 'health' && (
        <HealthLens lockChannel={lockChannel} onOpenDrawer={(id) => setDrawerListingId(id)} />
      )}

      {lens === 'matrix' && (
        <MatrixLens lockChannel={lockChannel} marketplaces={marketplaces} />
      )}

      {lens === 'drafts' && (
        <DraftsLens
          lockChannel={lockChannel}
          lockMarketplace={lockMarketplace}
          search={search}
          marketplaces={marketplaces}
        />
      )}

      {/* Detail drawer */}
      {drawerListingId && (
        <ListingDrawer id={drawerListingId} onClose={() => setDrawerListingId(null)} onChanged={() => { fetchGrid(); fetchFacets() }} />
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// LensTabs
// ────────────────────────────────────────────────────────────────────
function LensTabs({ current, onChange }: { current: Lens; onChange: (l: Lens) => void }) {
  const tabs: Array<{ key: Lens; label: string; icon: any }> = [
    { key: 'grid', label: 'Grid', icon: Boxes },
    { key: 'health', label: 'Health', icon: AlertTriangle },
    { key: 'matrix', label: 'Matrix', icon: LayoutGrid },
    { key: 'drafts', label: 'Drafts', icon: Sparkles },
  ]
  return (
    <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`h-7 px-3 text-base font-medium inline-flex items-center gap-1.5 rounded transition-colors ${
            current === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
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
function FilterBar(props: {
  lockChannel?: string
  lockMarketplace?: string
  searchInput: string
  setSearchInput: (s: string) => void
  channelFilters: string[]
  marketplaceFilters: string[]
  statusFilters: string[]
  syncStatusFilters: string[]
  hasError: boolean
  lowStock: boolean
  publishedOnly: boolean
  marketplaces: Marketplace[]
  facets: Facets | null
  updateUrl: (p: Record<string, string | undefined>) => void
  filtersOpen: boolean
  setFiltersOpen: (b: boolean) => void
}) {
  const {
    lockChannel, lockMarketplace, searchInput, setSearchInput,
    channelFilters, marketplaceFilters, statusFilters, syncStatusFilters,
    hasError, lowStock, publishedOnly, marketplaces, facets, updateUrl,
    filtersOpen, setFiltersOpen,
  } = props

  const activeFilterCount =
    (channelFilters.length && !lockChannel ? 1 : 0) +
    (marketplaceFilters.length && !lockMarketplace ? 1 : 0) +
    (statusFilters.length ? 1 : 0) +
    (syncStatusFilters.length ? 1 : 0) +
    (hasError ? 1 : 0) +
    (lowStock ? 1 : 0) +
    (publishedOnly ? 1 : 0)

  const channelOptions = facets?.channels.map((c) => c.value) ?? ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY']
  const statusOptions = facets?.statuses.map((s) => s.value) ?? ['ACTIVE', 'DRAFT', 'PENDING', 'SUPPRESSED', 'ENDED', 'ERROR']
  const syncOptions = facets?.syncStatuses.map((s) => s.value) ?? ['IDLE', 'PENDING', 'SYNCING', 'IN_SYNC', 'FAILED']

  const marketplaceOptions = useMemo(() => {
    const filtered = lockChannel
      ? marketplaces.filter((m) => m.channel === lockChannel)
      : (channelFilters.length > 0 ? marketplaces.filter((m) => channelFilters.includes(m.channel)) : marketplaces)
    return filtered.map((m) => m.code)
  }, [marketplaces, lockChannel, channelFilters])

  const toggleArr = (current: string[], val: string) =>
    current.includes(val) ? current.filter((v) => v !== val) : [...current, val]

  return (
    <Card>
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex-1 min-w-[240px] max-w-md relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder="Search SKU, product name, external ID, or title"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-7"
            />
          </div>
          <button
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={`h-8 px-3 text-base border rounded-md inline-flex items-center gap-1.5 ${
              filtersOpen || activeFilterCount > 0
                ? 'border-slate-300 bg-slate-50 text-slate-900'
                : 'border-slate-200 hover:bg-slate-50 text-slate-600'
            }`}
          >
            <Filter size={12} />
            Filters
            {activeFilterCount > 0 && (
              <span className="bg-slate-700 text-white text-xs px-1.5 py-0.5 rounded-full font-semibold">{activeFilterCount}</span>
            )}
            <ChevronDown size={12} className={filtersOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
          </button>
          {activeFilterCount > 0 && (
            <button
              onClick={() => updateUrl({
                channel: lockChannel ? undefined : '',
                marketplace: lockMarketplace ? undefined : '',
                listingStatus: '',
                syncStatus: '',
                hasError: undefined,
                lowStock: undefined,
                published: undefined,
                page: undefined,
              })}
              className="h-8 px-2 text-base text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
            >
              <X size={12} /> Clear
            </button>
          )}
        </div>

        {filtersOpen && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 pt-2 border-t border-slate-100">
            {!lockChannel && (
              <FilterGroup
                label="Channel"
                options={channelOptions}
                selected={channelFilters}
                facetCounts={facets?.channels.reduce((m, c) => { m[c.value] = c.count; return m }, {} as Record<string, number>)}
                onToggle={(val) => updateUrl({ channel: toggleArr(channelFilters, val).join(',') || undefined, marketplace: undefined, page: undefined })}
              />
            )}
            {!lockMarketplace && marketplaceOptions.length > 0 && (
              <FilterGroup
                label="Marketplace"
                options={marketplaceOptions}
                selected={marketplaceFilters}
                renderLabel={(code) => `${code} · ${COUNTRY_NAMES[code] ?? ''}`.trim()}
                onToggle={(val) => updateUrl({ marketplace: toggleArr(marketplaceFilters, val).join(',') || undefined, page: undefined })}
              />
            )}
            <FilterGroup
              label="Status"
              options={statusOptions}
              selected={statusFilters}
              facetCounts={facets?.statuses.reduce((m, c) => { m[c.value] = c.count; return m }, {} as Record<string, number>)}
              onToggle={(val) => updateUrl({ listingStatus: toggleArr(statusFilters, val).join(',') || undefined, page: undefined })}
            />
            <FilterGroup
              label="Sync"
              options={syncOptions}
              selected={syncStatusFilters}
              facetCounts={facets?.syncStatuses.reduce((m, c) => { m[c.value] = c.count; return m }, {} as Record<string, number>)}
              onToggle={(val) => updateUrl({ syncStatus: toggleArr(syncStatusFilters, val).join(',') || undefined, page: undefined })}
            />

            <div className="md:col-span-2 lg:col-span-4 flex items-center gap-3 flex-wrap pt-2 border-t border-slate-100">
              <ToggleChip
                active={hasError}
                label="Has error"
                tone="danger"
                onClick={() => updateUrl({ hasError: hasError ? undefined : 'true', page: undefined })}
              />
              <ToggleChip
                active={lowStock}
                label="Low stock"
                tone="warning"
                onClick={() => updateUrl({ lowStock: lowStock ? undefined : 'true', page: undefined })}
              />
              <ToggleChip
                active={publishedOnly}
                label="Published only"
                tone="success"
                onClick={() => updateUrl({ published: publishedOnly ? undefined : 'true', page: undefined })}
              />
            </div>
          </div>
        )}
      </div>
    </Card>
  )
}

function FilterGroup({
  label, options, selected, onToggle, facetCounts, renderLabel,
}: {
  label: string
  options: string[]
  selected: string[]
  onToggle: (val: string) => void
  facetCounts?: Record<string, number>
  renderLabel?: (val: string) => string
}) {
  if (options.length === 0) return null
  return (
    <div>
      <div className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-1.5">{label}</div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {options.map((opt) => {
          const active = selected.includes(opt)
          const count = facetCounts?.[opt]
          return (
            <button
              key={opt}
              onClick={() => onToggle(opt)}
              className={`h-7 px-2 text-sm border rounded inline-flex items-center gap-1.5 transition-colors ${
                active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
              }`}
            >
              {renderLabel ? renderLabel(opt) : opt}
              {count != null && (
                <span className={`tabular-nums ${active ? 'text-slate-300' : 'text-slate-400'}`}>{count}</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ToggleChip({ active, label, onClick, tone }: { active: boolean; label: string; onClick: () => void; tone: 'danger' | 'warning' | 'success' }) {
  const activeClasses = {
    danger: 'bg-rose-50 text-rose-700 border-rose-300',
    warning: 'bg-amber-50 text-amber-700 border-amber-300',
    success: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  }[tone]
  return (
    <button
      onClick={onClick}
      className={`h-7 px-3 text-sm border rounded-full font-medium transition-colors ${
        active ? activeClasses : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
      }`}
    >
      {label}
    </button>
  )
}

// ────────────────────────────────────────────────────────────────────
// GridLens
// ────────────────────────────────────────────────────────────────────
function GridLens(props: {
  grid: { listings: Listing[]; total: number; totalPages: number; loading: boolean; error: string | null }
  visible: ReadonlyArray<{ key: string; label: string; width: number }>
  visibleColumns: string[]
  setVisibleColumns: (cols: string[]) => void
  columnPickerOpen: boolean
  setColumnPickerOpen: (b: boolean) => void
  sortBy: string
  sortDir: 'asc' | 'desc'
  onSort: (key: string) => void
  page: number
  onPage: (p: number) => void
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  onOpenDrawer: (id: string) => void
  onResync: (id: string) => void
}) {
  const { grid, visible, visibleColumns, setVisibleColumns, columnPickerOpen, setColumnPickerOpen, sortBy, sortDir, onSort, page, onPage, selected, setSelected, onOpenDrawer, onResync } = props

  const allSelected = grid.listings.length > 0 && grid.listings.every((l) => selected.has(l.id))

  const toggleSelectAll = () => {
    const next = new Set(selected)
    if (allSelected) {
      grid.listings.forEach((l) => next.delete(l.id))
    } else {
      grid.listings.forEach((l) => next.add(l.id))
    }
    setSelected(next)
  }

  const toggleSelect = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  if (grid.loading && grid.listings.length === 0) {
    return <Card><div className="text-md text-slate-500 py-8 text-center">Loading listings…</div></Card>
  }
  if (grid.error) {
    return <Card><div className="text-md text-rose-600 py-8 text-center">Failed to load: {grid.error}</div></Card>
  }
  if (grid.listings.length === 0) {
    return (
      <EmptyState
        icon={Boxes}
        title="No listings match these filters"
        description="Try adjusting filters or clearing the search."
        action={{ label: 'View Catalog', href: '/products' }}
      />
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 justify-end">
        <div className="relative">
          <button
            onClick={() => setColumnPickerOpen(!columnPickerOpen)}
            className="h-7 px-2 text-base border border-slate-200 rounded inline-flex items-center gap-1.5 hover:bg-slate-50"
          >
            <Settings2 size={12} /> Columns ({visibleColumns.length})
          </button>
          {columnPickerOpen && (
            <ColumnPickerMenu
              visible={visibleColumns}
              setVisible={setVisibleColumns}
              onClose={() => setColumnPickerOpen(false)}
            />
          )}
        </div>
      </div>

      <Card noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-md">
            <thead className="border-b border-slate-200 bg-slate-50 sticky top-0">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    className="cursor-pointer"
                  />
                </th>
                {visible.map((col) => (
                  <th
                    key={col.key}
                    className={`px-3 py-2 text-sm font-semibold text-slate-700 uppercase tracking-wider text-left ${col.key !== 'thumb' && col.key !== 'actions' ? 'cursor-pointer hover:bg-slate-100' : ''}`}
                    style={{ width: col.width, minWidth: col.width }}
                    onClick={() => {
                      const sortableKeys: Record<string, string> = {
                        product: 'name', channel: 'channel', marketplace: 'marketplace',
                        price: 'price', quantity: 'quantity', lastSync: 'lastSyncedAt',
                      }
                      if (sortableKeys[col.key]) onSort(sortableKeys[col.key])
                    }}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {sortBy === ({ product: 'name', channel: 'channel', marketplace: 'marketplace', price: 'price', quantity: 'quantity', lastSync: 'lastSyncedAt' } as any)[col.key] && (
                        <span className="text-slate-400">{sortDir === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.listings.map((l) => {
                const isSelected = selected.has(l.id)
                return (
                  <tr key={l.id} className={`border-b border-slate-100 hover:bg-slate-50 transition-colors ${isSelected ? 'bg-blue-50/30' : ''}`}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(l.id)}
                        className="cursor-pointer"
                      />
                    </td>
                    {visible.map((col) => (
                      <td key={col.key} className="px-3 py-2 align-middle" style={{ width: col.width, minWidth: col.width }}>
                        <CellRenderer col={col.key} listing={l} onOpenDrawer={onOpenDrawer} onResync={onResync} />
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Pagination page={page} totalPages={grid.totalPages} onPage={onPage} />
    </div>
  )
}

function CellRenderer({ col, listing, onOpenDrawer, onResync }: { col: string; listing: Listing; onOpenDrawer: (id: string) => void; onResync: (id: string) => void }) {
  const l = listing
  switch (col) {
    case 'thumb':
      return l.product.thumbnailUrl ? (
        <img src={l.product.thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover bg-slate-100" />
      ) : (
        <div className="w-8 h-8 rounded bg-slate-100 flex items-center justify-center text-slate-400">
          <Package size={14} />
        </div>
      )
    case 'product':
      return (
        <div className="min-w-0">
          <button
            onClick={() => onOpenDrawer(l.id)}
            className="text-md font-medium text-slate-900 hover:text-blue-600 text-left truncate block max-w-full"
          >
            {l.product.name}
            {l.product.isParent && <Layers size={11} className="inline ml-1 text-slate-400" />}
          </button>
          <div className="text-sm text-slate-500 font-mono truncate">{l.product.sku}</div>
        </div>
      )
    case 'channel':
      return (
        <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${CHANNEL_TONE[l.channel] ?? 'bg-slate-50 text-slate-600 border-slate-200'}`}>
          {l.channel}
        </span>
      )
    case 'marketplace':
      return (
        <span className="font-mono text-sm font-semibold bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
          {l.marketplace}
        </span>
      )
    case 'status':
      return <Badge variant={STATUS_VARIANT[l.listingStatus] ?? 'default'} size="sm">{l.listingStatus}</Badge>
    case 'syncStatus': {
      const status = l.syncStatus ?? 'IDLE'
      const variant = STATUS_VARIANT[status] ?? 'default'
      return (
        <div className="flex items-center gap-1">
          <Badge variant={variant} size="sm">{status}</Badge>
          {l.syncRetryCount > 0 && <span className="text-xs text-slate-400 tabular-nums">×{l.syncRetryCount}</span>}
        </div>
      )
    }
    case 'price':
      return (
        <div className="text-right tabular-nums">
          {l.price != null ? (
            <>
              <div className="text-md text-slate-900">{l.currency ?? ''} {l.price.toFixed(2)}</div>
              {l.salePrice != null && <div className="text-sm text-rose-600">Sale {l.salePrice.toFixed(2)}</div>}
            </>
          ) : <span className="text-slate-400">—</span>}
        </div>
      )
    case 'pricingRule':
      return (
        <span className="text-sm text-slate-600">
          {l.pricingRule === 'PERCENT_OF_MASTER' && l.priceAdjustmentPercent != null
            ? `${l.priceAdjustmentPercent > 0 ? '+' : ''}${l.priceAdjustmentPercent}% master`
            : l.pricingRule === 'MATCH_AMAZON' ? 'Match Amazon'
            : l.pricingRule === 'FIXED' ? 'Fixed'
            : '—'}
        </span>
      )
    case 'masterDelta': {
      if (l.price == null || l.masterPrice == null) return <span className="text-slate-400">—</span>
      const delta = l.price - l.masterPrice
      const pct = l.masterPrice > 0 ? (delta / l.masterPrice) * 100 : 0
      const tone = Math.abs(pct) < 0.5 ? 'text-slate-500' : pct > 0 ? 'text-emerald-600' : 'text-rose-600'
      return (
        <span className={`text-sm tabular-nums ${tone}`}>
          {delta >= 0 ? '+' : ''}{delta.toFixed(2)} ({pct >= 0 ? '+' : ''}{pct.toFixed(0)}%)
        </span>
      )
    }
    case 'quantity': {
      const q = l.quantity
      if (q == null) return <span className="text-slate-400 text-right block">—</span>
      const tone = q === 0 ? 'text-rose-600' : q <= 5 ? 'text-amber-600' : 'text-slate-700'
      return <div className={`text-right tabular-nums ${tone}`}>{q}</div>
    }
    case 'follow':
      return (
        <span className="text-xs text-slate-500">
          {[
            l.followMasterTitle && 'T',
            l.followMasterPrice && 'P',
            l.followMasterQuantity && 'Q',
          ].filter(Boolean).join('') || '—'}
        </span>
      )
    case 'externalId':
      return l.externalListingId ? (
        l.listingUrl ? (
          <a href={l.listingUrl} target="_blank" rel="noreferrer" className="text-base text-blue-600 hover:underline font-mono inline-flex items-center gap-1">
            {l.externalListingId.slice(0, 14)}{l.externalListingId.length > 14 ? '…' : ''}
            <ExternalLink size={10} />
          </a>
        ) : (
          <span className="text-base font-mono text-slate-700">{l.externalListingId}</span>
        )
      ) : <span className="text-slate-400">—</span>
    case 'lastSync':
      return (
        <span className="text-base text-slate-500">
          {l.lastSyncedAt
            ? new Date(l.lastSyncedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
            : 'Never'}
        </span>
      )
    case 'actions':
      return (
        <div className="flex items-center gap-1 justify-end">
          <button
            onClick={() => onResync(l.id)}
            title="Resync"
            className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded"
          >
            <RefreshCw size={12} />
          </button>
          <Link
            href={`/products/${l.productId}/edit?channel=${l.channel}&marketplace=${l.marketplace}`}
            className="h-6 px-2 text-sm inline-flex items-center text-slate-600 hover:text-blue-600 hover:bg-blue-50 rounded"
          >
            Edit
          </Link>
        </div>
      )
    default:
      return null
  }
}

// ────────────────────────────────────────────────────────────────────
// ColumnPickerMenu
// ────────────────────────────────────────────────────────────────────
function ColumnPickerMenu({ visible, setVisible, onClose }: { visible: string[]; setVisible: (v: string[]) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [onClose])
  const togglable = ALL_COLUMNS.filter((c) => c.key !== 'thumb')
  return (
    <div ref={ref} className="absolute right-0 top-full mt-1 w-56 bg-white border border-slate-200 rounded-md shadow-lg z-10 p-1.5">
      <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 px-2 py-1.5">Visible columns</div>
      {togglable.map((c) => (
        <label key={c.key} className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 rounded text-base cursor-pointer">
          <input
            type="checkbox"
            checked={visible.includes(c.key)}
            onChange={() => {
              if (visible.includes(c.key)) setVisible(visible.filter((k) => k !== c.key))
              else setVisible([...visible, c.key])
            }}
          />
          <span className="text-slate-700">{c.label || c.key}</span>
        </label>
      ))}
      <div className="border-t border-slate-100 mt-1.5 pt-1.5 px-2 py-1 flex items-center justify-between">
        <button onClick={() => setVisible(DEFAULT_VISIBLE)} className="text-sm text-slate-500 hover:text-slate-900">Reset</button>
        <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-900">Close</button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// Pagination
// ────────────────────────────────────────────────────────────────────
function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null
  return (
    <div className="flex items-center justify-between text-base text-slate-500">
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
  )
}

// ────────────────────────────────────────────────────────────────────
// BulkActionBar
// ────────────────────────────────────────────────────────────────────
function BulkActionBar({ selectedIds, onClear, onComplete }: { selectedIds: string[]; onClear: () => void; onComplete: () => void }) {
  const [busy, setBusy] = useState(false)
  const [jobStatus, setJobStatus] = useState<string | null>(null)
  const [setPriceOpen, setSetPriceOpen] = useState(false)

  const runAction = async (action: string, payload?: any) => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/bulk-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, listingIds: selectedIds, payload }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Bulk action failed')
      const jobId = data.jobId
      setJobStatus('Processing…')

      // Poll. S.0.5 / M-10 — track whether we exited via a terminal
      // status vs. the 60-second cap; the latter used to silently leave
      // the prior "Processing N/M…" or "Done" string on screen, even
      // when the worker was still running. Now we surface an honest
      // "did not complete in 60s" so the operator knows where to look.
      const start = Date.now()
      let reachedTerminal = false
      let lastJob: { processed: number; total: number; succeeded: number; failed: number; status: string } | null = null
      while (Date.now() - start < 60_000) {
        await new Promise((r) => setTimeout(r, 600))
        const j = await fetch(`${getBackendUrl()}/api/listings/bulk-action/${jobId}`)
        if (!j.ok) break
        const job = await j.json()
        lastJob = job
        setJobStatus(`Processing ${job.processed}/${job.total}…`)
        if (
          job.status === 'COMPLETED' ||
          job.status === 'FAILED' ||
          job.status === 'PARTIALLY_COMPLETED'
        ) {
          reachedTerminal = true
          setJobStatus(`Done — ${job.succeeded} succeeded, ${job.failed} failed`)
          break
        }
      }
      if (!reachedTerminal) {
        const progress = lastJob
          ? `${lastJob.processed}/${lastJob.total} processed`
          : 'no progress visible'
        setJobStatus(`Job did not complete in 60s — still running (${progress}). Check back shortly.`)
      }
      // Phase 10 — broadcast so other open pages refresh. Bulk listing
      // actions (publish, unpublish, resync, set-price, follow-master)
      // change ChannelListing rows; emit listing.updated + bulk-job.completed
      // so /products, /catalog/organize, and /bulk-operations all
      // refetch within ~200ms.
      emitInvalidation({
        type: 'listing.updated',
        meta: {
          action,
          count: selectedIds.length,
          listingIds: selectedIds,
          source: 'listings-bulk',
        },
      })
      emitInvalidation({
        type: 'bulk-job.completed',
        meta: { action, listingIds: selectedIds },
      })
      onComplete()
      setTimeout(() => setJobStatus(null), 2500)
    } catch (e: any) {
      setJobStatus(`Error: ${e.message}`)
      setTimeout(() => setJobStatus(null), 4000)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sticky top-2 z-20">
      <Card>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-base font-semibold text-slate-700">
            {selectedIds.length} selected
          </span>
          <div className="h-4 w-px bg-slate-200" />
          <button onClick={() => runAction('publish')} disabled={busy} className="h-7 px-3 text-base bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 disabled:opacity-50 inline-flex items-center gap-1.5"><Eye size={12} /> Publish</button>
          <button onClick={() => runAction('unpublish')} disabled={busy} className="h-7 px-3 text-base bg-slate-50 text-slate-700 border border-slate-200 rounded hover:bg-slate-100 disabled:opacity-50 inline-flex items-center gap-1.5"><EyeOff size={12} /> Unpublish</button>
          <button onClick={() => runAction('resync')} disabled={busy} className="h-7 px-3 text-base bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 disabled:opacity-50 inline-flex items-center gap-1.5"><RefreshCw size={12} /> Resync</button>
          <button
            onClick={() => setSetPriceOpen(true)}
            disabled={busy}
            className="h-7 px-3 text-base bg-white text-slate-700 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5"
          ><Tag size={12} /> Set price</button>
          <button onClick={() => runAction('follow-master')} disabled={busy} className="h-7 px-3 text-base bg-white text-slate-700 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5"><Link2 size={12} /> Follow master</button>
          <button onClick={() => runAction('unfollow-master')} disabled={busy} className="h-7 px-3 text-base bg-white text-slate-700 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5">Unfollow master</button>
          {jobStatus && <span className="text-sm text-slate-500 ml-2">{jobStatus}</span>}
          <button onClick={onClear} disabled={busy} className="ml-auto h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded disabled:opacity-50">
            <X size={14} />
          </button>
        </div>
      </Card>
      <SetPriceModal
        open={setPriceOpen}
        count={selectedIds.length}
        onClose={() => setSetPriceOpen(false)}
        onConfirm={(price) => {
          setSetPriceOpen(false)
          runAction('set-price', { price })
        }}
      />
    </div>
  )
}

// S.0.5 / M-3 — Set Price modal replaces the previous window.prompt
// flow. Uses the canonical Modal primitive (focus trap, Esc, click-
// outside) and validates the input live so users can't submit a
// negative or non-numeric value. The "this unfollows master" warning
// surfaces the side effect that the bulk-action endpoint applies
// silently — operators noticed it the hard way before.
function SetPriceModal({
  open,
  count,
  onClose,
  onConfirm,
}: {
  open: boolean
  count: number
  onClose: () => void
  onConfirm: (price: number) => void
}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Reset whenever the modal is reopened so a stale value from a
  // previous session doesn't pre-fill.
  useEffect(() => {
    if (open) {
      setValue('')
      setError(null)
    }
  }, [open])

  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed) {
      setError('Enter a price.')
      return
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n)) {
      setError('Price must be a number.')
      return
    }
    if (n < 0) {
      setError('Price cannot be negative.')
      return
    }
    onConfirm(n)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set price"
      description={`Apply to ${count} selected listing${count === 1 ? '' : 's'}.`}
      size="md"
    >
      <ModalBody>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">
              Price
            </label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                if (error) setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submit()
                }
              }}
              placeholder="e.g. 99.00"
              autoFocus
            />
            {error && (
              <div className="text-sm text-rose-600 mt-1.5">{error}</div>
            )}
          </div>
          <div className="text-sm text-slate-500 bg-slate-50 border border-slate-200 rounded-md p-2.5">
            <strong className="text-slate-700">Heads up:</strong> setting a
            price unfollows the master price for these listings — they
            won&apos;t auto-update from the catalog basePrice anymore. Use
            &quot;Follow master&quot; to re-link later.
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          onClick={onClose}
          className="h-8 px-3 text-base text-slate-700 border border-slate-200 rounded hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          className="h-8 px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1.5"
        >
          <Tag size={12} /> Apply price
        </button>
      </ModalFooter>
    </Modal>
  )
}

// ────────────────────────────────────────────────────────────────────
// HealthLens
// ────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────
// HealthScoreBadge — small pill rendering a 0-100 score with category
// color. Used inline (drawer header, recent errors list, matrix corner).
// ────────────────────────────────────────────────────────────────────
function HealthScoreBadge({
  score,
  category,
  size = 'md',
}: {
  score: number
  category: 'HEALTHY' | 'WARNING' | 'CRITICAL'
  size?: 'sm' | 'md' | 'lg'
}) {
  const tone =
    category === 'HEALTHY' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : category === 'WARNING' ? 'bg-amber-50 text-amber-700 border-amber-200'
    : 'bg-rose-50 text-rose-700 border-rose-200'
  const sizeClass =
    size === 'sm' ? 'h-5 px-1.5 text-xs'
    : size === 'lg' ? 'h-9 px-3 text-lg'
    : 'h-6 px-2 text-sm'
  return (
    <span className={`inline-flex items-center gap-1 rounded border tabular-nums font-semibold ${tone} ${sizeClass}`}>
      {score}
      <span className="opacity-60 text-xs uppercase tracking-wider">/100</span>
    </span>
  )
}

// ────────────────────────────────────────────────────────────────────
// HealthPanel — score + structured issues with quick-fix actions.
// Used in drawer Detail tab. Replaces the prior flat lastSyncError +
// validationErrors blocks with a single source of truth driven by the
// server-computed `health` field on the listing.
// ────────────────────────────────────────────────────────────────────
const ISSUE_CATEGORY_LABEL: Record<string, string> = {
  sync: 'Sync',
  validation: 'Validation',
  data: 'Data',
  drift: 'Drift',
  staleness: 'Staleness',
  suppression: 'Suppression',
  retry: 'Retry',
}

function HealthPanel({
  health,
  handlers,
}: {
  health: { score: number; category: 'HEALTHY' | 'WARNING' | 'CRITICAL'; issues: any[] }
  handlers: {
    onResync: () => Promise<void> | void
    onSnapMaster: (field: 'price' | 'quantity' | 'title') => Promise<void> | void
    onEdit: () => void
    onViewMarketplace: () => void
  }
}) {
  // Group issues by severity so errors render first, then warnings,
  // then info. Within a severity, drift issues stay last (they're
  // informational and often intentional).
  const sorted = useMemo(() => {
    const order: Record<string, number> = { error: 0, warning: 1, info: 2 }
    return [...health.issues].sort((a, b) => {
      const s = (order[a.severity] ?? 3) - (order[b.severity] ?? 3)
      if (s !== 0) return s
      // drift category sinks last within a severity
      if (a.category === 'drift' && b.category !== 'drift') return 1
      if (b.category === 'drift' && a.category !== 'drift') return -1
      return 0
    })
  }, [health.issues])

  const tone =
    health.category === 'HEALTHY' ? 'border-emerald-200 bg-emerald-50/30'
    : health.category === 'WARNING' ? 'border-amber-200 bg-amber-50/30'
    : 'border-rose-200 bg-rose-50/30'

  return (
    <div className={`border rounded-md p-3 space-y-3 ${tone}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Health</div>
          <div className="flex items-center gap-2 mt-0.5">
            <HealthScoreBadge score={health.score} category={health.category} size="lg" />
            <span className="text-sm text-slate-600">
              {health.category === 'HEALTHY'
                ? 'All clear.'
                : `${health.issues.length} issue${health.issues.length === 1 ? '' : 's'} to review.`}
            </span>
          </div>
        </div>
      </div>

      {sorted.length > 0 && (
        <ul className="space-y-1.5">
          {sorted.map((issue) => (
            <HealthIssueRow key={issue.id} issue={issue} handlers={handlers} />
          ))}
        </ul>
      )}
    </div>
  )
}

function HealthIssueRow({
  issue,
  handlers,
}: {
  issue: any
  handlers: {
    onResync: () => Promise<void> | void
    onSnapMaster: (field: 'price' | 'quantity' | 'title') => Promise<void> | void
    onEdit: () => void
    onViewMarketplace: () => void
  }
}) {
  const sevTone =
    issue.severity === 'error' ? 'border-l-rose-500 bg-rose-50/40'
    : issue.severity === 'warning' ? 'border-l-amber-500 bg-amber-50/40'
    : 'border-l-blue-300 bg-white'

  const fix = issue.fix as
    | { type: 'resync'; label: string }
    | { type: 'snap-master'; label: string; field: 'price' | 'quantity' | 'title' }
    | { type: 'edit'; label: string }
    | { type: 'view-marketplace'; label: string }
    | undefined

  const onFix = useCallback(async () => {
    if (!fix) return
    if (fix.type === 'resync') return handlers.onResync()
    if (fix.type === 'snap-master') return handlers.onSnapMaster(fix.field)
    if (fix.type === 'edit') return handlers.onEdit()
    if (fix.type === 'view-marketplace') return handlers.onViewMarketplace()
  }, [fix, handlers])

  return (
    <li className={`border border-slate-200 border-l-4 rounded p-2.5 ${sevTone}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
              {ISSUE_CATEGORY_LABEL[issue.category] ?? issue.category}
            </span>
            <span className="text-base font-semibold text-slate-900">{issue.title}</span>
          </div>
          <div className="text-sm text-slate-700">{issue.detail}</div>
        </div>
        {fix && (
          <button
            onClick={onFix}
            className="h-7 px-2.5 text-sm bg-white text-slate-700 border border-slate-300 rounded hover:bg-slate-50 inline-flex items-center gap-1 flex-shrink-0"
          >
            {fix.label}
          </button>
        )}
      </div>
    </li>
  )
}

// ────────────────────────────────────────────────────────────────────
// HealthLens — S.3 rebuild
//
// The rollup view for /listings?lens=health. Adds:
//   - Score-bucket distribution (HEALTHY / WARNING / CRITICAL counts)
//   - Issues-by-category summary (sync / validation / data / drift /
//     staleness / suppression / retry)
//   - Existing top reasons + recent errors lists keep working
// ────────────────────────────────────────────────────────────────────

const CATEGORY_TONE: Record<string, string> = {
  sync: 'text-rose-700 bg-rose-50 border-rose-200',
  validation: 'text-amber-700 bg-amber-50 border-amber-200',
  data: 'text-amber-700 bg-amber-50 border-amber-200',
  drift: 'text-blue-700 bg-blue-50 border-blue-200',
  staleness: 'text-slate-700 bg-slate-50 border-slate-200',
  suppression: 'text-rose-700 bg-rose-50 border-rose-200',
  retry: 'text-amber-700 bg-amber-50 border-amber-200',
}

function HealthLens({ lockChannel, onOpenDrawer }: { lockChannel?: string; onOpenDrawer: (id: string) => void }) {
  const url = useMemo(() => {
    const qs = lockChannel ? `?channel=${lockChannel}` : ''
    return `/api/listings/health${qs}`
  }, [lockChannel])
  const { data, loading, error } = usePolledList<any>({
    url,
    intervalMs: 30_000,
    invalidationTypes: [
      'listing.updated',
      'listing.created',
      'listing.deleted',
      'bulk-job.completed',
      'wizard.submitted',
    ],
  })

  if (loading && !data) return <Card><Skeleton variant="text" lines={3} /></Card>
  if (error && !data) return <Card><div className="text-md text-rose-600 py-8 text-center">Failed to load health rollup: {error}</div></Card>
  if (!data) return <Card><div className="text-md text-rose-600 py-8 text-center">Failed to load health rollup.</div></Card>

  const buckets = data.scoreBuckets ?? { HEALTHY: 0, WARNING: 0, CRITICAL: 0 }
  const totalScored = (buckets.HEALTHY ?? 0) + (buckets.WARNING ?? 0) + (buckets.CRITICAL ?? 0)
  const issuesByCategory = data.issuesByCategory ?? {}
  const allClear = data.errorCount === 0 && data.failedSyncCount === 0 && data.suppressedCount === 0

  return (
    <div className="space-y-4">
      {/* Score-bucket distribution */}
      <Card title="Health distribution" description={data.sampleSize != null ? `Computed over ${data.sampleSize} most recent listing${data.sampleSize === 1 ? '' : 's'}.` : undefined}>
        {totalScored === 0 ? (
          <div className="text-md text-slate-500 py-4 text-center">No listings to score yet.</div>
        ) : (
          <div className="space-y-2">
            <HealthBucketRow label="Healthy" tone="emerald" count={buckets.HEALTHY ?? 0} total={totalScored} />
            <HealthBucketRow label="Warning" tone="amber" count={buckets.WARNING ?? 0} total={totalScored} />
            <HealthBucketRow label="Critical" tone="rose" count={buckets.CRITICAL ?? 0} total={totalScored} />
          </div>
        )}
      </Card>

      {/* Issues by category */}
      {Object.values(issuesByCategory).some((n: any) => n > 0) && (
        <Card title="Issues by category" description="Across the scored sample. Click a category to filter the grid.">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {Object.entries(issuesByCategory)
              .filter(([, count]) => (count as number) > 0)
              .sort((a, b) => (b[1] as number) - (a[1] as number))
              .map(([category, count]) => (
                <div
                  key={category}
                  className={`border rounded-md px-3 py-2 ${CATEGORY_TONE[category] ?? 'border-slate-200 bg-slate-50 text-slate-700'}`}
                >
                  <div className="text-xs uppercase tracking-wider font-semibold opacity-70">
                    {ISSUE_CATEGORY_LABEL[category] ?? category}
                  </div>
                  <div className="text-[20px] font-semibold tabular-nums leading-tight">
                    {count as number}
                  </div>
                </div>
              ))}
          </div>
        </Card>
      )}

      {/* Top reasons (kept from prior) */}
      {data.topReasons?.length > 0 && (
        <Card title="Top error reasons" description="Grouped by message — fix the cause once, retry many.">
          <div className="space-y-1">
            {data.topReasons.map((r: any) => (
              <div key={r.reason} className="flex items-center justify-between gap-3 py-1.5 border-b border-slate-100 last:border-0">
                <span className="text-base text-slate-700 flex-1 min-w-0 truncate" title={r.reason}>{r.reason}</span>
                <Badge variant="danger" size="sm">{r.count}</Badge>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Recent failed listings (kept from prior) */}
      <Card title="Recent failed listings" description="Click to inspect and retry.">
        {data.recentErrors?.length === 0 ? (
          <div className="py-8 text-center">
            <CheckCircle2 className="text-emerald-500 mx-auto mb-2" size={32} />
            <div className="text-md text-slate-700 font-medium">
              {allClear ? 'All clear — listings are syncing cleanly.' : 'No recent errors to show.'}
            </div>
          </div>
        ) : (
          <ul className="space-y-1 -my-1">
            {data.recentErrors.map((e: any) => (
              <li key={e.id}>
                <button
                  onClick={() => onOpenDrawer(e.id)}
                  className="w-full flex items-start justify-between gap-3 py-2 px-3 -mx-3 rounded-md hover:bg-slate-50 text-left transition-colors"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded mt-0.5 ${CHANNEL_TONE[e.channel] ?? ''}`}>{e.channel}</span>
                    <span className="font-mono text-sm font-semibold bg-slate-100 px-1.5 py-0.5 rounded text-slate-700 mt-0.5">{e.marketplace}</span>
                    <div className="min-w-0">
                      <div className="text-md text-slate-900 truncate">{e.productName}</div>
                      <div className="text-sm text-slate-500 font-mono truncate">{e.productSku}</div>
                      {e.lastSyncError && (
                        <div className="text-sm text-rose-600 mt-1 truncate">{e.lastSyncError}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {e.syncRetryCount > 0 && <span className="text-xs text-slate-400 tabular-nums">×{e.syncRetryCount}</span>}
                    <StatusBadge status={e.lastSyncStatus ?? e.listingStatus} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function HealthBucketRow({
  label,
  tone,
  count,
  total,
}: {
  label: string
  tone: 'emerald' | 'amber' | 'rose'
  count: number
  total: number
}) {
  const pct = total === 0 ? 0 : Math.round((count / total) * 100)
  const barTone =
    tone === 'emerald' ? 'bg-emerald-500'
    : tone === 'amber' ? 'bg-amber-500'
    : 'bg-rose-500'
  const labelTone =
    tone === 'emerald' ? 'text-emerald-700'
    : tone === 'amber' ? 'text-amber-700'
    : 'text-rose-700'
  return (
    <div className="flex items-center gap-3">
      <div className={`w-24 text-sm font-semibold uppercase tracking-wider ${labelTone}`}>
        {label}
      </div>
      <div className="flex-1 h-5 bg-slate-100 rounded overflow-hidden">
        <div className={`h-full ${barTone} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <div className="w-20 text-right text-sm tabular-nums">
        <span className="font-semibold text-slate-900">{count}</span>
        <span className="text-slate-500 ml-1">({pct}%)</span>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// MatrixLens — S.1 rebuild
//
// One row per product, one column per (channel, marketplace) pair.
// Cells are interactive surfaces: click to open the drawer, hover for
// preview, kebab for per-cell actions. Empty cells turn into "+ List
// here" affordances pointing at the wizard. The header carries
// coverage filter, sort dropdown, and a refresh footer surfaces the
// freshness from usePolledList.
//
// The cornerstone differentiator vs flat per-channel grids: a single
// view shows where each product is live, where it's missing, what's
// drifted, and what's broken — all clickable.
// ────────────────────────────────────────────────────────────────────
type Coverage = 'everywhere' | 'missing-amazon' | 'missing-ebay' | 'single-channel' | 'uncovered'
type MatrixSort = 'updated' | 'coverage-gaps' | 'most-channels' | 'name'

const COVERAGE_OPTIONS: Array<{ value: Coverage | ''; label: string }> = [
  { value: '', label: 'All products' },
  { value: 'everywhere', label: 'Listed everywhere' },
  { value: 'missing-amazon', label: 'Missing on Amazon' },
  { value: 'missing-ebay', label: 'Missing on eBay' },
  { value: 'single-channel', label: 'Single channel only' },
  { value: 'uncovered', label: 'Uncovered (0 channels)' },
]

const SORT_OPTIONS: Array<{ value: MatrixSort; label: string }> = [
  { value: 'updated', label: 'Recently updated' },
  { value: 'coverage-gaps', label: 'Most coverage gaps' },
  { value: 'most-channels', label: 'Most channels' },
  { value: 'name', label: 'Name (A→Z)' },
]

function MatrixLens({ lockChannel }: { lockChannel?: string; marketplaces: Marketplace[] }) {
  const [coverage, setCoverage] = useState<Coverage | ''>('')
  const [sortBy, setSortBy] = useState<MatrixSort>('updated')
  const [drawerOpen, setDrawerOpen] = useState<string | null>(null)
  const [optimisticSyncing, setOptimisticSyncing] = useState<Set<string>>(new Set())

  const url = useMemo(() => {
    const qs = new URLSearchParams({ limit: '50' })
    if (lockChannel) qs.set('channels', lockChannel)
    if (coverage) qs.set('coverage', coverage)
    qs.set('sortBy', sortBy)
    return `/api/listings/matrix?${qs.toString()}`
  }, [lockChannel, coverage, sortBy])

  const { data, loading, error, lastFetchedAt, refetch } = usePolledList<any>({
    url,
    intervalMs: 30_000,
    invalidationTypes: [
      'listing.updated',
      'listing.created',
      'listing.deleted',
      'bulk-job.completed',
      'wizard.submitted',
      'product.updated',
      'product.deleted',
    ],
  })

  // S.1 — optimistic sync: when the user fires Sync now from a cell's
  // kebab, mark the cell as syncing locally so the dot goes amber +
  // spinner immediately. Cleared when the parent grid refetches and
  // returns the new server-side syncStatus, OR after a 60s safety net.
  const fireSync = useCallback(async (cellId: string) => {
    setOptimisticSyncing((prev) => {
      const next = new Set(prev)
      next.add(cellId)
      return next
    })
    try {
      await fetch(`${getBackendUrl()}/api/listings/${cellId}/resync`, { method: 'POST' })
    } finally {
      // Clear after a short delay so the operator sees the amber state
      // for at least a moment even on fast responses; the polled refetch
      // (or invalidation broadcast) replaces with real server state.
      setTimeout(() => {
        setOptimisticSyncing((prev) => {
          const next = new Set(prev)
          next.delete(cellId)
          return next
        })
      }, 800)
      refetch()
      emitInvalidation({ type: 'listing.updated', id: cellId })
    }
  }, [refetch])

  // Loading state — Skeleton replaces the prior plain "Loading matrix…"
  if (loading && !data) {
    return (
      <Card noPadding>
        <div className="p-4 space-y-2">
          <Skeleton variant="text" lines={1} width="40%" />
          <Skeleton variant="block" height={32} />
          <Skeleton variant="block" height={32} />
          <Skeleton variant="block" height={32} />
          <Skeleton variant="block" height={32} />
        </div>
      </Card>
    )
  }
  if (error && !data) {
    return (
      <Card>
        <div className="text-md text-rose-600 py-6 text-center space-y-2">
          <div>Failed to load matrix: {error}</div>
          <button
            onClick={() => refetch()}
            className="h-8 px-3 text-base bg-white text-rose-700 border border-rose-300 rounded hover:bg-rose-50 inline-flex items-center gap-1.5 mx-auto"
          >
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      </Card>
    )
  }
  if (!data) return null

  // Compute distinct (channel, marketplace) columns from the data
  const cellKeys = new Set<string>()
  data.products.forEach((p: any) => p.cells.forEach((c: any) => cellKeys.add(`${c.channel}:${c.marketplace}`)))
  const columns = Array.from(cellKeys).sort()

  return (
    <div className="space-y-3">
      {/* Header bar — coverage filter + sort + refresh */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Filter size={14} className="text-slate-500" />
          <span className="text-sm uppercase tracking-wider text-slate-500">Coverage:</span>
          <select
            value={coverage}
            onChange={(e) => setCoverage(e.target.value as Coverage | '')}
            className="h-8 px-2 text-base bg-white border border-slate-200 rounded text-slate-700 hover:border-slate-300 focus:outline-none focus:border-blue-500"
            aria-label="Filter by channel coverage"
          >
            {COVERAGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-sm uppercase tracking-wider text-slate-500">Sort:</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as MatrixSort)}
            className="h-8 px-2 text-base bg-white border border-slate-200 rounded text-slate-700 hover:border-slate-300 focus:outline-none focus:border-blue-500"
            aria-label="Sort products"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <span className="text-sm text-slate-500 ml-auto">
          {data.totalMatched != null && data.totalMatched > data.count
            ? `Showing ${data.count} of ${data.totalMatched} products`
            : `${data.count} product${data.count === 1 ? '' : 's'}`}
        </span>
      </div>

      {data.products.length === 0 ? (
        <EmptyState
          icon={LayoutGrid}
          title="No matches"
          description={coverage ? `No products match "${COVERAGE_OPTIONS.find((o) => o.value === coverage)?.label}".` : 'No products available.'}
        />
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table
              className="text-base"
              role="grid"
              aria-label="Multi-channel listing matrix"
              aria-rowcount={data.products.length + 1}
              aria-colcount={columns.length + 1}
            >
              <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-20">
                <tr role="row">
                  <th
                    role="columnheader"
                    className="px-3 py-2 text-left text-sm font-semibold text-slate-700 uppercase tracking-wider sticky left-0 bg-slate-50 z-30 min-w-[260px]"
                  >
                    Product
                  </th>
                  {columns.map((key) => {
                    const [ch, mp] = key.split(':')
                    return (
                      <th
                        key={key}
                        role="columnheader"
                        className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wider min-w-[110px]"
                      >
                        <div className={`inline-block px-1.5 py-0.5 rounded border ${CHANNEL_TONE[ch] ?? ''}`}>{ch}</div>
                        <div className="text-xs text-slate-500 font-mono mt-1">{mp}</div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {data.products.map((p: any) => {
                  const cellByKey = new Map<string, any>()
                  p.cells.forEach((c: any) => cellByKey.set(`${c.channel}:${c.marketplace}`, c))
                  return (
                    <tr key={p.id} role="row" className="border-b border-slate-100 hover:bg-slate-50/50">
                      <td
                        role="rowheader"
                        className="px-3 py-2 sticky left-0 bg-white border-r border-slate-100 z-10"
                      >
                        <Link href={`/products/${p.id}/edit`} className="hover:text-blue-600 block">
                          <div className="text-md font-medium text-slate-900 truncate max-w-xs">{p.name}</div>
                          <div className="text-sm text-slate-500 font-mono">{p.sku}</div>
                        </Link>
                      </td>
                      {columns.map((key) => {
                        const c = cellByKey.get(key)
                        const [ch, mp] = key.split(':')
                        return (
                          <td key={key} role="gridcell" className="px-2 py-2 text-center">
                            {c ? (
                              <MatrixCell
                                cell={c}
                                product={p}
                                optimisticSyncing={optimisticSyncing.has(c.id)}
                                onOpenDrawer={() => setDrawerOpen(c.id)}
                                onSync={() => fireSync(c.id)}
                              />
                            ) : (
                              <EmptyMatrixCell productId={p.id} channel={ch} marketplace={mp} />
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Refresh footer — surfaces freshness from usePolledList */}
      <div className="flex items-center justify-between text-sm text-slate-500 px-1">
        <span>
          {lastFetchedAt
            ? `Updated ${formatRelative(lastFetchedAt)}`
            : 'Updated just now'}
        </span>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1 text-blue-600 hover:underline"
          aria-label="Refresh matrix"
        >
          <RefreshCw size={11} /> Refresh
        </button>
      </div>

      {drawerOpen && (
        <ListingDrawer
          id={drawerOpen}
          onClose={() => setDrawerOpen(null)}
          onChanged={() => refetch()}
        />
      )}
    </div>
  )
}

// Format a millisecond timestamp as "2m ago" / "just now" / "1h ago".
// Tight inline because nothing else in /listings needs it yet; promote
// to a shared util once a second caller appears.
function formatRelative(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 30_000) return 'just now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

// ────────────────────────────────────────────────────────────────────
// MatrixCell — populated cell for a (product, channel, marketplace) tuple.
// ────────────────────────────────────────────────────────────────────
function MatrixCell({
  cell,
  product,
  optimisticSyncing,
  onOpenDrawer,
  onSync,
}: {
  cell: any
  product: { id: string; sku: string; name: string }
  optimisticSyncing: boolean
  onOpenDrawer: () => void
  onSync: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  // Effective sync status: optimistic flag wins until refetch lands.
  const syncStatus = optimisticSyncing ? 'SYNCING' : (cell.syncStatus ?? 'IDLE')
  const hasError =
    cell.listingStatus === 'ERROR' ||
    cell.lastSyncStatus === 'FAILED' ||
    cell.syncStatus === 'FAILED'

  // Drift: cell follows master price BUT channel.price !== masterPrice.
  // Subtle indicator; tooltip carries the delta.
  const drift =
    cell.followMasterPrice === false &&
    cell.price != null &&
    cell.masterPrice != null &&
    cell.price !== cell.masterPrice
      ? cell.price - cell.masterPrice
      : null

  const tone =
    cell.listingStatus === 'ACTIVE' ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
    : hasError ? 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'
    : cell.listingStatus === 'DRAFT' ? 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
    : cell.listingStatus === 'SUPPRESSED' ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'

  const ariaLabel = [
    `${cell.channel} ${cell.marketplace}`,
    cell.listingStatus,
    cell.price != null ? `price ${cell.price.toFixed(2)}` : null,
    cell.quantity != null ? `${cell.quantity} units` : null,
    cell.lastSyncedAt ? `synced ${formatRelative(new Date(cell.lastSyncedAt).getTime())}` : 'never synced',
    cell.lastSyncError ? `error: ${cell.lastSyncError.slice(0, 80)}` : null,
  ].filter(Boolean).join(', ')

  const tooltipContent = (
    <div className="space-y-1.5 max-w-[260px]">
      <div className="font-semibold">{cell.channel} · {cell.marketplace}</div>
      <div className="text-xs">
        Status: {cell.listingStatus}
        {cell.lastSyncStatus && ` · Sync: ${cell.lastSyncStatus}`}
      </div>
      {cell.price != null && (
        <div className="text-xs">
          Price: {cell.price.toFixed(2)}
          {drift != null && (
            <span className={drift > 0 ? 'text-emerald-300' : 'text-rose-300'}>
              {' '}({drift > 0 ? '+' : ''}{drift.toFixed(2)} vs master)
            </span>
          )}
        </div>
      )}
      {cell.quantity != null && <div className="text-xs">Stock: {cell.quantity} units</div>}
      <div className="text-xs">
        {cell.lastSyncedAt
          ? `Last synced ${formatRelative(new Date(cell.lastSyncedAt).getTime())}`
          : 'Never synced'}
      </div>
      {cell.lastSyncError && (
        <div className="text-xs text-rose-300 border-t border-slate-700 pt-1.5 mt-1.5">
          {cell.lastSyncError}
        </div>
      )}
    </div>
  )

  return (
    <Tooltip content={tooltipContent} delay={400}>
      <div className="group relative inline-block min-w-[100px]">
        <button
          type="button"
          onClick={onOpenDrawer}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onOpenDrawer()
            }
          }}
          aria-label={ariaLabel}
          className={`block w-full text-left px-1.5 py-1 border rounded text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${tone}`}
        >
          <div className="flex items-center justify-between gap-1.5">
            <div className="font-semibold uppercase tracking-wider truncate">{cell.listingStatus}</div>
            <SyncDot status={syncStatus} hasError={hasError} />
          </div>
          {cell.price != null && (
            <div className="tabular-nums text-sm mt-0.5 flex items-center gap-1">
              {cell.price.toFixed(2)}
              {drift != null && (
                <span className={drift > 0 ? 'text-emerald-600' : 'text-rose-600'} aria-hidden>
                  {drift > 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                </span>
              )}
            </div>
          )}
          {cell.quantity != null && (
            <div className="tabular-nums text-xs opacity-70">{cell.quantity} pcs</div>
          )}
          {cell.lastSyncError && (
            <div className="text-xs text-rose-600 mt-0.5 truncate" title={cell.lastSyncError}>
              ⚠ {cell.lastSyncError.slice(0, 24)}{cell.lastSyncError.length > 24 ? '…' : ''}
            </div>
          )}
        </button>
        <CellKebab
          open={menuOpen}
          onOpen={() => setMenuOpen(true)}
          onClose={() => setMenuOpen(false)}
          listingUrl={cell.listingUrl}
          channel={cell.channel}
          listingId={cell.id}
          productId={product.id}
          marketplace={cell.marketplace}
          isPublished={cell.isPublished}
          onOpenDrawer={onOpenDrawer}
          onSync={onSync}
        />
      </div>
    </Tooltip>
  )
}

// ────────────────────────────────────────────────────────────────────
// SyncDot — tiny status indicator inside a cell.
// IN_SYNC=green, SYNCING=amber-pulse, FAILED=red, otherwise gray.
// ────────────────────────────────────────────────────────────────────
function SyncDot({ status, hasError }: { status: string; hasError: boolean }) {
  if (hasError) return <span className="w-2 h-2 rounded-full bg-rose-500 flex-shrink-0" aria-hidden />
  if (status === 'IN_SYNC') return <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" aria-hidden />
  if (status === 'SYNCING' || status === 'PENDING') {
    return (
      <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0 animate-pulse" aria-hidden />
    )
  }
  return <span className="w-2 h-2 rounded-full bg-slate-300 flex-shrink-0" aria-hidden />
}

// ────────────────────────────────────────────────────────────────────
// CellKebab — per-cell action menu. Appears on hover/focus of the
// parent cell. Click outside or on an action to dismiss.
// ────────────────────────────────────────────────────────────────────
function CellKebab({
  open,
  onOpen,
  onClose,
  listingUrl,
  channel,
  listingId,
  productId,
  marketplace,
  isPublished,
  onOpenDrawer,
  onSync,
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  listingUrl: string | null
  channel: string
  listingId: string
  productId: string
  marketplace: string
  isPublished: boolean
  onOpenDrawer: () => void
  onSync: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  // Click-outside dismissal.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  return (
    <div ref={ref} className="absolute -top-1 -right-1">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          open ? onClose() : onOpen()
        }}
        aria-label="Cell actions"
        aria-expanded={open}
        aria-haspopup="menu"
        className="w-5 h-5 inline-flex items-center justify-center bg-white border border-slate-200 rounded-full text-slate-500 hover:text-slate-900 hover:border-slate-300 shadow-sm opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
      >
        <MoreHorizontal size={11} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-6 right-0 z-popover w-48 bg-white border border-slate-200 rounded-md shadow-lg py-1 text-left"
        >
          <KebabItem
            icon={Eye}
            label="View detail"
            onClick={() => {
              onClose()
              onOpenDrawer()
            }}
          />
          <KebabItem
            icon={RefreshCw}
            label="Sync now"
            onClick={() => {
              onClose()
              onSync()
            }}
          />
          {listingUrl && (
            <KebabItem
              icon={ExternalLink}
              label={`Open on ${channel.charAt(0) + channel.slice(1).toLowerCase()}`}
              onClick={() => {
                onClose()
                window.open(listingUrl, '_blank', 'noopener,noreferrer')
              }}
            />
          )}
          <KebabItem
            icon={Edit3}
            label="Open in editor"
            onClick={() => {
              onClose()
              window.location.href = `/products/${productId}/edit?channel=${channel}&marketplace=${marketplace}`
            }}
          />
          <div className="border-t border-slate-100 my-1" />
          <KebabItem
            icon={isPublished ? Pause : Play}
            label={isPublished ? 'Pause listing' : 'Resume listing'}
            onClick={async () => {
              onClose()
              await fetch(`${getBackendUrl()}/api/listings/bulk-action`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: isPublished ? 'unpublish' : 'publish',
                  listingIds: [listingId],
                }),
              })
              emitInvalidation({ type: 'listing.updated', id: listingId })
            }}
          />
        </div>
      )}
    </div>
  )
}

function KebabItem({
  icon: Icon,
  label,
  onClick,
}: {
  icon: any
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="w-full px-3 py-1.5 text-base text-slate-700 hover:bg-slate-50 inline-flex items-center gap-2"
    >
      <Icon size={12} className="text-slate-500" /> {label}
    </button>
  )
}

// ────────────────────────────────────────────────────────────────────
// EmptyMatrixCell — product is not listed on this (channel, marketplace).
// Click → list-wizard preset. The cell is the entry point for closing
// coverage gaps from the matrix view.
// ────────────────────────────────────────────────────────────────────
function EmptyMatrixCell({
  productId,
  channel,
  marketplace,
}: {
  productId: string
  channel: string
  marketplace: string
}) {
  const tooltipContent = (
    <div className="text-xs">
      Not listed on {channel} {marketplace}.
      <br />
      Click to publish.
    </div>
  )
  return (
    <Tooltip content={tooltipContent} delay={300}>
      <Link
        href={`/products/${productId}/list-wizard?channel=${channel}&marketplace=${marketplace}`}
        aria-label={`List on ${channel} ${marketplace}`}
        className="inline-flex items-center justify-center min-w-[100px] h-[44px] px-1.5 py-1 border border-dashed border-slate-200 rounded text-xs text-slate-300 hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50/40 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
      >
        <Plus size={12} className="mr-0.5" />
        <span className="text-xs uppercase tracking-wider">List</span>
      </Link>
    </Tooltip>
  )
}

// ────────────────────────────────────────────────────────────────────
// DraftsLens
// ────────────────────────────────────────────────────────────────────
function DraftsLens({ lockChannel, lockMarketplace, search }: { lockChannel?: string; lockMarketplace?: string; search: string; marketplaces: Marketplace[] }) {
  const [activeChannel, setActiveChannel] = useState<string>(lockChannel ?? 'AMAZON')

  // S.0.5 / H-4 — usePolledList migration. Drafts also listens for
  // wizard.submitted so when a wizard publish flips a draft to live the
  // count drops in this tab without waiting for the polling tick.
  const url = useMemo(() => {
    if (!activeChannel) return null
    const qs = new URLSearchParams({ channel: activeChannel })
    if (lockMarketplace) qs.set('marketplace', lockMarketplace)
    if (search) qs.set('search', search)
    return `/api/listings/drafts?${qs.toString()}`
  }, [activeChannel, lockMarketplace, search])
  const { data, loading } = usePolledList<any>({
    url,
    intervalMs: 30_000,
    invalidationTypes: [
      'listing.updated',
      'listing.created',
      'listing.deleted',
      'bulk-job.completed',
      'wizard.submitted',
      'wizard.deleted',
    ],
  })

  return (
    <div className="space-y-3">
      {!lockChannel && (
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-sm uppercase tracking-wider text-slate-500 mr-2">Drafts for:</span>
          {['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'].map((ch) => (
            <button
              key={ch}
              onClick={() => setActiveChannel(ch)}
              className={`h-7 px-3 text-sm border rounded inline-flex items-center transition-colors ${
                activeChannel === ch ? `${CHANNEL_TONE[ch]} font-semibold` : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
              }`}
            >{ch}</button>
          ))}
        </div>
      )}

      {loading && <Card><div className="text-md text-slate-500 py-8 text-center">Loading drafts…</div></Card>}

      {!loading && data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card title={`Drafts (${data.draftCount})`} description="Created but not yet published — review and publish.">
            {data.drafts.length === 0 ? (
              <div className="py-6 text-base text-slate-500 text-center">No drafts on this channel.</div>
            ) : (
              <ul className="space-y-1 -my-1">
                {data.drafts.slice(0, 25).map((d: any) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 py-2 px-3 -mx-3 rounded-md hover:bg-slate-50">
                    <div className="min-w-0 flex-1">
                      <div className="text-md text-slate-900 truncate">{d.product.name}</div>
                      <div className="text-sm text-slate-500 font-mono">{d.product.sku} · {d.marketplace}</div>
                    </div>
                    <Link
                      href={`/products/${d.productId}/list-wizard?channel=${d.channel}&marketplace=${d.marketplace}`}
                      className="h-7 px-3 text-sm bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100"
                    >Publish →</Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={`Uncovered products (${data.uncoveredCount})`} description={`Products not yet listed on ${activeChannel}.`}>
            {data.uncovered.length === 0 ? (
              <div className="py-6 text-base text-slate-500 text-center">All products covered.</div>
            ) : (
              <ul className="space-y-1 -my-1">
                {data.uncovered.slice(0, 25).map((p: any) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2 px-3 -mx-3 rounded-md hover:bg-slate-50">
                    <div className="min-w-0 flex-1">
                      <div className="text-md text-slate-900 truncate">{p.name}</div>
                      <div className="text-sm text-slate-500 font-mono">{p.sku}</div>
                    </div>
                    <Link
                      href={`/products/${p.id}/list-wizard?channel=${activeChannel}`}
                      className="h-7 px-3 text-sm bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100"
                    >List on {activeChannel.charAt(0) + activeChannel.slice(1).toLowerCase()} →</Link>
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
// ListingDrawer — slide-over detail panel
// ────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────
// ListingDrawer — S.2 rebuild
//
// Tabbed surface (Detail · Per-channel · Sync · Activity) replacing the
// prior single-page drawer. The drawer is a workspace-within-workspace
// for catalog ops: from a single panel you see the listing's current
// state, where else this product is live, and what's happening with
// sync — without leaving the matrix view.
// ────────────────────────────────────────────────────────────────────
type DrawerTab = 'detail' | 'channels' | 'sync' | 'activity'

function ListingDrawer({ id: initialId, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  // Internal id state lets the Per-channel tab switch context without
  // close/reopen flicker — click a companion → swap id → drawer reloads.
  const [id, setId] = useState(initialId)
  useEffect(() => setId(initialId), [initialId])

  const [listing, setListing] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<DrawerTab>('detail')
  const [actionPending, setActionPending] = useState<string | null>(null)

  const loadListing = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/${id}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setListing(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    loadListing()
  }, [loadListing])

  // Cross-tab invalidation: if another surface updates this listing
  // while the drawer is open, refresh.
  useInvalidationChannel(
    ['listing.updated', 'bulk-job.completed'],
    (event) => {
      // Filter — only refresh if the event is about this listing or
      // unscoped (bulk events). Avoid hammering on every product update.
      if (!event.id || event.id === id) loadListing()
    },
  )

  const patch = useCallback(async (body: any): Promise<boolean> => {
    if (!listing) return false
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, expectedVersion: listing.version }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setError(err?.error ?? `HTTP ${res.status}`)
        return false
      }
      onChanged()
      emitInvalidation({ type: 'listing.updated', id })
      await loadListing()
      return true
    } catch (e: any) {
      setError(e?.message ?? String(e))
      return false
    }
  }, [id, listing, loadListing, onChanged])

  const resync = async () => {
    setActionPending('resync')
    try {
      await fetch(`${getBackendUrl()}/api/listings/${id}/resync`, { method: 'POST' })
      onChanged()
      emitInvalidation({ type: 'listing.updated', id })
      await loadListing()
    } finally {
      setActionPending(null)
    }
  }

  const togglePublish = async () => {
    if (!listing) return
    setActionPending('publish')
    await patch({ isPublished: !listing.isPublished })
    setActionPending(null)
  }

  const tabs = useMemo(() => {
    const errorCount = listing?.lastSyncError ? 1 : 0
    return [
      { id: 'detail', label: 'Detail' },
      {
        id: 'channels',
        label: 'Per-channel',
        count: listing?.companions?.length,
      },
      { id: 'sync', label: 'Sync', count: errorCount > 0 ? errorCount : undefined },
      { id: 'activity', label: 'Activity' },
    ]
  }, [listing])

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={null}
      header={null}
      placement="drawer-right"
    >
      {loading && !listing ? (
        <ModalBody>
          <div className="space-y-4">
            <Skeleton variant="thumbnail" width={64} height={64} />
            <Skeleton variant="text" lines={2} />
            <Skeleton variant="block" height={120} />
            <Skeleton variant="block" height={80} />
          </div>
        </ModalBody>
      ) : error ? (
        <ModalBody>
          <div className="bg-rose-50 border border-rose-200 rounded-md p-3 space-y-2">
            <div className="text-sm font-semibold uppercase tracking-wider text-rose-700">Failed to load listing</div>
            <div className="text-base text-rose-700">{error}</div>
            <button
              onClick={loadListing}
              className="h-8 px-3 text-base bg-white text-rose-700 border border-rose-300 rounded hover:bg-rose-50 inline-flex items-center gap-1.5"
            >
              <RefreshCw size={12} /> Retry
            </button>
          </div>
        </ModalBody>
      ) : !listing ? (
        <ModalBody>
          <div className="text-base text-slate-500">Listing not found.</div>
        </ModalBody>
      ) : (
        <>
          {/* Header: thumbnail + name + channel/marketplace + action toolbar */}
          <div className="px-5 py-3 border-b border-slate-200 flex-shrink-0">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="flex items-start gap-3 min-w-0 flex-1">
                {listing.product?.images?.[0] && (
                  <img
                    src={listing.product.images[0]}
                    alt=""
                    className="w-12 h-12 rounded-md object-cover bg-slate-100 flex-shrink-0"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-md font-semibold text-slate-900 truncate">{listing.product?.name}</div>
                  <div className="text-sm text-slate-500 font-mono truncate">{listing.product?.sku}</div>
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${CHANNEL_TONE[listing.channel] ?? ''}`}>{listing.channel}</span>
                    <span className="font-mono text-sm font-semibold bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">{listing.marketplace}</span>
                    <StatusBadge status={listing.listingStatus} />
                    {listing.syncStatus && listing.syncStatus !== 'IDLE' && (
                      <StatusBadge status={listing.syncStatus} />
                    )}
                  </div>
                </div>
              </div>
              <IconButton aria-label="Close" onClick={onClose} size="md">
                <X size={14} />
              </IconButton>
            </div>

            {/* Action toolbar */}
            <div className="flex items-center gap-1 flex-wrap">
              <Tooltip content="Pull latest state from the marketplace">
                <button
                  onClick={resync}
                  disabled={actionPending === 'resync'}
                  className="h-7 px-2.5 text-sm bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <RefreshCw size={11} className={actionPending === 'resync' ? 'animate-spin' : ''} />
                  Sync
                </button>
              </Tooltip>
              <Tooltip content={listing.isPublished ? 'Pause this listing on the marketplace' : 'Resume this listing'}>
                <button
                  onClick={togglePublish}
                  disabled={actionPending === 'publish'}
                  className="h-7 px-2.5 text-sm bg-white text-slate-700 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {listing.isPublished ? <Pause size={11} /> : <Play size={11} />}
                  {listing.isPublished ? 'Pause' : 'Resume'}
                </button>
              </Tooltip>
              {listing.listingUrl && (
                <Tooltip content={`Open on ${listing.channel.toLowerCase()}`}>
                  <a
                    href={listing.listingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="h-7 px-2.5 text-sm bg-white text-slate-700 border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
                  >
                    <ExternalLink size={11} />
                    On marketplace
                  </a>
                </Tooltip>
              )}
              <Link
                href={`/products/${listing.productId}/edit?channel=${listing.channel}&marketplace=${listing.marketplace}`}
                className="h-7 px-2.5 text-sm bg-white text-slate-700 border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
              >
                <Edit3 size={11} />
                Open in editor
              </Link>
            </div>
          </div>

          {/* Tabs */}
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onChange={(t) => setActiveTab(t as DrawerTab)}
            className="px-5 flex-shrink-0"
          />

          <ModalBody>
            {activeTab === 'detail' && <DetailTab listing={listing} patch={patch} />}
            {activeTab === 'channels' && (
              <ChannelsTab
                listing={listing}
                onSwitchListing={(newId) => {
                  setId(newId)
                  setActiveTab('detail')
                }}
              />
            )}
            {activeTab === 'sync' && (
              <SyncTab listing={listing} resyncing={actionPending === 'resync'} onResync={resync} />
            )}
            {activeTab === 'activity' && <ActivityTab listing={listing} />}
          </ModalBody>
        </>
      )}
    </Modal>
  )
}

// ────────────────────────────────────────────────────────────────────
// DetailTab — master vs channel side-by-side, follow toggles, pricing
// ────────────────────────────────────────────────────────────────────
function DetailTab({ listing, patch }: { listing: any; patch: (body: any) => Promise<boolean> }) {
  const [editingRule, setEditingRule] = useState(false)
  const [editingBuffer, setEditingBuffer] = useState(false)
  const [editingPercent, setEditingPercent] = useState(false)

  // S.3 — HealthPanel quick-fix dispatchers wired to existing endpoints.
  const healthHandlers = useMemo(
    () => ({
      onResync: async () => {
        await fetch(`${getBackendUrl()}/api/listings/${listing.id}/resync`, { method: 'POST' })
        emitInvalidation({ type: 'listing.updated', id: listing.id })
      },
      onSnapMaster: async (field: 'price' | 'quantity' | 'title') => {
        const key = field === 'price' ? 'followMasterPrice' : field === 'quantity' ? 'followMasterQuantity' : 'followMasterTitle'
        await patch({ [key]: true })
      },
      onEdit: () => {
        window.location.href = `/products/${listing.productId}/edit?channel=${listing.channel}&marketplace=${listing.marketplace}`
      },
      onViewMarketplace: () => {
        if (listing.listingUrl) window.open(listing.listingUrl, '_blank', 'noopener,noreferrer')
      },
    }),
    [listing.id, listing.productId, listing.channel, listing.marketplace, listing.listingUrl, patch],
  )

  const masterPrice = listing.product?.basePrice ?? listing.masterPrice
  const channelPrice = listing.price
  const priceDrift =
    masterPrice != null && channelPrice != null
      ? Number(channelPrice) - Number(masterPrice)
      : null

  const expectedQuantity =
    listing.product?.totalStock != null
      ? Math.max(0, Number(listing.product.totalStock) - (listing.stockBuffer ?? 0))
      : null
  const channelQuantity = listing.quantity
  const quantityDrift =
    expectedQuantity != null && channelQuantity != null
      ? channelQuantity - expectedQuantity
      : null

  return (
    <div className="space-y-4">
      {/* S.3 — HealthPanel replaces the prior flat lastSyncError +
          validationErrors blocks. Health is computed server-side and
          carries categorized issues with quick-fix actions. */}
      {listing.health && (
        <HealthPanel health={listing.health} handlers={healthHandlers} />
      )}

      {/* Master vs channel — Price */}
      <FieldComparison
        label="Price"
        masterValue={masterPrice != null ? Number(masterPrice).toFixed(2) : '—'}
        channelValue={channelPrice != null ? Number(channelPrice).toFixed(2) : '—'}
        followingMaster={listing.followMasterPrice}
        drifted={priceDrift != null && priceDrift !== 0}
        driftLabel={
          priceDrift != null
            ? `${priceDrift > 0 ? '+' : ''}${priceDrift.toFixed(2)} vs master`
            : null
        }
        onSnapToMaster={async () => {
          await patch({ followMasterPrice: true })
        }}
        onUnfollow={async () => {
          await patch({ followMasterPrice: false })
        }}
      />

      {/* Master vs channel — Quantity */}
      <FieldComparison
        label="Quantity"
        masterValue={
          expectedQuantity != null
            ? `${expectedQuantity} (${listing.product?.totalStock ?? 0} stock − ${listing.stockBuffer ?? 0} buffer)`
            : '—'
        }
        channelValue={channelQuantity != null ? String(channelQuantity) : '—'}
        followingMaster={listing.followMasterQuantity}
        drifted={quantityDrift != null && quantityDrift !== 0}
        driftLabel={
          quantityDrift != null
            ? `${quantityDrift > 0 ? '+' : ''}${quantityDrift} vs expected`
            : null
        }
        onSnapToMaster={async () => {
          await patch({ followMasterQuantity: true })
        }}
        onUnfollow={async () => {
          await patch({ followMasterQuantity: false })
        }}
      />

      {/* Master vs channel — Title (no edit; just visibility — heavy
          editing belongs in /products/:id/edit) */}
      <FieldComparison
        label="Title"
        masterValue={listing.product?.name ?? listing.masterTitle ?? '—'}
        channelValue={listing.title ?? listing.product?.name ?? '—'}
        followingMaster={listing.followMasterTitle}
        drifted={
          listing.title != null &&
          listing.title !== (listing.product?.name ?? listing.masterTitle)
        }
        driftLabel={null}
        onSnapToMaster={async () => {
          await patch({ followMasterTitle: true })
        }}
        onUnfollow={async () => {
          await patch({ followMasterTitle: false })
        }}
        compact
      />

      {/* Pricing rule + adjustment percent — drawer-level inline edits */}
      <div className="grid grid-cols-2 gap-3 pt-2">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-0.5">Pricing rule</div>
          {editingRule ? (
            <select
              value={listing.pricingRule ?? 'FIXED'}
              onChange={async (e) => {
                await patch({ pricingRule: e.target.value })
                setEditingRule(false)
              }}
              onBlur={() => setEditingRule(false)}
              autoFocus
              className="h-7 px-1 text-base border border-blue-400 rounded text-slate-900 bg-white"
            >
              <option value="FIXED">FIXED</option>
              <option value="MATCH_AMAZON">MATCH_AMAZON</option>
              <option value="PERCENT_OF_MASTER">PERCENT_OF_MASTER</option>
            </select>
          ) : (
            <InlineEditTrigger label="pricing rule" onClick={() => setEditingRule(true)}>
              <span className="text-base text-slate-900">{listing.pricingRule ?? '—'}</span>
            </InlineEditTrigger>
          )}
        </div>
        {listing.pricingRule === 'PERCENT_OF_MASTER' && (
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-0.5">Adjustment %</div>
            {editingPercent ? (
              <Input
                type="number"
                step="0.01"
                defaultValue={listing.priceAdjustmentPercent ?? 0}
                autoFocus
                onBlur={async (e) => {
                  await patch({ priceAdjustmentPercent: Number(e.currentTarget.value) })
                  setEditingPercent(false)
                }}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter') {
                    await patch({ priceAdjustmentPercent: Number(e.currentTarget.value) })
                    setEditingPercent(false)
                  } else if (e.key === 'Escape') {
                    setEditingPercent(false)
                  }
                }}
                className="h-7 text-base"
              />
            ) : (
              <InlineEditTrigger label="adjustment percent" onClick={() => setEditingPercent(true)}>
                <span className="text-base text-slate-900 tabular-nums">
                  {listing.priceAdjustmentPercent != null ? `${listing.priceAdjustmentPercent}%` : '—'}
                </span>
              </InlineEditTrigger>
            )}
          </div>
        )}
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-0.5">Stock buffer</div>
          {editingBuffer ? (
            <Input
              type="number"
              min="0"
              defaultValue={listing.stockBuffer ?? 0}
              autoFocus
              onBlur={async (e) => {
                await patch({ stockBuffer: Number(e.currentTarget.value) })
                setEditingBuffer(false)
              }}
              onKeyDown={async (e) => {
                if (e.key === 'Enter') {
                  await patch({ stockBuffer: Number(e.currentTarget.value) })
                  setEditingBuffer(false)
                } else if (e.key === 'Escape') {
                  setEditingBuffer(false)
                }
              }}
              className="h-7 text-base"
            />
          ) : (
            <InlineEditTrigger label="stock buffer" onClick={() => setEditingBuffer(true)}>
              <span className="text-base text-slate-900 tabular-nums">
                {listing.stockBuffer ?? 0} units reserved
              </span>
            </InlineEditTrigger>
          )}
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-0.5">External ID</div>
          <div className="text-base font-mono text-slate-900 truncate" title={listing.externalListingId ?? ''}>
            {listing.externalListingId ?? '—'}
          </div>
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// FieldComparison — master / channel side-by-side with drift indicator
// ────────────────────────────────────────────────────────────────────
function FieldComparison({
  label,
  masterValue,
  channelValue,
  followingMaster,
  drifted,
  driftLabel,
  onSnapToMaster,
  onUnfollow,
  compact,
}: {
  label: string
  masterValue: string
  channelValue: string
  followingMaster: boolean
  drifted: boolean
  driftLabel: string | null
  onSnapToMaster: () => Promise<void>
  onUnfollow: () => Promise<void>
  compact?: boolean
}) {
  return (
    <div className={`border border-slate-200 rounded-md p-3 ${drifted && !followingMaster ? 'bg-amber-50/40' : 'bg-white'}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-sm font-semibold uppercase tracking-wider text-slate-700">{label}</div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={followingMaster ? onUnfollow : onSnapToMaster}
            className={`h-6 px-2 text-xs rounded inline-flex items-center gap-1 transition-colors ${
              followingMaster
                ? 'bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
            }`}
            aria-label={followingMaster ? `Unfollow master ${label.toLowerCase()}` : `Follow master ${label.toLowerCase()}`}
          >
            <Link2 size={10} />
            {followingMaster ? 'Following master' : 'Follow master'}
          </button>
        </div>
      </div>
      <div className={`grid grid-cols-2 gap-3 ${compact ? 'text-sm' : 'text-base'}`}>
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-400 font-medium mb-0.5">Master</div>
          <div className="text-slate-700 truncate" title={masterValue}>{masterValue}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-400 font-medium mb-0.5">
            Channel
            {drifted && (
              <span className="ml-1.5 text-amber-700 normal-case font-semibold">drifted</span>
            )}
          </div>
          <div className="text-slate-900 truncate" title={channelValue}>{channelValue}</div>
        </div>
      </div>
      {driftLabel && drifted && (
        <div className="mt-2 text-xs text-amber-700">{driftLabel}</div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// ChannelsTab — companions: this product across all channels
// ────────────────────────────────────────────────────────────────────
function ChannelsTab({
  listing,
  onSwitchListing,
}: {
  listing: any
  onSwitchListing: (id: string) => void
}) {
  const companions = (listing.companions ?? []) as any[]
  return (
    <div className="space-y-3">
      <div className="text-sm text-slate-600">
        This product is on <span className="font-semibold">{companions.length + 1}</span> channel/marketplace combo{companions.length === 0 ? '' : 's'}.
      </div>

      {/* Self */}
      <CompanionCard
        channel={listing.channel}
        marketplace={listing.marketplace}
        listingStatus={listing.listingStatus}
        syncStatus={listing.syncStatus}
        price={listing.price}
        quantity={listing.quantity}
        lastSyncError={listing.lastSyncError}
        listingUrl={listing.listingUrl}
        isCurrent
      />

      {/* Companions */}
      {companions.map((c) => (
        <CompanionCard
          key={c.id}
          channel={c.channel}
          marketplace={c.marketplace}
          listingStatus={c.listingStatus}
          syncStatus={c.syncStatus}
          price={c.price}
          quantity={c.quantity}
          lastSyncError={c.lastSyncError}
          listingUrl={c.listingUrl}
          onClick={() => onSwitchListing(c.id)}
        />
      ))}

      {companions.length === 0 && (
        <div className="border border-dashed border-slate-300 rounded-md py-6 text-center text-sm text-slate-500">
          No other channel listings for this product yet.
          <div className="mt-2">
            <Link
              href={`/products/${listing.productId}/list-wizard`}
              className="inline-flex items-center gap-1.5 text-blue-600 hover:underline"
            >
              <Plus size={11} /> List on another channel
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

function CompanionCard({
  channel,
  marketplace,
  listingStatus,
  syncStatus,
  price,
  quantity,
  lastSyncError,
  listingUrl,
  onClick,
  isCurrent,
}: {
  channel: string
  marketplace: string
  listingStatus: string
  syncStatus?: string | null
  price: number | null
  quantity: number | null
  lastSyncError?: string | null
  listingUrl?: string | null
  onClick?: () => void
  isCurrent?: boolean
}) {
  const Inner = (
    <div className={`flex items-center gap-3 p-2.5 border rounded-md ${isCurrent ? 'border-blue-300 bg-blue-50/50' : 'border-slate-200 bg-white hover:bg-slate-50 cursor-pointer'}`}>
      <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${CHANNEL_TONE[channel] ?? ''} flex-shrink-0`}>
        {channel}
      </span>
      <span className="font-mono text-sm font-semibold bg-slate-100 px-1.5 py-0.5 rounded text-slate-700 flex-shrink-0">
        {marketplace}
      </span>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <StatusBadge status={listingStatus} />
        {syncStatus && syncStatus !== 'IDLE' && <StatusBadge status={syncStatus} />}
      </div>
      <div className="ml-auto flex items-center gap-3 text-sm tabular-nums">
        {price != null && <span className="text-slate-700">{Number(price).toFixed(2)}</span>}
        {quantity != null && <span className="text-slate-500">{quantity} pcs</span>}
        {isCurrent ? (
          <Badge variant="info" size="sm">Current</Badge>
        ) : (
          <ArrowUpRight size={12} className="text-slate-400" />
        )}
      </div>
    </div>
  )
  if (isCurrent) return <div>{Inner}{lastSyncError && <ErrorRow error={lastSyncError} />}</div>
  return (
    <div>
      <button onClick={onClick} className="w-full text-left">{Inner}</button>
      {lastSyncError && <ErrorRow error={lastSyncError} />}
      {listingUrl && (
        <a
          href={listingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline ml-3 mt-0.5 inline-flex items-center gap-1"
        >
          <ExternalLink size={9} /> Open on marketplace
        </a>
      )}
    </div>
  )
}

function ErrorRow({ error }: { error: string }) {
  return (
    <div className="text-xs text-rose-700 mt-1 ml-3 truncate" title={error}>
      ⚠ {error}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// SyncTab — sync state, history, and re-pull action
// ────────────────────────────────────────────────────────────────────
function SyncTab({
  listing,
  resyncing,
  onResync,
}: {
  listing: any
  resyncing: boolean
  onResync: () => Promise<void>
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 p-3 border border-slate-200 rounded-md bg-slate-50">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-0.5">Current sync state</div>
          <div className="flex items-center gap-2">
            <StatusBadge status={listing.syncStatus ?? 'IDLE'} />
            {listing.lastSyncStatus && (
              <span className="text-sm text-slate-600">
                last attempt: <StatusBadge status={listing.lastSyncStatus} />
              </span>
            )}
          </div>
          <div className="text-sm text-slate-500 mt-1">
            {listing.lastSyncedAt
              ? `Last synced ${new Date(listing.lastSyncedAt).toLocaleString()}`
              : 'Never synced'}
          </div>
          {listing.syncRetryCount > 0 && (
            <div className="text-sm text-slate-500 mt-0.5">
              Retry count: <span className="tabular-nums">{listing.syncRetryCount}</span>
            </div>
          )}
        </div>
        <button
          onClick={onResync}
          disabled={resyncing}
          className="h-9 px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <RefreshCw size={12} className={resyncing ? 'animate-spin' : ''} />
          {resyncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      {listing.lastSyncError && (
        <div className="bg-rose-50 border border-rose-200 rounded-md p-3">
          <div className="text-sm font-semibold uppercase tracking-wider text-rose-700 mb-1">Last sync error</div>
          <div className="text-base text-rose-700 whitespace-pre-wrap">{listing.lastSyncError}</div>
        </div>
      )}

      {/* Real sync history requires a SyncAttempt table that doesn't
          exist yet — TECH_DEBT. For now, surface what we know from the
          listing's own fields as a single-entry timeline. */}
      <div>
        <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-2">Recent activity</div>
        <div className="border-l-2 border-slate-200 pl-3 space-y-3">
          {listing.lastSyncedAt && (
            <TimelineEntry
              status={listing.lastSyncStatus ?? 'UNKNOWN'}
              when={listing.lastSyncedAt}
              detail={
                listing.lastSyncStatus === 'SUCCESS'
                  ? 'Successfully pulled latest state from channel'
                  : listing.lastSyncError ?? 'Sync attempt'
              }
            />
          )}
          <TimelineEntry
            status="CREATED"
            when={listing.createdAt}
            detail={`Listing record created (version ${listing.version})`}
          />
        </div>
        <div className="text-xs text-slate-400 mt-3 italic">
          Full sync history requires the SyncAttempt audit table — coming with S.4 inbound queue.
        </div>
      </div>
    </div>
  )
}

function TimelineEntry({
  status,
  when,
  detail,
}: {
  status: string
  when: string
  detail: string
}) {
  return (
    <div className="relative">
      <div className={`absolute -left-[17px] top-0.5 w-3 h-3 rounded-full border-2 ${
        status === 'SUCCESS' ? 'bg-emerald-500 border-emerald-200'
        : status === 'FAILED' ? 'bg-rose-500 border-rose-200'
        : 'bg-slate-300 border-slate-100'
      }`} />
      <div className="text-base text-slate-700">{detail}</div>
      <div className="text-xs text-slate-500 tabular-nums mt-0.5">
        {new Date(when).toLocaleString()}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// ActivityTab — basic listing-level metadata (real audit log = future)
// ────────────────────────────────────────────────────────────────────
function ActivityTab({ listing }: { listing: any }) {
  return (
    <div className="space-y-4">
      <div className="text-sm text-slate-600">
        Listing-level activity. A full per-field audit log requires a dedicated
        ChannelListingActivity table (TECH_DEBT — coming with S.5 deep view).
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Detail label="Created" value={new Date(listing.createdAt).toLocaleString()} />
        <Detail label="Last updated" value={new Date(listing.updatedAt).toLocaleString()} />
        <Detail label="Version" value={listing.version} />
        <Detail label="Validation status" value={listing.validationStatus} />
        {listing.product?.brand && <Detail label="Brand" value={listing.product.brand} />}
        {listing.variationTheme && <Detail label="Variation theme" value={listing.variationTheme} />}
      </div>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: any }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">{label}</div>
      <div className="text-base text-slate-900 mt-0.5">{String(value)}</div>
    </div>
  )
}
