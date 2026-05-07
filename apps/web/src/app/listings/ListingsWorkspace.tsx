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
  Edit3, Bookmark, BookmarkPlus, Star, Trash2,
  Download, FilterX, AlertCircle, Activity, TrendingUp,
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
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import { COUNTRY_NAMES } from '@/lib/country-names'
import { getBackendUrl } from '@/lib/backend-url'
import { usePolledList } from '@/lib/sync/use-polled-list'
import {
  emitInvalidation,
  useInvalidationChannel,
} from '@/lib/sync/invalidation-channel'
import { useListingEvents } from '@/lib/sync/use-listing-events'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'

// ── Types ───────────────────────────────────────────────────────────
type Lens = 'grid' | 'health' | 'matrix' | 'drafts' | 'performance'

// C.11 — saved view shape returned by /api/saved-views?surface=listings.
// Mirrors the /products SavedView used by ProductsWorkspace; alerts
// integration isn't wired for /listings yet so alertSummary is
// optional and treated as 0 when absent.
type SavedListingsView = {
  id: string
  userId: string
  surface: string
  name: string
  filters: Record<string, unknown>
  isDefault: boolean
  createdAt: string
  updatedAt: string
  alertSummary?: { active: number; total: number; firedRecently: number }
}

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

  // U.1 — keyboard navigation on the grid lens. activeRowIndex tracks
  // which row j/k has highlighted; -1 = no active row (default).
  // Enter on the active row opens the drawer; / focuses search; Esc
  // closes drawer or clears search; ? opens the shortcuts help modal.
  // Search input is targeted by id (no ref drilling through FilterBar).
  const [activeRowIndex, setActiveRowIndex] = useState(-1)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  // C.11 — saved views. Re-uses the existing /api/saved-views CRUD
  // shipped for /products (P.3); the SavedView model has a `surface`
  // discriminator so /listings rows are scoped separately. The
  // dropdown sits in the lens-switcher row; auto-apply on first
  // mount only when the URL has no filter state, so a deep link with
  // ?listingStatus=ERROR (e.g. dashboard alert click) wins over the
  // default view.
  const [savedViews, setSavedViews] = useState<SavedListingsView[]>([])
  const [savedViewMenuOpen, setSavedViewMenuOpen] = useState(false)
  const appliedDefaultRef = useRef(false)
  const fetchSavedViews = useCallback(async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/saved-views?surface=listings`,
        { cache: 'no-store' },
      )
      if (!res.ok) return
      const data = await res.json()
      setSavedViews(data.items ?? [])
    } catch {
      /* swallow — header dropdown must never crash the workspace */
    }
  }, [])
  useEffect(() => { fetchSavedViews() }, [fetchSavedViews])
  useInvalidationChannel(['saved-view.changed'], () => { fetchSavedViews() })

  // Auto-apply default view on first mount when the URL has no filter
  // state. A deep link (e.g. dashboard alert) with ?listingStatus=ERROR
  // bypasses the default — the link's intent wins.
  useEffect(() => {
    if (appliedDefaultRef.current) return
    if (savedViews.length === 0) return
    if (searchParams.toString().length > 0) {
      appliedDefaultRef.current = true
      return
    }
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

  // Toast for save-view failures (lock conflicts, network errors).
  const savedViewToast = useToast()

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

  // U.1 — global keyboard shortcuts on the grid lens. Skipped when
  // the operator is typing into an input/textarea/select (otherwise
  // the search field would intercept its own keystrokes). The drawer
  // and modals own their own keyboard semantics — `Escape` closes
  // them, `Enter` submits — so we only act on j/k/?/space when no
  // modal is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't fight inputs.
      const tag = (e.target as HTMLElement)?.tagName
      const inEditable =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (e.target as HTMLElement)?.isContentEditable
      if (inEditable) {
        // Allow Esc to clear the search input even from the input itself.
        if (e.key === 'Escape' && tag === 'INPUT' && searchInput) {
          // The input owns its own clear; let it ride.
        }
        return
      }
      // Cmd/Ctrl combos go to the global palette etc., not us.
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
        return
      }
      if (e.key === '/') {
        e.preventDefault()
        const input = document.getElementById('listings-search') as HTMLInputElement | null
        input?.focus()
        input?.select()
        return
      }
      if (e.key === 'Escape') {
        if (drawerListingId) {
          setDrawerListingId(null)
        } else if (shortcutsOpen) {
          setShortcutsOpen(false)
        } else if (searchInput) {
          setSearchInput('')
        } else {
          setActiveRowIndex(-1)
        }
        return
      }

      // The remaining shortcuts only apply on the grid lens — j/k/Enter
      // navigate rows, which only the table renders.
      if (lens !== 'grid') return

      const rows = grid.listings.length
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveRowIndex((i) => Math.min(i + 1, rows - 1))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveRowIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        if (activeRowIndex >= 0 && activeRowIndex < rows) {
          e.preventDefault()
          setDrawerListingId(grid.listings[activeRowIndex].id)
        }
      } else if (e.key === ' ') {
        if (activeRowIndex >= 0 && activeRowIndex < rows) {
          e.preventDefault()
          const id = grid.listings[activeRowIndex].id
          setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }
      } else if (e.key === 'g') {
        // 'g' alone — first half of "go to top". Capture next g via
        // a one-tick window; fallthrough means single-press is a no-op
        // (consistent with Linear / Gmail vim-like double-key chords).
        const handleSecond = (ev: KeyboardEvent) => {
          if (ev.key === 'g') {
            ev.preventDefault()
            setActiveRowIndex(0)
          }
          window.removeEventListener('keydown', handleSecond, true)
        }
        window.addEventListener('keydown', handleSecond, true)
        setTimeout(() => {
          window.removeEventListener('keydown', handleSecond, true)
        }, 800)
      } else if (e.key === 'G' && e.shiftKey === false) {
        // Note: shift-g comes through as 'G' on most browsers — we
        // accept either way to mean "jump to last row" (vim semantic).
        e.preventDefault()
        setActiveRowIndex(Math.max(0, rows - 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lens, grid.listings, activeRowIndex, drawerListingId, shortcutsOpen, searchInput, setSearchInput, setSelected])

  // S.4 — open the SSE stream for the lifetime of this workspace. The
  // hook self-dispatches every event into the invalidation channel, so
  // the grid / matrix / drawer just refresh as if a 200ms polling
  // cycle had fired. `connected` powers the live indicator below.
  const { connected: sseConnected } = useListingEvents()

  // C.12 — t() for the workspace's own visible strings; child
  // components grab their own useTranslations() so they don't need
  // prop drilling.
  const { t } = useTranslations()


  return (
    <div className="space-y-5">
      <PageHeader
        title={title}
        description={description}
        breadcrumbs={breadcrumbs}
      />

      {/* Lens switcher + saved views menu + global stats strip */}
      <div className="flex items-center gap-2 flex-wrap">
        <LensTabs
          current={lens}
          onChange={(next) => updateUrl({ lens: next === 'grid' ? undefined : next, page: undefined })}
        />
        <SavedViewsButton
          open={savedViewMenuOpen}
          setOpen={setSavedViewMenuOpen}
          views={savedViews}
          onApply={(view) => {
            const f = (view.filters ?? {}) as Record<string, unknown>
            const next = new URLSearchParams()
            for (const [k, v] of Object.entries(f)) {
              if (v == null || v === '') continue
              next.set(k, Array.isArray(v) ? v.join(',') : String(v))
            }
            router.replace(`${pathname}?${next.toString()}`, { scroll: false })
            setSavedViewMenuOpen(false)
          }}
          onSaveCurrent={async (name, isDefault) => {
            // Capture every URL-driven filter. Lens, sort, page +
            // every chip group + every toggle. This is exactly what
            // updateUrl writes; the apply path reverses it.
            const filters: Record<string, unknown> = {}
            if (search) filters.search = search
            if (lens !== 'grid') filters.lens = lens
            if (sortBy !== 'updatedAt') filters.sortBy = sortBy
            if (sortDir !== 'desc') filters.sortDir = sortDir
            if (channelFilters.length && !lockChannel) filters.channel = channelFilters
            if (marketplaceFilters.length && !lockMarketplace) filters.marketplace = marketplaceFilters
            if (statusFilters.length) filters.listingStatus = statusFilters
            if (syncStatusFilters.length) filters.syncStatus = syncStatusFilters
            if (hasError) filters.hasError = 'true'
            if (lowStock) filters.lowStock = 'true'
            if (publishedOnly) filters.published = 'true'
            const res = await fetch(`${getBackendUrl()}/api/saved-views`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, surface: 'listings', filters, isDefault }),
            })
            if (res.ok) {
              fetchSavedViews()
              emitInvalidation({
                type: 'saved-view.changed',
                meta: { surface: 'listings', action: 'created' },
              })
              return true
            }
            const err = await res.json().catch(() => ({}))
            savedViewToast.toast.error(err.error ?? t('listings.savedViews.saveFailed'))
            return false
          }}
          onDelete={async (id) => {
            await fetch(`${getBackendUrl()}/api/saved-views/${id}`, {
              method: 'DELETE',
            })
            fetchSavedViews()
            emitInvalidation({
              type: 'saved-view.changed',
              id,
              meta: { surface: 'listings', action: 'deleted' },
            })
          }}
          onSetDefault={async (id) => {
            await fetch(`${getBackendUrl()}/api/saved-views/${id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ isDefault: true }),
            })
            fetchSavedViews()
            emitInvalidation({
              type: 'saved-view.changed',
              id,
              meta: { surface: 'listings', action: 'set-default' },
            })
          }}
        />
        <div className="ml-auto flex items-center gap-3">
          {/* S.4 — live indicator. Green pulse = SSE connected (sub-200ms updates). */}
          <Tooltip
            content={
              sseConnected
                ? t('listings.live.tooltipConnected')
                : t('listings.live.tooltipDisconnected')
            }
          >
            <span
              className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider text-slate-500"
              aria-label={sseConnected ? t('listings.live.tooltipConnected') : t('listings.live.tooltipDisconnected')}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  sseConnected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'
                }`}
                aria-hidden
              />
              {sseConnected ? t('listings.live') : t('listings.polling')}
            </span>
          </Tooltip>
          {facets && (
            <div className="flex items-center gap-3 text-base text-slate-500">
              <span><span className="font-semibold text-slate-700 tabular-nums">{facets.total}</span> {t('listings.stats.total')}</span>
              <span className="text-slate-300">·</span>
              <span className={facets.errorCount > 0 ? 'text-rose-600' : ''}>
                <span className="font-semibold tabular-nums">{facets.errorCount}</span> {t('listings.stats.errors')}
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

      {/* U.1 — Quick filter presets. One-click pills for the
          high-frequency filter combos operators reach for daily.
          Sit above the chip-based FilterBar; clicking a preset
          rewrites URL state via updateUrl, so refreshing the page
          or sharing the link preserves the preset. Active state is
          derived from URL — a preset highlights when its filter
          combo matches the current URL. */}
      {lens === 'grid' && (
        <QuickPresets
          activeStatuses={statusFilters}
          activeSyncStatuses={syncStatusFilters}
          hasError={hasError}
          lowStock={lowStock}
          publishedOnly={publishedOnly}
          updateUrl={updateUrl}
        />
      )}

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
          activeFilterCount={
            channelFilters.length +
            marketplaceFilters.length +
            statusFilters.length +
            syncStatusFilters.length +
            (hasError ? 1 : 0) +
            (lowStock ? 1 : 0) +
            (publishedOnly ? 1 : 0)
          }
          search={search}
          onClearFilters={() => {
            setSearchInput('')
            updateUrl({
              search: undefined,
              channel: lockChannel ? undefined : undefined,
              marketplace: lockMarketplace ? undefined : undefined,
              listingStatus: undefined,
              syncStatus: undefined,
              hasError: undefined,
              lowStock: undefined,
              published: undefined,
              page: undefined,
            })
          }}
          onListingChanged={() => { fetchGrid(); fetchFacets() }}
          activeRowIndex={activeRowIndex}
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

      {lens === 'performance' && (
        <PerformanceLens
          lockChannel={lockChannel}
          lockMarketplace={lockMarketplace}
          onOpenDrawer={(id) => setDrawerListingId(id)}
        />
      )}

      {/* Detail drawer */}
      {drawerListingId && (
        <ListingDrawer id={drawerListingId} onClose={() => setDrawerListingId(null)} onChanged={() => { fetchGrid(); fetchFacets() }} />
      )}

      {/* U.1 — keyboard shortcuts help modal (`?` toggles). */}
      {shortcutsOpen && (
        <KeyboardShortcutsHelp onClose={() => setShortcutsOpen(false)} />
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// LensTabs
// ────────────────────────────────────────────────────────────────────
function LensTabs({ current, onChange }: { current: Lens; onChange: (l: Lens) => void }) {
  const { t } = useTranslations()
  const tabs: Array<{ key: Lens; labelKey: string; icon: any }> = [
    { key: 'grid', labelKey: 'listings.lens.grid', icon: Boxes },
    { key: 'health', labelKey: 'listings.lens.health', icon: AlertTriangle },
    { key: 'matrix', labelKey: 'listings.lens.matrix', icon: LayoutGrid },
    { key: 'drafts', labelKey: 'listings.lens.drafts', icon: Sparkles },
    { key: 'performance', labelKey: 'listings.lens.performance', icon: Activity },
  ]
  return (
    <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={`h-7 px-3 text-base font-medium inline-flex items-center gap-1.5 rounded transition-colors ${
            current === tab.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <tab.icon size={12} />
          {t(tab.labelKey)}
        </button>
      ))}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// InlineNumberCell — U.1.
// Click-to-edit numeric cell rendered inside the grid for price /
// quantity columns. At rest it shows the formatted value (or "—" if
// null); on click it swaps to a small input. Enter or blur saves via
// PATCH /api/listings/:id with optimistic concurrency (sends the
// listing's `version` so a stale tab doesn't overwrite a fresh edit
// from another tab). 409 surfaces as a "Reload required" toast; the
// caller's onSaved refreshes the grid on success so the new value
// reads through cleanly.
// ────────────────────────────────────────────────────────────────────
function InlineNumberCell({
  value,
  listingId,
  version,
  field,
  align = 'right',
  integer = false,
  format,
  tone,
  subline,
  subTone,
  onSaved,
}: {
  value: number | null
  listingId: string
  version: number
  field: 'price' | 'quantity'
  align?: 'left' | 'right'
  integer?: boolean
  format: (n: number) => string
  tone?: string
  subline?: string | null
  subTone?: 'rose' | 'amber'
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>(value != null ? String(value) : '')
  const [busy, setBusy] = useState(false)

  // Keep draft in sync with upstream value when not editing — the
  // 30s polling can land a fresh value while the cell sits idle.
  useEffect(() => {
    if (!editing) setDraft(value != null ? String(value) : '')
  }, [value, editing])

  const commit = useCallback(async () => {
    const trimmed = draft.trim()
    if (trimmed === '' || trimmed === (value != null ? String(value) : '')) {
      setEditing(false)
      return
    }
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0) {
      toast.error(
        field === 'price' ? 'Price must be a non-negative number' : 'Quantity must be a non-negative integer',
      )
      setEditing(false)
      setDraft(value != null ? String(value) : '')
      return
    }
    const finalValue = integer ? Math.round(n) : n
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listings/${listingId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: finalValue, expectedVersion: version }),
        },
      )
      if (res.status === 409) {
        toast.error('Listing changed in another tab — reload to see the latest')
        setEditing(false)
        setDraft(value != null ? String(value) : '')
        return
      }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      toast.success(`${field === 'price' ? 'Price' : 'Stock'} updated`)
      emitInvalidation({
        type: 'listing.updated',
        id: listingId,
        meta: { source: 'inline-edit', field },
      })
      onSaved()
      setEditing(false)
    } catch (e: any) {
      toast.error(`Save failed: ${e?.message ?? String(e)}`)
      setEditing(false)
      setDraft(value != null ? String(value) : '')
    } finally {
      setBusy(false)
    }
  }, [draft, value, field, listingId, version, integer, toast, onSaved])

  if (editing) {
    return (
      <div className={`tabular-nums ${align === 'right' ? 'text-right' : 'text-left'}`}>
        <input
          type="number"
          step={integer ? '1' : '0.01'}
          min="0"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setEditing(false)
              setDraft(value != null ? String(value) : '')
            }
          }}
          autoFocus
          disabled={busy}
          aria-label={`Edit ${field}`}
          className="w-20 h-7 px-1 text-md border border-blue-400 rounded text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-300"
        />
      </div>
    )
  }

  if (value == null) {
    return (
      <button
        onClick={() => setEditing(true)}
        aria-label={`Set ${field}`}
        className="text-slate-400 hover:text-slate-700 hover:bg-slate-50 rounded px-1 -mx-1 cursor-pointer w-full text-right"
      >
        —
      </button>
    )
  }

  return (
    <button
      onClick={() => setEditing(true)}
      aria-label={`Edit ${field} (currently ${format(value)})`}
      className={`tabular-nums hover:bg-slate-50 rounded px-1 -mx-1 cursor-pointer transition focus:outline-none focus:ring-2 focus:ring-blue-300 ${align === 'right' ? 'text-right block w-full' : ''}`}
    >
      <div className={`text-md ${tone ?? 'text-slate-900'}`}>{format(value)}</div>
      {subline && (
        <div className={`text-sm ${subTone === 'rose' ? 'text-rose-600' : subTone === 'amber' ? 'text-amber-600' : 'text-slate-500'}`}>
          {subline}
        </div>
      )}
    </button>
  )
}

// ────────────────────────────────────────────────────────────────────
// QuickPresets — U.1.
// One-click pill row above the FilterBar covering the high-frequency
// filter combos operators reach for daily. Each preset writes to URL
// state via updateUrl (channel filters stay; only the listingStatus
// / syncStatus / hasError / lowStock / publishedOnly toggles flip).
// "All" clears those toggles back to defaults without touching
// channel/marketplace which the operator usually keeps locked when
// they navigate via /listings/{channel}/{marketplace}.
// ────────────────────────────────────────────────────────────────────
function QuickPresets({
  activeStatuses,
  activeSyncStatuses,
  hasError,
  lowStock,
  publishedOnly,
  updateUrl,
}: {
  activeStatuses: string[]
  activeSyncStatuses: string[]
  hasError: boolean
  lowStock: boolean
  publishedOnly: boolean
  updateUrl: (p: Record<string, string | undefined>) => void
}) {
  // Each preset is identified by a function that compares the current
  // URL state to the preset's expected state. Active highlight comes
  // from that comparison — no extra state needed.
  const presets = [
    {
      id: 'all',
      label: 'All',
      icon: Boxes,
      isActive:
        activeStatuses.length === 0 &&
        activeSyncStatuses.length === 0 &&
        !hasError &&
        !lowStock &&
        !publishedOnly,
      apply: () =>
        updateUrl({
          listingStatus: undefined,
          syncStatus: undefined,
          hasError: undefined,
          lowStock: undefined,
          published: undefined,
          page: undefined,
        }),
    },
    {
      id: 'errors',
      label: 'Errors only',
      icon: AlertTriangle,
      tone: 'danger' as const,
      isActive: hasError && activeStatuses.length === 0,
      apply: () =>
        updateUrl({
          listingStatus: undefined,
          syncStatus: undefined,
          hasError: 'true',
          lowStock: undefined,
          published: undefined,
          page: undefined,
        }),
    },
    {
      id: 'low-stock',
      label: 'Low stock',
      icon: Package,
      tone: 'warning' as const,
      isActive: lowStock,
      apply: () =>
        updateUrl({
          listingStatus: undefined,
          syncStatus: undefined,
          hasError: undefined,
          lowStock: 'true',
          published: undefined,
          page: undefined,
        }),
    },
    {
      id: 'drafts',
      label: 'Drafts',
      icon: Edit3,
      isActive:
        activeStatuses.length === 1 && activeStatuses[0] === 'DRAFT',
      apply: () =>
        updateUrl({
          listingStatus: 'DRAFT',
          syncStatus: undefined,
          hasError: undefined,
          lowStock: undefined,
          published: undefined,
          page: undefined,
        }),
    },
    {
      id: 'out-of-sync',
      label: 'Out of sync',
      icon: RefreshCw,
      tone: 'warning' as const,
      isActive:
        activeSyncStatuses.length === 1 && activeSyncStatuses[0] === 'FAILED',
      apply: () =>
        updateUrl({
          listingStatus: undefined,
          syncStatus: 'FAILED',
          hasError: undefined,
          lowStock: undefined,
          published: undefined,
          page: undefined,
        }),
    },
    {
      id: 'suppressed',
      label: 'Suppressed',
      icon: AlertCircle,
      tone: 'danger' as const,
      isActive:
        activeStatuses.length === 1 && activeStatuses[0] === 'SUPPRESSED',
      apply: () =>
        updateUrl({
          listingStatus: 'SUPPRESSED',
          syncStatus: undefined,
          hasError: undefined,
          lowStock: undefined,
          published: undefined,
          page: undefined,
        }),
    },
    {
      id: 'published',
      label: 'Published only',
      icon: Eye,
      isActive: publishedOnly,
      apply: () =>
        updateUrl({
          listingStatus: undefined,
          syncStatus: undefined,
          hasError: undefined,
          lowStock: undefined,
          published: 'true',
          page: undefined,
        }),
    },
  ]

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {presets.map((p) => {
        const Icon = p.icon
        const tone = (p as any).tone as 'danger' | 'warning' | undefined
        const activeClass = p.isActive
          ? tone === 'danger'
            ? 'bg-rose-100 border-rose-300 text-rose-700'
            : tone === 'warning'
              ? 'bg-amber-100 border-amber-300 text-amber-700'
              : 'bg-blue-100 border-blue-300 text-blue-700'
          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
        return (
          <button
            key={p.id}
            onClick={p.apply}
            aria-pressed={p.isActive}
            className={`h-7 px-2.5 text-sm rounded-full border inline-flex items-center gap-1.5 transition focus:outline-none focus:ring-2 focus:ring-blue-300 ${activeClass}`}
          >
            <Icon size={11} />
            {p.label}
          </button>
        )
      })}
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
              id="listings-search"
              placeholder="Search SKU, product name, external ID, or title — press / to focus"
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
  // U.1 — empty-state CTA needs context. activeFilterCount + search
  // drive the "X filters + search 'foo' active" message; onClearFilters
  // wipes URL state back to lens defaults.
  activeFilterCount: number
  search: string
  onClearFilters: () => void
  // U.1 — onListingChanged refreshes after inline cell edits land.
  onListingChanged: () => void
  // U.1 — activeRowIndex is the keyboard-cursor row (j/k navigation).
  // -1 = no active row; rendered as a blue ring on the matching <tr>.
  activeRowIndex: number
}) {
  const { grid, visible, visibleColumns, setVisibleColumns, columnPickerOpen, setColumnPickerOpen, sortBy, sortDir, onSort, page, onPage, selected, setSelected, onOpenDrawer, onResync, onListingChanged, activeRowIndex } = props

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
    // U.1 — when filters are active, the CTA is "Clear filters", not
    // "Go to catalog" (the latter only makes sense when the catalog
    // is genuinely empty, not when a filter combo dead-ended).
    const hasActiveFilters =
      props.activeFilterCount > 0 || (props.search && props.search.length > 0)
    if (hasActiveFilters) {
      return (
        <Card>
          <div className="text-center py-12 space-y-3">
            <FilterX size={32} className="text-slate-300 mx-auto" />
            <div className="text-md font-semibold text-slate-700">
              No listings match these filters
            </div>
            <div className="text-sm text-slate-500">
              {props.activeFilterCount > 0 && props.search
                ? `${props.activeFilterCount} filter${props.activeFilterCount === 1 ? '' : 's'} + search "${props.search}" active`
                : props.activeFilterCount > 0
                  ? `${props.activeFilterCount} filter${props.activeFilterCount === 1 ? '' : 's'} active`
                  : `Search "${props.search}" returned nothing`}
            </div>
            <button
              onClick={props.onClearFilters}
              className="h-9 px-4 text-base bg-slate-900 text-white rounded hover:bg-slate-800 inline-flex items-center gap-2"
            >
              <FilterX size={12} /> Clear filters
            </button>
          </div>
        </Card>
      )
    }
    return (
      <EmptyState
        icon={Boxes}
        title="No listings yet"
        description="Use the listing wizard from /products to publish your first SKU to a channel."
        action={{ label: 'View Catalog', href: '/products' }}
      />
    )
  }

  // U.1 — CSV export of the visible columns × all loaded rows. Pure
  // client-side: dumps grid.listings (current page, current sort,
  // current filters) to a CSV download. Operators paste these into
  // spreadsheets / send to suppliers / archive end-of-month
  // snapshots — common-enough requests that batch through Slack
  // today. Captures only what the operator sees, so visibleColumns
  // drives both the row of headers and the per-cell extraction.
  const exportCsv = () => {
    if (grid.listings.length === 0) return
    const escape = (v: unknown): string => {
      const s = v == null ? '' : String(v)
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`
      }
      return s
    }
    const cols = visible.filter((c) => c.key !== 'thumb' && c.key !== 'actions')
    const headers = cols.map((c) => escape(c.label || c.key)).join(',')
    const rows = grid.listings.map((l) =>
      cols
        .map((c) => {
          const k = c.key
          if (k === 'product') return escape(`${l.product.sku} — ${l.product.name}`)
          if (k === 'channel') return escape(l.channel)
          if (k === 'marketplace') return escape(l.marketplace)
          if (k === 'status') return escape(l.listingStatus)
          if (k === 'syncStatus') return escape(l.syncStatus ?? 'IDLE')
          if (k === 'price') return escape(l.price ?? '')
          if (k === 'pricingRule') return escape(l.pricingRule ?? '')
          if (k === 'masterDelta')
            return escape(
              l.price != null && l.masterPrice != null
                ? (l.price - l.masterPrice).toFixed(2)
                : '',
            )
          if (k === 'quantity') return escape(l.quantity ?? '')
          if (k === 'follow')
            return escape(
              [
                l.followMasterTitle && 'T',
                l.followMasterPrice && 'P',
                l.followMasterQuantity && 'Q',
              ]
                .filter(Boolean)
                .join(''),
            )
          if (k === 'externalId') return escape(l.externalListingId ?? '')
          if (k === 'lastSync')
            return escape(
              l.lastSyncedAt
                ? new Date(l.lastSyncedAt).toISOString()
                : '',
            )
          return ''
        })
        .join(','),
    )
    const csv = [headers, ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 10)
    a.href = url
    a.download = `listings-${stamp}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={exportCsv}
          disabled={grid.listings.length === 0}
          aria-label="Export current grid view to CSV"
          title={
            grid.listings.length === 0
              ? 'Nothing to export'
              : `Download ${grid.listings.length} row${grid.listings.length === 1 ? '' : 's'} as CSV (current filter + sort)`
          }
          className="h-7 px-2 text-base border border-slate-200 rounded inline-flex items-center gap-1.5 hover:bg-slate-50 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-300"
        >
          <Download size={12} /> Export CSV
        </button>
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
              {grid.listings.map((l, idx) => {
                const isSelected = selected.has(l.id)
                const isActive = idx === activeRowIndex
                return (
                  <tr
                    key={l.id}
                    data-row-index={idx}
                    className={`border-b border-slate-100 hover:bg-slate-50 transition-colors ${isSelected ? 'bg-blue-50/30' : ''} ${isActive ? 'ring-2 ring-blue-400 ring-inset' : ''}`}
                  >
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
                        <CellRenderer col={col.key} listing={l} onOpenDrawer={onOpenDrawer} onResync={onResync} onListingChanged={onListingChanged} />
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

function CellRenderer({ col, listing, onOpenDrawer, onResync, onListingChanged }: { col: string; listing: Listing; onOpenDrawer: (id: string) => void; onResync: (id: string) => void; onListingChanged: () => void }) {
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
      // U.1 — inline edit: click cell, type new price, Enter or blur
      // saves via PATCH; Esc cancels. Optimistic concurrency via the
      // listing's `version` field (the endpoint returns 409 when the
      // version doesn't match — we surface that to the operator with
      // a "Reload" hint). Sale price stays read-only here; complex
      // editing flows live in the drawer.
      return (
        <InlineNumberCell
          value={l.price ?? null}
          listingId={l.id}
          version={l.version}
          field="price"
          align="right"
          format={(n) => `${l.currency ?? ''} ${n.toFixed(2)}`.trim()}
          subline={l.salePrice != null ? `Sale ${l.salePrice.toFixed(2)}` : null}
          subTone="rose"
          onSaved={onListingChanged}
        />
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
      // U.1 — inline edit, integer-only. Same PATCH path as price.
      // The empty-state '—' rendering stays via passing null
      // through; the cell renders the dash but stays clickable
      // so operators can set an initial qty without opening the
      // drawer.
      const q = l.quantity
      const tone = q === 0 ? 'text-rose-600' : q != null && q <= 5 ? 'text-amber-600' : 'text-slate-700'
      return (
        <InlineNumberCell
          value={q ?? null}
          listingId={l.id}
          version={l.version}
          field="quantity"
          align="right"
          integer
          format={(n) => String(Math.round(n))}
          tone={tone}
          onSaved={onListingChanged}
        />
      )
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

// C.5 — paired actions where each cleanly inverts the other. Driving
// the post-action undo banner: after a successful bulk action whose
// pair lives in this map, we surface a 30s "Undo" toast that fires
// the inverse against the same listingIds. Actions absent from the
// map (resync, set-price) skip the undo banner — resync is idempotent
// so undo is meaningless; set-price loses the previous explicit price
// and the safe inverse is "follow master", which the operator can
// trigger explicitly if they want it.
const INVERSE_BULK_ACTION: Record<string, string> = {
  publish: 'unpublish',
  unpublish: 'publish',
  'follow-master': 'unfollow-master',
  'unfollow-master': 'follow-master',
}

const ACTION_PAST_LABEL: Record<string, string> = {
  publish: 'Published',
  unpublish: 'Unpublished',
  resync: 'Resynced',
  'set-price': 'Price set on',
  'follow-master': 'Following master on',
  'unfollow-master': 'Unfollowed master on',
  'set-pricing-rule': 'Pricing rule applied to',
}

function BulkActionBar({ selectedIds, onClear, onComplete }: { selectedIds: string[]; onClear: () => void; onComplete: () => void }) {
  const [busy, setBusy] = useState(false)
  const [jobStatus, setJobStatus] = useState<string | null>(null)
  const [setPriceOpen, setSetPriceOpen] = useState(false)
  const confirm = useConfirm()
  const { toast } = useToast()
  const { t } = useTranslations()

  // Fire the inverse action without any further confirm or undo
  // toast. Used by the undo button on the success toast: the operator
  // already saw the original action's confirmation (if any) and is
  // explicitly asking to revert; another confirm step or a re-undo
  // banner would be noise.
  const runInverse = useCallback(
    async (inverseAction: string, ids: string[]) => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/listings/bulk-action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: inverseAction, listingIds: ids }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          toast.error(`Undo failed: ${data.error ?? res.statusText}`)
          return
        }
        // Best-effort invalidation; we don't poll the inverse job's
        // progress — the standard SSE / 30s polling will surface the
        // result when the worker finishes.
        emitInvalidation({
          type: 'listing.updated',
          meta: {
            action: inverseAction,
            count: ids.length,
            listingIds: ids,
            source: 'listings-bulk-undo',
          },
        })
        emitInvalidation({
          type: 'bulk-job.completed',
          meta: { action: inverseAction, listingIds: ids },
        })
        toast.success(
          `Reverted ${ids.length} listing${ids.length === 1 ? '' : 's'}`,
        )
      } catch (e: any) {
        toast.error(`Undo failed: ${e.message ?? 'Unknown error'}`)
      }
    },
    [toast],
  )

  const runAction = async (action: string, payload?: any) => {
    // C.5 — confirm step for destructive bulk operations. Today
    // unpublish is the only one that takes listings off marketplaces;
    // the others (resync, follow-master, set-price) either don't
    // change visible state from the buyer's POV or get confirmed via
    // their own dedicated modal.
    if (action === 'unpublish') {
      const ok = await confirm({
        title: t(
          selectedIds.length === 1
            ? 'listings.bulk.unpublishConfirm.title'
            : 'listings.bulk.unpublishConfirm.titlePlural',
          { count: selectedIds.length },
        ),
        description: t('listings.bulk.unpublishConfirm.description'),
        confirmLabel: t('listings.bulk.unpublish'),
        tone: 'danger',
      })
      if (!ok) return
    }

    setBusy(true)
    // Snapshot at the start of the action so the undo target is
    // stable even after the bar's selection clears on success.
    const affectedIds = [...selectedIds]
    try {
      const res = await fetch(`${getBackendUrl()}/api/listings/bulk-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, listingIds: affectedIds, payload }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Bulk action failed')
      const jobId = data.jobId
      setJobStatus(t('listings.bulk.processing'))

      // Poll. S.0.5 / M-10 — track whether we exited via a terminal
      // status vs. the 60-second cap; the latter used to silently leave
      // the prior "Processing N/M…" or "Done" string on screen, even
      // when the worker was still running. Now we surface an honest
      // "did not complete in 60s" so the operator knows where to look.
      const start = Date.now()
      let reachedTerminal = false
      let succeededCount = 0
      let lastJob: { processed: number; total: number; succeeded: number; failed: number; status: string } | null = null
      while (Date.now() - start < 60_000) {
        await new Promise((r) => setTimeout(r, 600))
        const j = await fetch(`${getBackendUrl()}/api/listings/bulk-action/${jobId}`)
        if (!j.ok) break
        const job = await j.json()
        lastJob = job
        setJobStatus(t('listings.bulk.processingProgress', { processed: job.processed, total: job.total }))
        if (
          job.status === 'COMPLETED' ||
          job.status === 'FAILED' ||
          job.status === 'PARTIALLY_COMPLETED'
        ) {
          reachedTerminal = true
          succeededCount = job.succeeded
          setJobStatus(t('listings.bulk.done', { succeeded: job.succeeded, failed: job.failed }))
          break
        }
      }
      if (!reachedTerminal) {
        const progress = lastJob
          ? `${lastJob.processed}/${lastJob.total} processed`
          : 'no progress visible'
        setJobStatus(t('listings.bulk.timeout', { progress }))
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
          count: affectedIds.length,
          listingIds: affectedIds,
          source: 'listings-bulk',
        },
      })
      emitInvalidation({
        type: 'bulk-job.completed',
        meta: { action, listingIds: affectedIds },
      })

      // C.5 — 30 s undo grace banner. The bulk endpoint has no native
      // undo; we synthesize one by firing the inverse action against
      // the same listingIds when the operator clicks Undo. Only paired
      // actions show the banner — resync and set-price would be
      // misleading or unsafe to "undo".
      const inverse = INVERSE_BULK_ACTION[action]
      if (reachedTerminal && succeededCount > 0 && inverse) {
        const past = ACTION_PAST_LABEL[action] ?? 'Updated'
        toast({
          title: `${past} ${succeededCount} listing${succeededCount === 1 ? '' : 's'}`,
          description: `Undo within 30 seconds.`,
          tone: 'success',
          durationMs: 30_000,
          action: {
            label: 'Undo',
            onClick: () => runInverse(inverse, affectedIds),
          },
        })
      }

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
          <button onClick={() => runAction('publish')} disabled={busy} className="h-7 px-3 text-base bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 disabled:opacity-50 inline-flex items-center gap-1.5"><Eye size={12} /> {t('listings.bulk.publish')}</button>
          <button onClick={() => runAction('unpublish')} disabled={busy} className="h-7 px-3 text-base bg-slate-50 text-slate-700 border border-slate-200 rounded hover:bg-slate-100 disabled:opacity-50 inline-flex items-center gap-1.5"><EyeOff size={12} /> {t('listings.bulk.unpublish')}</button>
          <button onClick={() => runAction('resync')} disabled={busy} className="h-7 px-3 text-base bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 disabled:opacity-50 inline-flex items-center gap-1.5"><RefreshCw size={12} /> {t('listings.bulk.resync')}</button>
          <button
            onClick={() => setSetPriceOpen(true)}
            disabled={busy}
            className="h-7 px-3 text-base bg-white text-slate-700 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5"
          ><Tag size={12} /> {t('listings.bulk.setPrice')}</button>
          <button onClick={() => runAction('follow-master')} disabled={busy} className="h-7 px-3 text-base bg-white text-slate-700 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5"><Link2 size={12} /> {t('listings.bulk.followMaster')}</button>
          <button onClick={() => runAction('unfollow-master')} disabled={busy} className="h-7 px-3 text-base bg-white text-slate-700 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-50 inline-flex items-center gap-1.5">{t('listings.bulk.unfollowMaster')}</button>
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

// C.12 — labels resolved at render time via t() inside MatrixLens; this
// array carries the keys (not literal labels) so locale changes pick
// up without a re-mount.
const COVERAGE_OPTIONS: Array<{ value: Coverage | ''; labelKey: string }> = [
  { value: '', labelKey: 'listings.matrix.coverage.all' },
  { value: 'everywhere', labelKey: 'listings.matrix.coverage.everywhere' },
  { value: 'missing-amazon', labelKey: 'listings.matrix.coverage.missingAmazon' },
  { value: 'missing-ebay', labelKey: 'listings.matrix.coverage.missingEbay' },
  { value: 'single-channel', labelKey: 'listings.matrix.coverage.singleChannel' },
  { value: 'uncovered', labelKey: 'listings.matrix.coverage.uncovered' },
]

const SORT_OPTIONS: Array<{ value: MatrixSort; labelKey: string }> = [
  { value: 'updated', labelKey: 'listings.matrix.sort.updated' },
  { value: 'coverage-gaps', labelKey: 'listings.matrix.sort.coverageGaps' },
  { value: 'most-channels', labelKey: 'listings.matrix.sort.mostChannels' },
  { value: 'name', labelKey: 'listings.matrix.sort.name' },
]

function MatrixLens({ lockChannel }: { lockChannel?: string; marketplaces: Marketplace[] }) {
  const { t } = useTranslations()
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
          <span className="text-sm uppercase tracking-wider text-slate-500">{t('listings.matrix.coverage')}</span>
          <select
            value={coverage}
            onChange={(e) => setCoverage(e.target.value as Coverage | '')}
            className="h-8 px-2 text-base bg-white border border-slate-200 rounded text-slate-700 hover:border-slate-300 focus:outline-none focus:border-blue-500"
            aria-label={t('listings.matrix.coverage')}
          >
            {COVERAGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-sm uppercase tracking-wider text-slate-500">{t('listings.matrix.sort')}</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as MatrixSort)}
            className="h-8 px-2 text-base bg-white border border-slate-200 rounded text-slate-700 hover:border-slate-300 focus:outline-none focus:border-blue-500"
            aria-label={t('listings.matrix.sort')}
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
            ))}
          </select>
        </div>
        <span className="text-sm text-slate-500 ml-auto">
          {data.totalMatched != null && data.totalMatched > data.count
            ? t('listings.matrix.showingOf', { count: data.count, total: data.totalMatched })
            : t(data.count === 1 ? 'listings.matrix.productsCount' : 'listings.matrix.productsCountPlural', { count: data.count })}
        </span>
      </div>

      {data.products.length === 0 ? (
        <EmptyState
          icon={LayoutGrid}
          title={t('listings.matrix.empty.title')}
          description={
            coverage
              ? t('listings.matrix.empty.descriptionFiltered', {
                  label: t(COVERAGE_OPTIONS.find((o) => o.value === coverage)?.labelKey ?? 'listings.matrix.coverage.all'),
                })
              : t('listings.matrix.empty.description')
          }
        />
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table
              className="text-base"
              role="grid"
              aria-label="Multi-channel listing matrix"
              aria-rowcount={data.products.length + 1}
              aria-colcount={columns.length + 2}
            >
              <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-20">
                <tr role="row">
                  <th
                    role="columnheader"
                    className="px-3 py-2 text-left text-sm font-semibold text-slate-700 uppercase tracking-wider sticky left-0 bg-slate-50 z-30 min-w-[260px]"
                  >
                    Product
                  </th>
                  {/* C.9 — Master reference column. Anchors every row so
                      reading across becomes an implicit comparison: each
                      channel cell to its right is implicitly diff'd against
                      this anchor. Stays visually distinct (slate, no
                      channel tone) so it's never confused with a cell. */}
                  <th
                    role="columnheader"
                    className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wider min-w-[120px] bg-slate-100 border-x border-slate-200"
                  >
                    <div className="inline-block px-1.5 py-0.5 rounded border border-slate-300 text-slate-700 bg-white">
                      Master
                    </div>
                    <div className="text-xs text-slate-400 mt-1">reference</div>
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
                  // C.9 — row-level master reference. Each channel cell
                  // diffs against this anchor. We pass it in as `master`
                  // so MatrixCell doesn't have to reach into the row.
                  const master = {
                    title: p.masterTitleForCompare ?? p.name ?? null,
                    price: p.masterPriceForCompare ?? null,
                    quantity: p.masterQuantityForCompare ?? null,
                  }
                  return (
                    <tr
                      key={p.id}
                      role="row"
                      className="group/row border-b border-slate-100 hover:bg-slate-50/50"
                    >
                      <td
                        role="rowheader"
                        className="px-3 py-2 sticky left-0 bg-white border-r border-slate-100 z-10 group-hover/row:bg-slate-50/50"
                      >
                        <Link href={`/products/${p.id}/edit`} className="hover:text-blue-600 block">
                          <div className="text-md font-medium text-slate-900 truncate max-w-xs">{p.name}</div>
                          <div className="text-sm text-slate-500 font-mono">{p.sku}</div>
                        </Link>
                      </td>
                      <td
                        role="gridcell"
                        className="px-2 py-2 text-center bg-slate-50 border-x border-slate-200"
                      >
                        <MasterCell master={master} />
                      </td>
                      {columns.map((key) => {
                        const c = cellByKey.get(key)
                        const [ch, mp] = key.split(':')
                        return (
                          <td
                            key={key}
                            role="gridcell"
                            className="px-2 py-2 text-center"
                          >
                            {c ? (
                              <MatrixCell
                                cell={c}
                                master={master}
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
// C.9 — drift surfacing always-on. Channel cell diffs against the row's
// master reference for price, quantity, and title regardless of the
// followMaster flags: a cell that *claims* to follow master but has a
// stale value IS drift, and that's exactly the silent class of bug we
// want to surface.
// ────────────────────────────────────────────────────────────────────
function MatrixCell({
  cell,
  master,
  product,
  optimisticSyncing,
  onOpenDrawer,
  onSync,
}: {
  cell: any
  master: { title: string | null; price: number | null; quantity: number | null }
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

  // Drift computations — independent of follow* flags. We compare the
  // channel's effective value against the master reference and surface
  // every divergence, leaving the operator to decide whether it's
  // intentional or a sync bug.
  const priceDrift =
    cell.price != null && master.price != null && cell.price !== master.price
      ? cell.price - master.price
      : null
  const qtyDrift =
    cell.quantity != null &&
    master.quantity != null &&
    cell.quantity !== master.quantity
      ? cell.quantity - master.quantity
      : null
  const titleDrift =
    cell.title != null &&
    master.title != null &&
    cell.title.trim() !== master.title.trim()

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
    priceDrift != null
      ? `${priceDrift > 0 ? '+' : ''}${priceDrift.toFixed(2)} vs master`
      : null,
    cell.quantity != null ? `${cell.quantity} units` : null,
    qtyDrift != null ? `${qtyDrift > 0 ? '+' : ''}${qtyDrift} vs master` : null,
    titleDrift ? 'title differs from master' : null,
    cell.lastSyncedAt ? `synced ${formatRelative(new Date(cell.lastSyncedAt).getTime())}` : 'never synced',
    cell.lastSyncError ? `error: ${cell.lastSyncError.slice(0, 80)}` : null,
  ].filter(Boolean).join(', ')

  // C.9 — two-column tooltip. Master vs channel side-by-side with
  // delta annotations, replacing the prior single-column dump. Reads
  // the same way the matrix row does (master on left, channel on
  // right) so operator's mental model maps cleanly.
  const tooltipContent = (
    <div className="space-y-2 max-w-[320px]">
      <div className="font-semibold">{cell.channel} · {cell.marketplace}</div>
      <div className="grid grid-cols-[auto_1fr_1fr] gap-x-2 gap-y-1 text-xs">
        <div className="text-slate-400 uppercase tracking-wider"></div>
        <div className="text-slate-300 font-semibold uppercase tracking-wider">Master</div>
        <div className="text-slate-300 font-semibold uppercase tracking-wider">Channel</div>

        <div className="text-slate-400">Price</div>
        <div className="tabular-nums">{master.price != null ? master.price.toFixed(2) : '—'}</div>
        <div className="tabular-nums">
          {cell.price != null ? cell.price.toFixed(2) : '—'}
          {priceDrift != null && (
            <span className={priceDrift > 0 ? ' text-emerald-300' : ' text-rose-300'}>
              {' '}({priceDrift > 0 ? '+' : ''}{priceDrift.toFixed(2)})
            </span>
          )}
        </div>

        <div className="text-slate-400">Stock</div>
        <div className="tabular-nums">{master.quantity ?? '—'}</div>
        <div className="tabular-nums">
          {cell.quantity ?? '—'}
          {qtyDrift != null && (
            <span className={qtyDrift > 0 ? ' text-slate-300' : ' text-rose-300'}>
              {' '}({qtyDrift > 0 ? '+' : ''}{qtyDrift})
            </span>
          )}
        </div>

        <div className="text-slate-400">Title</div>
        <div className="truncate">{master.title ?? '—'}</div>
        <div className="truncate">
          {cell.title ?? '—'}
          {titleDrift && <span className="text-amber-300"> ⚠</span>}
        </div>
      </div>
      <div className="text-xs text-slate-300 border-t border-slate-700 pt-1.5">
        Status: {cell.listingStatus}
        {cell.lastSyncStatus && ` · Sync: ${cell.lastSyncStatus}`}
      </div>
      <div className="text-xs text-slate-300">
        {cell.lastSyncedAt
          ? `Last synced ${formatRelative(new Date(cell.lastSyncedAt).getTime())}`
          : 'Never synced'}
      </div>
      {cell.lastSyncError && (
        <div className="text-xs text-rose-300 border-t border-slate-700 pt-1.5">
          {cell.lastSyncError}
        </div>
      )}
    </div>
  )

  return (
    <Tooltip content={tooltipContent} delay={400}>
      <div className="group relative inline-block min-w-[100px] group-hover/row:ring-1 group-hover/row:ring-blue-200 group-hover/row:rounded">
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
            <div className="tabular-nums text-sm mt-0.5 flex items-center gap-1 flex-wrap">
              <span>{cell.price.toFixed(2)}</span>
              {priceDrift != null && <DriftBadge delta={priceDrift} unit="price" />}
            </div>
          )}
          {cell.quantity != null && (
            <div className="tabular-nums text-xs flex items-center gap-1 flex-wrap">
              <span className="opacity-70">{cell.quantity} pcs</span>
              {qtyDrift != null && <DriftBadge delta={qtyDrift} unit="qty" />}
            </div>
          )}
          {titleDrift && (
            <div
              className="text-xs mt-0.5 inline-flex items-center gap-1 px-1 rounded bg-amber-50 border border-amber-200 text-amber-700"
              title={`Channel title differs from master: "${cell.title}"`}
              aria-label="Title differs from master"
            >
              ⚠ T
            </div>
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
// MasterCell — leftmost reference cell in each matrix row. C.9.
// Shows master price + qty + truncated title with a distinct slate
// background so it never reads as a channel cell. Anchors the
// row-as-comparison reading model: every cell to the right is
// implicitly diff'd against this.
// ────────────────────────────────────────────────────────────────────
function MasterCell({
  master,
}: {
  master: { title: string | null; price: number | null; quantity: number | null }
}) {
  const truncatedTitle =
    master.title && master.title.length > 24
      ? master.title.slice(0, 24) + '…'
      : master.title
  const tooltipContent = (
    <div className="space-y-1 max-w-[280px]">
      <div className="font-semibold">Master reference</div>
      {master.title && <div className="text-xs">Title: {master.title}</div>}
      {master.price != null && (
        <div className="text-xs tabular-nums">Price: {master.price.toFixed(2)}</div>
      )}
      {master.quantity != null && (
        <div className="text-xs tabular-nums">Stock: {master.quantity} pcs</div>
      )}
      <div className="text-xs text-slate-300 border-t border-slate-700 pt-1">
        Channel cells in this row diff against these values.
      </div>
    </div>
  )
  return (
    <Tooltip content={tooltipContent} delay={400}>
      <div
        className="block w-full text-left px-1.5 py-1 border border-slate-300 rounded text-xs bg-white text-slate-700 min-w-[100px]"
        aria-label={`Master reference price ${master.price?.toFixed(2) ?? 'unset'}, stock ${master.quantity ?? 'unset'}`}
      >
        <div className="flex items-center justify-between gap-1.5">
          <div className="font-semibold uppercase tracking-wider truncate text-slate-500">
            Master
          </div>
        </div>
        {master.price != null && (
          <div className="tabular-nums text-sm mt-0.5 font-semibold">
            {master.price.toFixed(2)}
          </div>
        )}
        {master.quantity != null && (
          <div className="tabular-nums text-xs opacity-70">{master.quantity} pcs</div>
        )}
        {truncatedTitle && (
          <div className="text-xs text-slate-500 mt-0.5 truncate" title={master.title ?? undefined}>
            {truncatedTitle}
          </div>
        )}
      </div>
    </Tooltip>
  )
}

// ────────────────────────────────────────────────────────────────────
// DriftBadge — tiny coloured delta annotation. C.9.
// Renders alongside the cell's price or quantity. unit='price' uses
// red-when-below-master (margin risk) and green-when-above; unit='qty'
// uses red-when-below (drift toward stockout) and slate-when-above
// (overstock isn't usually urgent). Always carries a text label —
// colour-only signalling fails a11y.
// ────────────────────────────────────────────────────────────────────
function DriftBadge({ delta, unit }: { delta: number; unit: 'price' | 'qty' }) {
  const sign = delta > 0 ? '+' : ''
  const formatted = unit === 'price' ? delta.toFixed(2) : String(delta)
  const tone =
    unit === 'price'
      ? delta > 0
        ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
        : 'text-rose-700 bg-rose-50 border-rose-200'
      : delta > 0
        ? 'text-slate-600 bg-slate-50 border-slate-200'
        : 'text-rose-700 bg-rose-50 border-rose-200'
  const ariaText =
    unit === 'price'
      ? `${delta > 0 ? 'above' : 'below'} master by ${formatted.replace('-', '')}`
      : `${delta > 0 ? 'above' : 'below'} master by ${Math.abs(delta)} units`
  return (
    <span
      className={`inline-flex items-center px-1 rounded border text-xs tabular-nums ${tone}`}
      aria-label={ariaText}
    >
      {sign}
      {formatted}
    </span>
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
// PerformanceLens — U.3
// ────────────────────────────────────────────────────────────────────
// Per-listing aggregates over the last N days. Sortable table with
// units sold, revenue, velocity (units/day), avg selling price,
// orders count, last sold timestamp, and the channel-listing's
// current status. Click row → open drawer for the matching listing.
//
// Data flow: GET /api/listings/performance does a GROUP BY on
// OrderItem joined to ChannelListing. The response carries a
// totals rollup so the operator gets a "27 units · €2,914.00"
// strip at the top without re-summing on the client.
//
// Empty state is informative rather than blank: until orders flow
// through Xavia's channels, the lens shows "No orders yet in the
// last N days" and the operator knows the surface itself works.
// ────────────────────────────────────────────────────────────────────
type PerformanceRow = {
  sku: string
  channel: string
  marketplace: string | null
  productId: string | null
  productName: string | null
  listing: {
    id: string
    listingStatus: string
    syncStatus: string | null
    price: number | null
    quantity: number | null
    externalListingId: string | null
  } | null
  unitsSold: number
  grossRevenue: number
  orderCount: number
  avgSellingPrice: number
  firstSoldAt: string | null
  lastSoldAt: string | null
  velocity: number
}

function PerformanceLens({
  lockChannel,
  lockMarketplace,
  onOpenDrawer,
}: {
  lockChannel?: string
  lockMarketplace?: string
  onOpenDrawer: (id: string) => void
}) {
  const [range, setRange] = useState<'7d' | '30d' | '90d'>('30d')
  const [sortBy, setSortBy] = useState<
    'grossRevenue' | 'unitsSold' | 'velocity' | 'lastSoldAt' | 'avgSellingPrice'
  >('grossRevenue')

  const url = useMemo(() => {
    const qs = new URLSearchParams()
    qs.set('range', range)
    if (lockChannel) qs.set('channel', lockChannel)
    if (lockMarketplace) qs.set('marketplace', lockMarketplace)
    qs.set('limit', '200')
    return `/api/listings/performance?${qs.toString()}`
  }, [range, lockChannel, lockMarketplace])

  const { data, loading, error, refetch } = usePolledList<{
    rangeDays: number
    rangeStart: string
    rangeEnd: string
    rows: PerformanceRow[]
    totals: { unitsSold: number; grossRevenue: number; orderCount: number }
  }>({
    url,
    intervalMs: 60_000,
    invalidationTypes: ['listing.updated', 'listing.created', 'bulk-job.completed'],
  })

  const sorted = useMemo(() => {
    if (!data?.rows) return [] as PerformanceRow[]
    const arr = [...data.rows]
    arr.sort((a, b) => {
      if (sortBy === 'lastSoldAt') {
        const av = a.lastSoldAt ? new Date(a.lastSoldAt).getTime() : 0
        const bv = b.lastSoldAt ? new Date(b.lastSoldAt).getTime() : 0
        return bv - av
      }
      const av = (a as any)[sortBy] ?? 0
      const bv = (b as any)[sortBy] ?? 0
      return bv - av
    })
    return arr
  }, [data?.rows, sortBy])

  const headerCell = (key: typeof sortBy, label: string, align: 'left' | 'right' = 'right') => (
    <th
      onClick={() => setSortBy(key)}
      className={`px-3 py-2 text-sm font-semibold uppercase tracking-wider cursor-pointer hover:bg-slate-100 select-none ${align === 'right' ? 'text-right' : 'text-left'} ${sortBy === key ? 'text-blue-700' : 'text-slate-700'}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortBy === key && <ChevronDown size={11} />}
      </span>
    </th>
  )

  if (loading && !data) {
    return (
      <Card>
        <Skeleton variant="text" lines={6} />
      </Card>
    )
  }
  if (error && !data) {
    return (
      <Card>
        <div className="text-rose-600 text-md py-8 text-center space-y-2">
          <div>Failed to load performance: {error}</div>
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

  return (
    <div className="space-y-3">
      {/* Header — range selector + totals strip */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5">
          {(['7d', '30d', '90d'] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              aria-pressed={range === r}
              className={`h-7 px-3 text-base font-medium rounded transition-colors ${range === r ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
            >
              Last {r === '7d' ? '7 days' : r === '30d' ? '30 days' : '90 days'}
            </button>
          ))}
        </div>
        {data.rows.length > 0 && (
          <div className="flex items-center gap-3 text-base text-slate-500 ml-auto">
            <span>
              <span className="font-semibold text-slate-700 tabular-nums">
                {data.totals.unitsSold.toLocaleString()}
              </span>{' '}
              units
            </span>
            <span className="text-slate-300">·</span>
            <span>
              <span className="font-semibold text-slate-700 tabular-nums">
                €{data.totals.grossRevenue.toFixed(2)}
              </span>{' '}
              revenue
            </span>
            <span className="text-slate-300">·</span>
            <span>
              <span className="font-semibold text-slate-700 tabular-nums">
                {data.totals.orderCount.toLocaleString()}
              </span>{' '}
              orders
            </span>
          </div>
        )}
      </div>

      {sorted.length === 0 ? (
        <Card>
          <div className="text-center py-12 space-y-2">
            <Activity size={32} className="text-slate-300 mx-auto" />
            <div className="text-md font-semibold text-slate-700">
              No orders yet in the last {data.rangeDays} days
            </div>
            <div className="text-sm text-slate-500">
              Once orders flow through{' '}
              {lockChannel ? lockChannel.toLowerCase() : 'your channels'}, this
              lens will show units sold, revenue, and sales velocity per
              listing.
            </div>
          </div>
        </Card>
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-md">
              <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left text-sm font-semibold text-slate-700 uppercase tracking-wider">
                    Listing
                  </th>
                  <th className="px-3 py-2 text-left text-sm font-semibold text-slate-700 uppercase tracking-wider">
                    Channel
                  </th>
                  {headerCell('unitsSold', 'Units')}
                  {headerCell('grossRevenue', 'Revenue')}
                  {headerCell('avgSellingPrice', 'Avg price')}
                  {headerCell('velocity', 'Velocity')}
                  <th className="px-3 py-2 text-right text-sm font-semibold text-slate-700 uppercase tracking-wider">
                    Orders
                  </th>
                  {headerCell('lastSoldAt', 'Last sold')}
                  <th className="px-3 py-2 text-left text-sm font-semibold text-slate-700 uppercase tracking-wider">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => {
                  const handleClick = () => {
                    if (r.listing) onOpenDrawer(r.listing.id)
                  }
                  // Velocity tone: hot (≥1/day) emerald, warm (≥0.3) slate,
                  // cold (<0.3) muted. Heuristic — operators can re-anchor
                  // by sorting on the Velocity column directly.
                  const velocityTone =
                    r.velocity >= 1
                      ? 'text-emerald-700'
                      : r.velocity >= 0.3
                        ? 'text-slate-700'
                        : 'text-slate-400'
                  return (
                    <tr
                      key={`${r.sku}::${r.channel}::${r.marketplace}::${i}`}
                      onClick={handleClick}
                      className={`border-b border-slate-100 hover:bg-slate-50 ${r.listing ? 'cursor-pointer' : ''}`}
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-900 truncate max-w-xs">
                          {r.productName ?? '(unknown product)'}
                        </div>
                        <div className="text-xs text-slate-500 font-mono">
                          {r.sku}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-sm">
                        <div className="inline-flex items-center gap-1.5">
                          <span className="font-mono text-xs">{r.channel}</span>
                          {r.marketplace && (
                            <span className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded text-slate-600">
                              {r.marketplace}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.unitsSold}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">
                        €{r.grossRevenue.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                        €{r.avgSellingPrice.toFixed(2)}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${velocityTone}`}>
                        {r.velocity.toFixed(2)}/d
                        {r.velocity >= 1 && (
                          <TrendingUp size={11} className="inline ml-1" />
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                        {r.orderCount}
                      </td>
                      <td className="px-3 py-2 text-sm text-slate-500 whitespace-nowrap">
                        {r.lastSoldAt
                          ? new Date(r.lastSoldAt).toLocaleDateString('en-GB', {
                              day: 'numeric',
                              month: 'short',
                            })
                          : '—'}
                      </td>
                      <td className="px-3 py-2">
                        {r.listing ? (
                          <Badge
                            variant={
                              STATUS_VARIANT[r.listing.listingStatus] ?? 'default'
                            }
                            size="sm"
                          >
                            {r.listing.listingStatus}
                          </Badge>
                        ) : (
                          <span className="text-xs text-slate-400">
                            no listing
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
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

      {/* S.5 — Amazon-specific context (ASIN tree, FBA economics,
          Buy Box intelligence, active suppression). Renders only when
          channel === 'AMAZON' and the backend returned amazonContext. */}
      {listing.channel === 'AMAZON' && listing.amazonContext && (
        <AmazonContextSection
          listingId={listing.id}
          listingLabel={`${listing.product?.name ?? listing.product?.sku} · AMAZON ${listing.marketplace}`}
          ctx={listing.amazonContext}
        />
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
// AmazonContextSection — drawer Detail tab extension when channel='AMAZON'
//
// S.5 — surfaces ASIN tree (parent + child variations), FBA economics
// with margin estimate, Buy Box intelligence (our price vs lowest
// competitor with delta), and the active suppression record if any.
// "Log suppression" CTA opens the SuppressionLogModal so operators
// can record episodes ahead of SP-API auto-detection (S.5b).
// ────────────────────────────────────────────────────────────────────
function AmazonContextSection({
  listingId,
  listingLabel,
  ctx,
}: {
  listingId: string
  listingLabel: string
  ctx: any
}) {
  const [logOpen, setLogOpen] = useState(false)

  const margin =
    ctx.fbaEconomics.estimatedFbaFee != null &&
    ctx.fbaEconomics.referralFeePercent != null &&
    ctx.buyBox.ourPrice != null
      ? ctx.buyBox.ourPrice -
        ctx.fbaEconomics.estimatedFbaFee -
        (ctx.buyBox.ourPrice * ctx.fbaEconomics.referralFeePercent) / 100
      : null

  return (
    <div className="border border-orange-200 bg-orange-50/30 rounded-md p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs uppercase tracking-wider text-orange-700 font-semibold inline-flex items-center gap-1.5">
          <Package size={12} /> Amazon
        </div>
        {!ctx.activeSuppression && (
          <button
            onClick={() => setLogOpen(true)}
            className="h-6 px-2 text-xs bg-white text-rose-700 border border-rose-200 rounded hover:bg-rose-50 inline-flex items-center gap-1"
            aria-label="Log a suppression"
          >
            <AlertTriangle size={10} /> Log suppression
          </button>
        )}
      </div>

      {/* ASIN identifiers */}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 font-medium mb-0.5">ASIN</div>
          <div className="font-mono text-slate-900 font-semibold">
            {ctx.asin ?? <span className="text-slate-400">—</span>}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 font-medium mb-0.5">Parent ASIN</div>
          <div className="font-mono text-slate-900">
            {ctx.parentAsin ?? <span className="text-slate-400">—</span>}
          </div>
        </div>
      </div>

      {/* Variation tree (when this is a parent SKU) */}
      {ctx.isParentSku && Array.isArray(ctx.variations) && ctx.variations.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-500 font-medium mb-1.5">
            Variations ({ctx.variations.length})
          </div>
          <div className="border border-slate-200 rounded-md bg-white divide-y divide-slate-100">
            {ctx.variations.map((v: any) => (
              <div key={v.id} className="flex items-center gap-3 px-2.5 py-1.5">
                <span className="font-mono text-xs font-semibold text-slate-700 truncate flex-1">
                  {v.sku}
                </span>
                {v.amazonAsin && (
                  <span className="font-mono text-xs text-slate-500">{v.amazonAsin}</span>
                )}
                <span className="text-xs text-slate-500 tabular-nums w-12 text-right">
                  {v.stock ?? 0} pcs
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* FBA economics + margin estimate */}
      <div>
        <div className="text-xs uppercase tracking-wider text-slate-500 font-medium mb-1.5">
          FBA economics
        </div>
        <div className="grid grid-cols-3 gap-2 text-sm">
          <FbaCell
            label="FBA fee"
            value={ctx.fbaEconomics.estimatedFbaFee != null ? `€${ctx.fbaEconomics.estimatedFbaFee.toFixed(2)}` : '—'}
            sub="per unit"
          />
          <FbaCell
            label="Referral"
            value={ctx.fbaEconomics.referralFeePercent != null ? `${ctx.fbaEconomics.referralFeePercent.toFixed(1)}%` : '—'}
            sub="of price"
          />
          <FbaCell
            label="Net margin"
            value={margin != null ? `€${margin.toFixed(2)}` : '—'}
            sub={margin != null && ctx.buyBox.ourPrice ? `${((margin / ctx.buyBox.ourPrice) * 100).toFixed(0)}%` : 'pending'}
            tone={margin != null && margin > 0 ? 'success' : margin != null && margin <= 0 ? 'danger' : 'default'}
          />
        </div>
        {ctx.fbaEconomics.feeFetchedAt == null && (
          <div className="text-xs text-slate-400 italic mt-1.5">
            Fee data not yet fetched — runs via SP-API GetMyFeesEstimate cron (S.5b).
          </div>
        )}
      </div>

      {/* Buy Box intelligence */}
      <div>
        <div className="text-xs uppercase tracking-wider text-slate-500 font-medium mb-1.5">
          Buy Box intelligence
        </div>
        {ctx.buyBox.lowestCompetitorPrice == null ? (
          <div className="text-sm text-slate-500 bg-white border border-slate-200 rounded-md p-2.5">
            Competitor pricing not yet fetched. Real Buy Box ownership requires the SP-API
            GetItemOffersBatch integration (S.5b — pending).
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 text-sm bg-white border border-slate-200 rounded-md p-2.5">
            <FbaCell
              label="Our price"
              value={ctx.buyBox.ourPrice != null ? `€${ctx.buyBox.ourPrice.toFixed(2)}` : '—'}
            />
            <FbaCell
              label="Lowest competitor"
              value={`€${ctx.buyBox.lowestCompetitorPrice.toFixed(2)}`}
            />
            <FbaCell
              label="Delta"
              value={
                ctx.buyBox.delta != null
                  ? `${ctx.buyBox.delta > 0 ? '+' : ''}€${ctx.buyBox.delta.toFixed(2)}`
                  : '—'
              }
              tone={ctx.buyBox.losingOnPrice ? 'danger' : 'success'}
              sub={ctx.buyBox.losingOnPrice ? 'losing on price' : 'competitive'}
            />
          </div>
        )}
        {ctx.buyBox.competitorFetchedAt && (
          <div className="text-xs text-slate-400 mt-1">
            Last competitor fetch: {new Date(ctx.buyBox.competitorFetchedAt).toLocaleString()}
          </div>
        )}
      </div>

      {/* Active suppression record */}
      {ctx.activeSuppression && (
        <div className="border border-rose-300 bg-rose-50 rounded-md p-2.5">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertTriangle size={12} className="text-rose-600" />
            <span className="text-xs uppercase tracking-wider font-semibold text-rose-700">
              Active suppression
            </span>
          </div>
          <div className="text-base text-rose-700">
            {ctx.activeSuppression.reasonCode && (
              <span className="font-mono mr-1">[{ctx.activeSuppression.reasonCode}]</span>
            )}
            {ctx.activeSuppression.reasonText}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Suppressed {new Date(ctx.activeSuppression.suppressedAt).toLocaleString()} ·{' '}
            source: {ctx.activeSuppression.source}
          </div>
        </div>
      )}

      <SuppressionLogModalLazy
        open={logOpen}
        onClose={() => setLogOpen(false)}
        listingId={listingId}
        listingLabel={listingLabel}
      />
    </div>
  )
}

function FbaCell({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'success' | 'danger'
}) {
  const toneClass =
    tone === 'success' ? 'text-emerald-700'
    : tone === 'danger' ? 'text-rose-700'
    : 'text-slate-900'
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-slate-400 font-medium mb-0.5">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  )
}

// SuppressionLogModal lives in AmazonListingsClient.tsx; lazy-import
// here to avoid hard-coupling the workspace to the Amazon page.
function SuppressionLogModalLazy(props: {
  open: boolean
  onClose: () => void
  listingId: string
  listingLabel: string
}) {
  // Conditional dynamic import: only loads the modal code when the
  // operator clicks "Log suppression" — keeps the workspace bundle
  // lean for non-Amazon channels.
  const [Comp, setComp] = useState<any>(null)
  useEffect(() => {
    if (!props.open) return
    let cancelled = false
    import('./amazon/AmazonListingsClient').then((mod) => {
      if (!cancelled) setComp(() => mod.SuppressionLogModal)
    })
    return () => { cancelled = true }
  }, [props.open])
  if (!props.open || !Comp) return null
  return <Comp {...props} />
}

// ────────────────────────────────────────────────────────────────────
// ChannelsTab — comparison panel: this product across all channels.
// C.10 — anchors the comparison with a master reference card at the
// top, then renders each listing (current + companions) with drift
// indicators against master inline + per-field override pills. The
// operator sees at a glance: which channel/market has the highest
// price, where qty diverges, what's explicitly overridden vs
// inherited from master.
// ────────────────────────────────────────────────────────────────────
function ChannelsTab({
  listing,
  onSwitchListing,
}: {
  listing: any
  onSwitchListing: (id: string) => void
}) {
  const { t } = useTranslations()
  const companions = (listing.companions ?? []) as any[]
  // Master reference — anchored to the product, identical across
  // every card's drift math. Falls back to product-level fields when
  // ChannelListing.master* aren't populated.
  const master = {
    title:
      listing.masterTitle ??
      listing.product?.name ??
      null,
    price:
      listing.masterPrice ??
      (listing.product?.basePrice ?? null),
    quantity:
      listing.masterQuantity ??
      (listing.product?.totalStock ?? null),
  }
  const totalCombos = companions.length + 1
  return (
    <div className="space-y-3">
      <div className="text-sm text-slate-600">
        {t(
          totalCombos === 1
            ? 'listings.drawer.combosCount'
            : 'listings.drawer.combosCountPlural',
          { count: totalCombos },
        )}
      </div>

      {/* Master reference card */}
      <ComparisonMasterCard master={master} />

      {/* Self */}
      <CompanionCard
        channel={listing.channel}
        marketplace={listing.marketplace}
        listingStatus={listing.listingStatus}
        syncStatus={listing.syncStatus}
        price={listing.price}
        quantity={listing.quantity}
        title={listing.title}
        lastSyncError={listing.lastSyncError}
        listingUrl={listing.listingUrl}
        master={master}
        hasPriceOverride={listing.priceOverride != null}
        hasQuantityOverride={listing.quantityOverride != null}
        hasTitleOverride={listing.titleOverride != null && listing.titleOverride.length > 0}
        followMasterPrice={listing.followMasterPrice}
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
          title={c.title}
          lastSyncError={c.lastSyncError}
          listingUrl={c.listingUrl}
          master={master}
          hasPriceOverride={c.hasPriceOverride}
          hasQuantityOverride={c.hasQuantityOverride}
          hasTitleOverride={c.hasTitleOverride}
          followMasterPrice={c.followMasterPrice}
          onClick={() => onSwitchListing(c.id)}
        />
      ))}

      {companions.length === 0 && (
        <div className="border border-dashed border-slate-300 rounded-md py-6 text-center text-sm text-slate-500">
          {t('listings.drawer.empty')}
          <div className="mt-2">
            <Link
              href={`/products/${listing.productId}/list-wizard`}
              className="inline-flex items-center gap-1.5 text-blue-600 hover:underline"
            >
              <Plus size={11} /> {t('listings.drawer.listOnAnother')}
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

// C.10 — leftmost reference in the comparison stack. Distinct slate
// background so it never reads as a channel card. Shows master
// price/qty/title; every CompanionCard below diffs against these
// values via the existing DriftBadge component.
function ComparisonMasterCard({
  master,
}: {
  master: { title: string | null; price: number | null; quantity: number | null }
}) {
  const { t } = useTranslations()
  return (
    <div className="flex items-start gap-3 p-2.5 border border-slate-300 rounded-md bg-slate-50">
      <span className="inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border border-slate-300 rounded bg-white text-slate-700 flex-shrink-0">
        {t('listings.drawer.master')}
      </span>
      <div className="flex-1 min-w-0">
        {master.title && (
          <div className="text-sm text-slate-700 truncate" title={master.title}>
            {master.title}
          </div>
        )}
        <div className="flex items-center gap-3 mt-0.5 text-xs tabular-nums text-slate-500">
          {master.price != null && <span>Price {master.price.toFixed(2)}</span>}
          {master.quantity != null && <span>Stock {master.quantity}</span>}
        </div>
      </div>
      <div className="text-xs text-slate-400 flex-shrink-0">{t('listings.matrix.reference')}</div>
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
  title,
  lastSyncError,
  listingUrl,
  master,
  hasPriceOverride,
  hasQuantityOverride,
  hasTitleOverride,
  followMasterPrice,
  onClick,
  isCurrent,
}: {
  channel: string
  marketplace: string
  listingStatus: string
  syncStatus?: string | null
  price: number | null
  quantity: number | null
  title?: string | null
  lastSyncError?: string | null
  listingUrl?: string | null
  master: { title: string | null; price: number | null; quantity: number | null }
  hasPriceOverride?: boolean
  hasQuantityOverride?: boolean
  hasTitleOverride?: boolean
  followMasterPrice?: boolean
  onClick?: () => void
  isCurrent?: boolean
}) {
  const { t } = useTranslations()
  // C.10 — drift computations + override surfacing. Logic is the same
  // shape as MatrixCell's: divergence from master regardless of the
  // followMaster flags (a "follows master" cell with stale value IS
  // drift), and explicit override badges so the operator can tell at
  // a glance which fields were touched per-marketplace vs inherited.
  const priceDrift =
    price != null && master.price != null && price !== master.price
      ? price - master.price
      : null
  const qtyDrift =
    quantity != null &&
    master.quantity != null &&
    quantity !== master.quantity
      ? quantity - master.quantity
      : null
  const titleDrift =
    title != null &&
    master.title != null &&
    title.trim() !== master.title.trim()
  const truncatedTitle =
    title && title.length > 60 ? title.slice(0, 60) + '…' : title

  const Inner = (
    <div
      className={`p-2.5 border rounded-md ${isCurrent ? 'border-blue-300 bg-blue-50/50' : 'border-slate-200 bg-white hover:bg-slate-50 cursor-pointer'}`}
    >
      <div className="flex items-center gap-3 flex-wrap">
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
        <div className="ml-auto flex items-center gap-2 text-sm tabular-nums flex-wrap">
          {price != null && (
            <span className="text-slate-700 inline-flex items-center gap-1">
              {Number(price).toFixed(2)}
              {priceDrift != null && <DriftBadge delta={priceDrift} unit="price" />}
              {hasPriceOverride && <OverridePill labelKey="listings.drawer.override" />}
              {!hasPriceOverride && followMasterPrice === false && (
                <OverridePill labelKey="listings.drawer.unfollowed" tone="amber" />
              )}
            </span>
          )}
          {quantity != null && (
            <span className="text-slate-500 inline-flex items-center gap-1">
              {quantity} pcs
              {qtyDrift != null && <DriftBadge delta={qtyDrift} unit="qty" />}
              {hasQuantityOverride && <OverridePill labelKey="listings.drawer.override" />}
            </span>
          )}
          {isCurrent ? (
            <Badge variant="info" size="sm">{t('listings.drawer.current')}</Badge>
          ) : (
            <ArrowUpRight size={12} className="text-slate-400" />
          )}
        </div>
      </div>
      {(truncatedTitle || titleDrift || hasTitleOverride) && (
        <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-500 flex-wrap">
          <span className="text-slate-400 uppercase tracking-wider">{t('listings.drawer.titleLabel')}</span>
          <span className="truncate flex-1 min-w-0" title={title ?? undefined}>
            {truncatedTitle ?? '—'}
          </span>
          {titleDrift && (
            <span className="inline-flex items-center px-1 rounded border bg-amber-50 border-amber-200 text-amber-700">
              ⚠ {t('listings.drawer.titleDiffers')}
            </span>
          )}
          {hasTitleOverride && <OverridePill labelKey="listings.drawer.override" />}
        </div>
      )}
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
          <ExternalLink size={9} /> {t('listings.drawer.openOnMarketplace')}
        </a>
      )}
    </div>
  )
}

// C.10 — small badge that flags an explicit per-marketplace override
// on a field. Distinct from DriftBadge: a drift badge says "the value
// differs from master right now"; an override pill says "the operator
// explicitly set this value to be different (or is unfollowing the
// master link)." Both can co-occur — that's expected.
function OverridePill({
  labelKey,
  tone = 'blue',
}: {
  labelKey: string
  tone?: 'blue' | 'amber'
}) {
  const { t } = useTranslations()
  const label = t(labelKey)
  const toneClass =
    tone === 'amber'
      ? 'bg-amber-50 border-amber-200 text-amber-700'
      : 'bg-blue-50 border-blue-200 text-blue-700'
  return (
    <span
      className={`inline-flex items-center px-1 rounded border text-xs uppercase tracking-wider ${toneClass}`}
      aria-label={label}
    >
      {label}
    </span>
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
// SavedViewsButton — C.11. Dropdown menu over the user's
// /api/saved-views?surface=listings rows. Mirrors the /products
// SavedViewsButton layout (Bookmark icon, list with star + delete,
// Save current view button → name input). Alert support is omitted
// here because /listings doesn't have alert wiring yet — the bell
// icon + alertSummary badges from /products would be dead UI.
// ────────────────────────────────────────────────────────────────────
function SavedViewsButton({
  open,
  setOpen,
  views,
  onApply,
  onSaveCurrent,
  onDelete,
  onSetDefault,
}: {
  open: boolean
  setOpen: (v: boolean) => void
  views: SavedListingsView[]
  onApply: (view: SavedListingsView) => void
  onSaveCurrent: (name: string, isDefault: boolean) => Promise<boolean>
  onDelete: (id: string) => void
  onSetDefault: (id: string) => void
}) {
  const askConfirm = useConfirm()
  const { t } = useTranslations()
  const [saveMode, setSaveMode] = useState(false)
  const [name, setName] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Click-outside dismiss. Listening on mousedown (not click) so the
  // menu closes before any focus event from the new target lands —
  // matches /products' SavedViewsButton pattern.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [setOpen])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Bookmark size={12} /> {t('listings.savedViews.button')} <ChevronDown size={12} />
      </button>
      {open && (
        <div
          className="absolute left-0 top-full mt-1 w-72 bg-white border border-slate-200 rounded-md shadow-lg z-20 p-2"
          role="menu"
        >
          {!saveMode ? (
            <>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 px-2 py-1.5">
                {t('listings.savedViews.heading')}
              </div>
              {views.length === 0 ? (
                <div className="px-2 py-3 text-base text-slate-400 text-center">
                  {t('listings.savedViews.empty')}
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {views.map((v) => (
                    <li
                      key={v.id}
                      className="flex items-center justify-between gap-1 px-2 py-1.5 hover:bg-slate-50 rounded"
                    >
                      <button
                        onClick={() => onApply(v)}
                        className="flex-1 min-w-0 text-left text-base text-slate-900 inline-flex items-center gap-1.5"
                      >
                        {v.isDefault && (
                          <Star
                            size={10}
                            className="text-amber-500 fill-amber-500"
                          />
                        )}
                        <span className="truncate">{v.name}</span>
                      </button>
                      <button
                        onClick={() => onSetDefault(v.id)}
                        title="Set as default"
                        aria-label={`Set "${v.name}" as default view`}
                        className="h-6 w-6 inline-flex items-center justify-center text-slate-400 hover:text-amber-500"
                      >
                        <Star size={12} />
                      </button>
                      <button
                        onClick={async () => {
                          const ok = await askConfirm({
                            title: t('listings.savedViews.deleteConfirm.title', { name: v.name }),
                            description: t('listings.savedViews.deleteConfirm.description'),
                            confirmLabel: t('common.delete'),
                            tone: 'danger',
                          })
                          if (ok) onDelete(v.id)
                        }}
                        title={t('common.delete')}
                        aria-label={`Delete saved view "${v.name}"`}
                        className="h-6 w-6 inline-flex items-center justify-center text-slate-400 hover:text-rose-600"
                      >
                        <Trash2 size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                onClick={() => setSaveMode(true)}
                className="w-full mt-1 h-8 px-2 text-base bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 inline-flex items-center justify-center gap-1.5"
              >
                <BookmarkPlus size={12} /> {t('listings.savedViews.saveCurrent')}
              </button>
            </>
          ) : (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 px-2 py-1">
                {t('listings.savedViews.saveCurrent')}
              </div>
              <input
                autoFocus
                type="text"
                placeholder={t('listings.savedViews.namePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full h-8 px-2 text-md border border-slate-200 rounded"
              />
              <label className="flex items-center gap-2 px-2 text-base text-slate-700">
                <input
                  type="checkbox"
                  checked={isDefault}
                  onChange={(e) => setIsDefault(e.target.checked)}
                />
                {t('listings.savedViews.useAsDefault')}
              </label>
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    if (!name.trim()) return
                    const ok = await onSaveCurrent(name.trim(), isDefault)
                    if (ok) {
                      setSaveMode(false)
                      setName('')
                      setIsDefault(false)
                      setOpen(false)
                    }
                  }}
                  className="flex-1 h-8 text-base bg-slate-900 text-white rounded hover:bg-slate-800"
                >
                  {t('common.save')}
                </button>
                <button
                  onClick={() => {
                    setSaveMode(false)
                    setName('')
                  }}
                  className="flex-1 h-8 text-base border border-slate-200 rounded hover:bg-slate-50"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
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
  // S.4 — real history from the SyncAttempt table. Refreshes via
  // usePolledList so SSE-driven invalidation events update the
  // timeline without a manual refetch.
  const historyUrl = useMemo(
    () => `/api/listings/${listing.id}/sync-history?limit=25`,
    [listing.id],
  )
  const { data: historyData, loading: historyLoading } = usePolledList<{
    attempts: Array<{ id: string; attemptedAt: string; status: string; source: string; durationMs: number | null; error: string | null }>
    count: number
  }>({
    url: historyUrl,
    intervalMs: 30_000,
    invalidationTypes: ['listing.updated'],
  })

  const attempts = historyData?.attempts ?? []

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

      <div>
        <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-2">
          Sync history
          {historyData && (
            <span className="ml-2 normal-case font-normal text-slate-400">
              {historyData.count} attempt{historyData.count === 1 ? '' : 's'}
            </span>
          )}
        </div>
        {historyLoading && attempts.length === 0 ? (
          <Skeleton variant="text" lines={3} />
        ) : attempts.length === 0 ? (
          <div className="border-l-2 border-slate-200 pl-3 space-y-3">
            <TimelineEntry
              status="CREATED"
              when={listing.createdAt}
              detail={`Listing record created (version ${listing.version}). No sync attempts yet.`}
            />
          </div>
        ) : (
          <div className="border-l-2 border-slate-200 pl-3 space-y-3">
            {attempts.map((a) => (
              <TimelineEntry
                key={a.id}
                status={a.status}
                when={a.attemptedAt}
                detail={
                  a.status === 'SUCCESS'
                    ? `Synced successfully${a.durationMs != null ? ` in ${a.durationMs}ms` : ''} (${a.source})`
                    : a.status === 'IN_PROGRESS'
                      ? `Sync in progress (${a.source})`
                      : a.error ?? `${a.status} (${a.source})`
                }
              />
            ))}
            <TimelineEntry
              status="CREATED"
              when={listing.createdAt}
              detail={`Listing record created (version ${listing.version})`}
            />
          </div>
        )}
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

// ────────────────────────────────────────────────────────────────────
// KeyboardShortcutsHelp — U.1 modal (opens via `?`).
// Lists every shortcut wired into the workspace's keydown handler so
// operators discover the productivity layer without trial and error.
// ────────────────────────────────────────────────────────────────────
function KeyboardShortcutsHelp({ onClose }: { onClose: () => void }) {
  const shortcuts: Array<{ keys: string[]; description: string; section: string }> = [
    { section: 'Navigation', keys: ['/'], description: 'Focus search' },
    { section: 'Navigation', keys: ['j', '↓'], description: 'Move to next row' },
    { section: 'Navigation', keys: ['k', '↑'], description: 'Move to previous row' },
    { section: 'Navigation', keys: ['g', 'g'], description: 'Jump to first row' },
    { section: 'Navigation', keys: ['G'], description: 'Jump to last row' },
    { section: 'Actions', keys: ['Enter'], description: 'Open detail drawer for active row' },
    { section: 'Actions', keys: ['Space'], description: 'Toggle selection on active row' },
    { section: 'Actions', keys: ['Esc'], description: 'Close drawer / clear search / drop active row' },
    { section: 'Actions', keys: ['?'], description: 'Show this shortcut list' },
    { section: 'Tip', keys: [], description: 'Click a price or stock cell to edit it inline; Enter saves, Esc cancels.' },
  ]
  const sections = Array.from(new Set(shortcuts.map((s) => s.section)))
  return (
    <Modal open onClose={onClose} title="Keyboard shortcuts" size="md">
      <ModalBody>
        <div className="space-y-4">
          {sections.map((section) => (
            <div key={section}>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
                {section}
              </div>
              <ul className="space-y-1.5">
                {shortcuts
                  .filter((s) => s.section === section)
                  .map((s, i) => (
                    <li
                      key={`${section}-${i}`}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="text-slate-700 flex-1">{s.description}</span>
                      <span className="inline-flex items-center gap-1">
                        {s.keys.map((k, j) => (
                          <kbd
                            key={j}
                            className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 text-xs font-mono bg-white border border-slate-300 rounded shadow-sm"
                          >
                            {k}
                          </kbd>
                        ))}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          onClick={onClose}
          className="h-8 px-3 text-base bg-slate-900 text-white rounded hover:bg-slate-800"
        >
          Got it
        </button>
      </ModalFooter>
    </Modal>
  )
}
