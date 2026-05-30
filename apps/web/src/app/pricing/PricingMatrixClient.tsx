'use client'

// G.4.1 — Pricing matrix workspace.
//
// Reads PricingSnapshot rows for a flat table view: SKU + (channel,
// marketplace, fulfillment) per cell. Each cell shows resolved price +
// currency + source + warning chip. Click a row → drawer with full
// breakdown / history / explain / push.
//
// G.6 — Row checkboxes + floating bulk-override bar: select N rows,
// apply SET_FIXED / SET_PERCENT_DISCOUNT / CLEAR, snapshots refresh.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  Box,
  ChevronRight,
  Clock,
  Keyboard,
  Loader2,
  Search,
  Send,
  Settings2,
  Tag,
  TrendingDown,
  Trophy,
  X,
  Zap,
} from 'lucide-react'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import {
  AutoRefreshSelect,
  DensityToggle as SharedDensityToggle,
  FilterPopover,
  GridToolbar,
  KeyboardShortcutsModal,
  KpiStrip as SharedKpiStrip,
  PreferencesModal,
  ProductIdentityCell,
  VirtualizedGrid,
  type AutoRefreshInterval,
  type Density,
  type FilterDimension,
  type GridLensColumn,
  type GridLensRow,
  type KpiTileSpec,
  type PreferencesValue,
  type ShortcutGroup,
} from '@/app/_shared/grid-lens'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Modal, ModalBody } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import RepricerStatusBanner from './_components/RepricerStatusBanner'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { DENSITY_CELL_CLASS } from '@/lib/products/theme'

// SnapshotRow is the unit of the drawer (per-channel pricing). It's the
// shape returned by the legacy flat matrix endpoint plus the new
// "channelChips" entries on variant rows. The drawer needs all of these.
interface SnapshotRow {
  id: string
  sku: string
  channel: string
  marketplace: string
  fulfillmentMethod: string | null
  computedPrice: string
  currency: string
  source: string
  breakdown: any
  isClamped: boolean
  clampedFrom: string | null
  warnings: string[]
  computedAt?: string
}

// P.A — Parent row from /api/pricing/matrix?hierarchy=parents.
interface ParentRow extends GridLensRow {
  id: string
  isParent: boolean
  parentId: null
  childCount: number
  productId: string | null
  sku: string
  name: string
  amazonAsin: string | null
  thumbnailUrl: string | null
  isOrphan: boolean
  snapshotCount: number
  clampedCount: number
  fallbackCount: number
  warningsCount: number
  avgPriceCents: number | null
}

// P.A — Variant row from /api/pricing/matrix?hierarchy=children.
interface VariantRow extends GridLensRow {
  id: string
  isParent: false
  parentId: string
  childCount: 0
  productId: string | null
  variantSku: string
  sku: string
  name: string
  amazonAsin: string | null
  thumbnailUrl: string | null
  variationAttributes: Record<string, unknown> | null
  primary: SnapshotRow
  channelChips: SnapshotRow[]
  snapshotCount: number
  snapshotIds: string[]
}

// A "row" in the grid is either a parent or a variant — both implement
// GridLensRow so VirtualizedGrid can lay them out side by side.
type GridRow = ParentRow

interface ParentsResponse {
  rows: ParentRow[]
  total: number
  page: number
  limit: number
  hierarchy: 'parents'
}

interface ChildrenResponse {
  rows: VariantRow[]
  total: number
  hierarchy: 'children'
}

interface KpiResponse {
  drift: number
  alerts: number
  salesActive: number
  snapshots: { total: number; oldestAgeHours: number | null }
  marginAtRisk: number
  buyBox: {
    winRatePct: number | null
    observations: number
    ourWins: number
  }
}

const SOURCE_TONE: Record<string, string> = {
  SCHEDULED_SALE: 'bg-pink-50 dark:bg-pink-950 text-pink-700 dark:text-pink-300 border-pink-200 dark:border-pink-900',
  OFFER_OVERRIDE: 'bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900',
  CHANNEL_OVERRIDE: 'bg-violet-50 dark:bg-violet-950 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900',
  CHANNEL_RULE: 'bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-900',
  PRICING_RULE: 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
  MASTER_INHERIT: 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800',
  FALLBACK: 'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900',
}

// E.1.b — concise display labels for pricing source chips. The raw
// enum keys are screamy and operator-hostile; SOURCE_LABEL maps each
// to a friendly form. Falls back to the raw key for any new source
// the engine adds before this map gets updated.
const SOURCE_LABEL: Record<string, string> = {
  SCHEDULED_SALE: 'Sale',
  OFFER_OVERRIDE: 'Offer',
  CHANNEL_OVERRIDE: 'Channel override',
  CHANNEL_RULE: 'Channel rule',
  PRICING_RULE: 'Rule',
  MASTER_INHERIT: 'Master',
  FALLBACK: 'Fallback',
}

export default function PricingMatrixClient() {
  const { t } = useTranslations()
  const [data, setData] = useState<ParentsResponse | null>(null)
  const [kpis, setKpis] = useState<KpiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [density, setDensity] = useState<Density>(() => {
    if (typeof window === 'undefined') return 'comfortable'
    const v = window.localStorage.getItem('pricing.density') as Density | null
    return v === 'compact' || v === 'comfortable' || v === 'spacious' ? v : 'comfortable'
  })
  useEffect(() => { try { window.localStorage.setItem('pricing.density', density) } catch {} }, [density])
  const [autoRefreshMin, setAutoRefreshMin] = useState<AutoRefreshInterval>(() => {
    if (typeof window === 'undefined') return 0
    const n = Number(window.localStorage.getItem('pricing.autoRefreshMin'))
    return (n === 5 || n === 15) ? n : 0
  })
  useEffect(() => { try { window.localStorage.setItem('pricing.autoRefreshMin', String(autoRefreshMin)) } catch {} }, [autoRefreshMin])

  // XG.6 — shared PreferencesModal state. Sticky toggles + visible
  // columns persist to localStorage. Per the audit, /pricing is the
  // lightest-touch migration: no in-row ActionCluster (drawer-only
  // paradigm stays), no page-size choice (fixed), no sort dropdown
  // (sort happens via column-header click). Only sticky + visibility.
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [stickyFirstColumn, setStickyFirstColumn] = useState<boolean>(true)
  const [stickyLastColumn, setStickyLastColumn] = useState<boolean>(true)
  const PRICING_DEFAULT_VISIBLE = ['identity', 'price', 'source', 'channels', 'warnings']
  const [visibleColumns, setVisibleColumns] = useState<string[]>(PRICING_DEFAULT_VISIBLE)
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const sl = window.localStorage.getItem('pricing.stickyFirstColumn')
      if (sl !== null) setStickyFirstColumn(sl !== 'false')
      const sr = window.localStorage.getItem('pricing.stickyLastColumn')
      if (sr !== null) setStickyLastColumn(sr !== 'false')
      const vc = window.localStorage.getItem('pricing.visibleColumns')
      if (vc) {
        const parsed = JSON.parse(vc) as string[]
        if (Array.isArray(parsed) && parsed.length > 0) setVisibleColumns(parsed)
      }
    } catch { /* ignore */ }
  }, [])
  useEffect(() => { try { window.localStorage.setItem('pricing.stickyFirstColumn', String(stickyFirstColumn)) } catch {} }, [stickyFirstColumn])
  useEffect(() => { try { window.localStorage.setItem('pricing.stickyLastColumn', String(stickyLastColumn)) } catch {} }, [stickyLastColumn])
  useEffect(() => { try { window.localStorage.setItem('pricing.visibleColumns', JSON.stringify(visibleColumns)) } catch {} }, [visibleColumns])

  const [search, setSearch] = useState('')
  const [channel, setChannel] = useState('')
  const [marketplace, setMarketplace] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [clampedOnly, setClampedOnly] = useState(false)
  const [page, setPage] = useState(0)
  const [drawerRow, setDrawerRow] = useState<SnapshotRow | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // P.C — hierarchy state. Mirror the /products + /stock pattern:
  //   expandedParents  : parents whose chevron is open
  //   childrenByParent : variant rows already fetched (cached)
  //   loadingChildren  : parents whose fetch is in flight
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [childrenByParent, setChildrenByParent] = useState<Record<string, VariantRow[]>>({})
  const [loadingChildren, setLoadingChildren] = useState<Set<string>>(new Set())
  // Mirror in a ref so fetchData can read the current expanded set on
  // poll-refresh without re-creating itself on every expand. Mirrors
  // /fulfillment/stock/StockWorkspace.tsx:665-710 — the fix for the
  // "fetch failed — try collapsing and re-opening" bug.
  const expandedParentsRef = useRef<Set<string>>(new Set())
  useEffect(() => { expandedParentsRef.current = expandedParents }, [expandedParents])

  // G.6 — bulk selection. Until P.D, parent rows are non-selectable and
  // we operate on per-channel snapshot ids selected on variant rows.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkMode, setBulkMode] = useState<'SET_FIXED' | 'SET_PERCENT_DISCOUNT' | 'CLEAR'>('SET_FIXED')
  const [bulkValue, setBulkValue] = useState('')
  const [bulkApplying, setBulkApplying] = useState(false)
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false)
  const { toast } = useToast()

  // Lazy-load a parent's variant rows. Cached after first fetch.
  const fetchChildrenFor = useCallback(async (parentId: string) => {
    if (childrenByParent[parentId]) return // cache hit
    setLoadingChildren((prev) => {
      const next = new Set(prev)
      next.add(parentId)
      return next
    })
    try {
      const qs = new URLSearchParams({ hierarchy: 'children', parentId })
      if (channel) qs.set('channel', channel)
      if (marketplace) qs.set('marketplace', marketplace)
      if (sourceFilter) qs.set('source', sourceFilter)
      if (clampedOnly) qs.set('isClamped', 'true')
      const res = await fetch(
        `${getBackendUrl()}/api/pricing/matrix?${qs.toString()}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const json = (await res.json()) as ChildrenResponse
      setChildrenByParent((prev) => ({ ...prev, [parentId]: json.rows ?? [] }))
    } catch {
      // On failure, cache [] so the row shows "no variants" instead of
      // an infinite spinner. Re-collapse + re-expand retries.
      setChildrenByParent((prev) => ({ ...prev, [parentId]: [] }))
    } finally {
      setLoadingChildren((prev) => {
        const next = new Set(prev)
        next.delete(parentId)
        return next
      })
    }
  }, [childrenByParent, channel, marketplace, sourceFilter, clampedOnly])

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

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({
        hierarchy: 'parents',
        page: String(page),
        limit: '100',
      })
      if (search) qs.set('search', search)
      if (channel) qs.set('channel', channel)
      if (marketplace) qs.set('marketplace', marketplace)
      if (sourceFilter) qs.set('source', sourceFilter)
      if (clampedOnly) qs.set('isClamped', 'true')
      const res = await fetch(
        `${getBackendUrl()}/api/pricing/matrix?${qs.toString()}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as ParentsResponse
      setData(json)
      setLastFetchedAt(Date.now())
      // Stale-expansion fix (mirrors /stock): re-fetch every currently-
      // expanded parent so their variant rows stay in step with the new
      // top-level state. Wiping outright leaves the cache empty while
      // expandedParents stays populated → "Reloading variants…" placeholder.
      const expanded = Array.from(expandedParentsRef.current)
      if (expanded.length > 0) {
        const fresh = await Promise.all(
          expanded.map(async (pid) => {
            try {
              const childQs = new URLSearchParams({ hierarchy: 'children', parentId: pid })
              if (channel) childQs.set('channel', channel)
              if (marketplace) childQs.set('marketplace', marketplace)
              if (sourceFilter) childQs.set('source', sourceFilter)
              if (clampedOnly) childQs.set('isClamped', 'true')
              const r = await fetch(
                `${getBackendUrl()}/api/pricing/matrix?${childQs.toString()}`,
                { cache: 'no-store' },
              )
              if (!r.ok) return [pid, [] as VariantRow[]] as const
              const d = (await r.json()) as ChildrenResponse
              return [pid, d.rows ?? []] as const
            } catch {
              return [pid, [] as VariantRow[]] as const
            }
          }),
        )
        setChildrenByParent(Object.fromEntries(fresh))
      } else {
        setChildrenByParent({})
      }
      setSelected(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [page, search, channel, marketplace, sourceFilter, clampedOnly])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // KPI strip — independent fetch so a slow KPI query doesn't block the
  // matrix table render. Refetched alongside the table on every refresh
  // so counts stay in step with whatever the user just did.
  const fetchKpis = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/pricing/kpis`, {
        cache: 'no-store',
      })
      if (res.ok) setKpis((await res.json()) as KpiResponse)
    } catch {
      // KPI strip is non-blocking. Render '—' if it fails.
    }
  }, [])

  useEffect(() => {
    fetchKpis()
  }, [fetchKpis])

  const refreshAll = async () => {
    setRefreshing(true)
    try {
      await fetch(`${getBackendUrl()}/api/pricing/refresh-snapshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      await Promise.all([fetchData(), fetchKpis()])
    } finally {
      setRefreshing(false)
    }
  }

  const totalPages = data ? Math.ceil(data.total / data.limit) : 0
  // P.D — bulk-select cascade. `selected` stays canonical at the
  // per-snapshot-id level (because that's what the bulk-override API
  // consumes). On top of that we derive a set of row ids whose entire
  // underlying snapshot set is selected — used by VirtualizedGrid for
  // the row checkbox display. `toggleRow` interprets the id:
  //   - parent productId  → cascade to every variant × every channel
  //   - variant:SKU       → cascade to every channel chip
  //   - snapshot id       → toggle that one

  // Walk every parent's variants (cached + visible only) and return
  // the snapshot ids that belong to a given row id, plus the variant
  // ids belonging to a parent id (for derived display).
  const snapshotIdsForRow = useCallback((rowId: string): string[] => {
    // Variant row?
    if (rowId.startsWith('variant:')) {
      for (const parentId of Object.keys(childrenByParent)) {
        const variant = childrenByParent[parentId].find((v) => v.id === rowId)
        if (variant) return [...variant.snapshotIds]
      }
      return []
    }
    // Parent row? Only cascade snapshots that we've actually loaded
    // (i.e. the variants in cache). Operators have to expand the
    // parent at least once before a cascade is possible — that's the
    // same guarantee /products gives.
    const variants = childrenByParent[rowId]
    if (!variants) return []
    const ids: string[] = []
    for (const v of variants) ids.push(...v.snapshotIds)
    return ids
  }, [childrenByParent])

  // Page-level "select all": every snapshot id under every loaded
  // variant. Parents whose chevron has never been opened contribute
  // nothing (consistent with /products lazy hierarchy).
  const allPageSnapshotIds = useMemo(() => {
    const ids: string[] = []
    for (const parent of data?.rows ?? []) {
      const variants = childrenByParent[parent.id] ?? []
      for (const v of variants) ids.push(...v.snapshotIds)
    }
    return ids
  }, [data, childrenByParent])
  const allPageSelected =
    allPageSnapshotIds.length > 0 && allPageSnapshotIds.every((id) => selected.has(id))

  // Derived display set: includes parent + variant row ids whose
  // entire snapshot set is in `selected`. VirtualizedGrid reads this
  // to fill the row checkbox.
  const displaySelected = useMemo(() => {
    const out = new Set<string>(selected)
    // Variants
    for (const variants of Object.values(childrenByParent)) {
      for (const v of variants) {
        if (v.snapshotIds.length > 0 && v.snapshotIds.every((id) => selected.has(id))) {
          out.add(v.id)
        }
      }
    }
    // Parents — only if every loaded variant beneath is fully selected
    for (const parent of data?.rows ?? []) {
      const variants = childrenByParent[parent.id]
      if (!variants || variants.length === 0) continue
      const allFull = variants.every(
        (v) => v.snapshotIds.length > 0 && v.snapshotIds.every((id) => selected.has(id)),
      )
      if (allFull) out.add(parent.id)
    }
    return out
  }, [selected, childrenByParent, data])

  const toggleAll = () => {
    if (allPageSelected) {
      setSelected((prev) => {
        const next = new Set(prev)
        allPageSnapshotIds.forEach((id) => next.delete(id))
        return next
      })
    } else {
      setSelected((prev) => new Set([...prev, ...allPageSnapshotIds]))
    }
  }

  const toggleRow = useCallback((id: string) => {
    // Cascade-capable ids: parent productId, or 'variant:SKU'.
    const cascadeIds = snapshotIdsForRow(id)
    if (cascadeIds.length > 0) {
      setSelected((prev) => {
        // If every cascade target is already selected, deselect all.
        // Otherwise, add them all.
        const allOn = cascadeIds.every((sid) => prev.has(sid))
        const next = new Set(prev)
        if (allOn) {
          for (const sid of cascadeIds) next.delete(sid)
        } else {
          for (const sid of cascadeIds) next.add(sid)
        }
        return next
      })
      return
    }
    // Single snapshot id (from ChannelChip ⌘+click, or variant's
    // primary checkbox in the warnings cell).
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [snapshotIdsForRow])

  // Cascade-scope summary for the confirmation modal.
  // Crosses every variant cache and counts (snapshots, variants,
  // products) currently in the selection set.
  const cascadeScope = useMemo(() => {
    let snapshots = 0
    const variants = new Set<string>()
    const products = new Set<string>()
    for (const parent of data?.rows ?? []) {
      const childVariants = childrenByParent[parent.id] ?? []
      let parentTouched = false
      for (const v of childVariants) {
        let variantTouched = false
        for (const sid of v.snapshotIds) {
          if (selected.has(sid)) {
            snapshots += 1
            variantTouched = true
            parentTouched = true
          }
        }
        if (variantTouched) variants.add(v.id)
      }
      if (parentTouched) products.add(parent.id)
    }
    return { snapshots, variants: variants.size, products: products.size }
  }, [selected, childrenByParent, data])

  // Open the drawer from any per-channel snapshot. The drawer is the
  // primary affordance for inspecting + pushing a single price; it
  // continues to operate at snapshot granularity even though the grid
  // groups them under variants/parents.
  const openDrawer = useCallback((snap: SnapshotRow) => {
    setDrawerRow(snap)
  }, [])

  // P.E — shared FilterPopover dimensions. Matches /products by
  // converting the bespoke MultiSelectChips + native <select> +
  // checkbox into a single Filter chip with reorderable cards.
  const ACTIVE_CHANNELS = [
    { value: 'AMAZON',  label: 'Amazon' },
    { value: 'EBAY',    label: 'eBay' },
    { value: 'SHOPIFY', label: 'Shopify' },
  ]
  const ACTIVE_MARKETPLACES = [
    { value: 'AMAZON_IT', label: 'Amazon IT' },
    { value: 'AMAZON_DE', label: 'Amazon DE' },
    { value: 'AMAZON_FR', label: 'Amazon FR' },
    { value: 'AMAZON_ES', label: 'Amazon ES' },
    { value: 'AMAZON_UK', label: 'Amazon UK' },
    { value: 'EBAY_IT',   label: 'eBay IT' },
    { value: 'EBAY_DE',   label: 'eBay DE' },
  ]
  const SOURCE_OPTIONS = [
    { value: 'SCHEDULED_SALE',   label: 'Sale' },
    { value: 'OFFER_OVERRIDE',   label: 'Offer' },
    { value: 'CHANNEL_OVERRIDE', label: 'Channel override' },
    { value: 'CHANNEL_RULE',     label: 'Channel rule' },
    { value: 'PRICING_RULE',     label: 'Rule' },
    { value: 'MASTER_INHERIT',   label: 'Master' },
    { value: 'FALLBACK',         label: 'Fallback' },
  ]

  const filterDimensions: FilterDimension[] = [
    {
      key: 'channel',
      label: 'Channel',
      type: 'single-select',
      options: ACTIVE_CHANNELS,
      value: channel || null,
      onChange: (next) => { setChannel(next ?? ''); setPage(0) },
    },
    {
      key: 'marketplace',
      label: 'Marketplace',
      type: 'single-select',
      options: ACTIVE_MARKETPLACES,
      value: marketplace || null,
      onChange: (next) => { setMarketplace(next ?? ''); setPage(0) },
    },
    {
      key: 'source',
      label: 'Source',
      type: 'single-select',
      options: SOURCE_OPTIONS,
      value: sourceFilter || null,
      onChange: (next) => { setSourceFilter(next ?? ''); setPage(0) },
    },
    {
      key: 'clamped',
      label: 'Clamped only',
      type: 'toggle',
      value: clampedOnly,
      onChange: (next) => { setClampedOnly(next); setPage(0) },
    },
  ]

  const activeFilterCount =
    (channel ? 1 : 0) + (marketplace ? 1 : 0) +
    (sourceFilter ? 1 : 0) + (clampedOnly ? 1 : 0)

  const clearAllFilters = () => {
    setChannel('')
    setMarketplace('')
    setSourceFilter('')
    setClampedOnly(false)
    setPage(0)
  }

  // Persisted dimension order — mirrors /products' filterOrder.
  const [filterOrder, setFilterOrder] = useState<string[]>(() => {
    if (typeof window === 'undefined') return []
    try {
      const raw = window.localStorage.getItem('pricing.filterOrder')
      return raw ? (JSON.parse(raw) as string[]) : []
    } catch { return [] }
  })
  useEffect(() => {
    try { window.localStorage.setItem('pricing.filterOrder', JSON.stringify(filterOrder)) } catch {}
  }, [filterOrder])

  // P.E — KPI tile spec built from the existing KpiResponse shape.
  // Drift + Alerts deep-link to /pricing/alerts; On Sale → /pricing/promotions.
  // Snapshot-age + Buy Box are read-only.
  const kpiTiles = useMemo((): KpiTileSpec[] => {
    const stale = kpis?.snapshots.oldestAgeHours
    const staleTone: KpiTileSpec['tone'] =
      stale == null ? 'slate' :
      stale <= 1   ? 'emerald' :
      stale <= 4   ? 'amber'   : 'rose'
    const staleLabel = stale == null ? '—' : stale < 1 ? '<1h' : `${Math.round(stale)}h`

    const wr = kpis?.buyBox.winRatePct
    const buyBoxTone: KpiTileSpec['tone'] =
      wr == null ? 'slate' :
      wr <  50   ? 'rose'  :
      wr <  80   ? 'amber' : 'emerald'
    const buyBoxLabel = wr == null ? '—' : `${wr.toFixed(1)}%`
    const buyBoxDetail = kpis && kpis.buyBox.observations > 0
      ? t('pricing.kpi.buyBoxHint', { wins: kpis.buyBox.ourWins, obs: kpis.buyBox.observations })
      : t('pricing.kpi.buyBoxHintEmpty')

    return [
      {
        icon: TrendingDown,
        label: t('pricing.kpi.drift'),
        value: String(kpis?.drift ?? '—'),
        detail: t('pricing.kpi.driftHint'),
        tone: kpis && kpis.drift > 0 ? 'rose' : 'slate',
        onClick: () => { window.location.href = '/pricing/alerts' },
      },
      {
        icon: AlertTriangle,
        label: t('pricing.kpi.alerts'),
        value: String(kpis?.alerts ?? '—'),
        detail: t('pricing.kpi.alertsHint'),
        tone: kpis && kpis.alerts > 0 ? 'amber' : 'slate',
        onClick: () => { window.location.href = '/pricing/alerts' },
      },
      {
        icon: Tag,
        label: t('pricing.kpi.onSale'),
        value: String(kpis?.salesActive ?? '—'),
        detail: t('pricing.kpi.onSaleHint'),
        tone: kpis && kpis.salesActive > 0 ? 'violet' : 'slate',
        onClick: () => { window.location.href = '/pricing/promotions' },
      },
      {
        icon: Clock,
        label: t('pricing.kpi.snapshotAge'),
        value: staleLabel,
        detail: t('pricing.kpi.snapshotAgeHint'),
        tone: staleTone,
      },
      {
        icon: AlertCircle,
        label: t('pricing.kpi.noCost'),
        value: String(kpis?.marginAtRisk ?? '—'),
        detail: t('pricing.kpi.noCostHint'),
        tone: kpis && kpis.marginAtRisk > 0 ? 'amber' : 'slate',
      },
      {
        icon: Trophy,
        label: t('pricing.kpi.buyBox'),
        value: buyBoxLabel,
        detail: buyBoxDetail,
        tone: buyBoxTone,
      },
    ]
  }, [kpis, t])

  // Search input ref for the `/` keyboard shortcut.
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  // Memo'd to keep stable identity across renders (VirtualizedGrid uses
  // shallow compare). Re-builds only when locale flips.
  // XG.6 — keep the full registry around for the Preferences modal,
  // but filter to operator-visible columns for the grid. Locked
  // columns (identity, actions) always show regardless of the picker.
  const pricingColumnsAll = useMemo(() => buildPricingColumns(t), [t])
  const pricingColumns = useMemo(() => {
    return pricingColumnsAll.filter(
      (c) => c.locked || visibleColumns.includes(c.key),
    )
  }, [pricingColumnsAll, visibleColumns])

  const applyBulkOverride = async () => {
    if (selected.size === 0) return
    setBulkApplying(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/pricing/bulk-override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snapshotIds: [...selected],
          mode: bulkMode,
          value: bulkMode !== 'CLEAR' ? Number(bulkValue) : undefined,
        }),
      })
      const json = await res.json()
      if (json.ok) {
        toast.success(
          `Updated ${json.updated} listing${json.updated === 1 ? '' : 's'}, refreshed ${json.snapshotsRefreshed} snapshot${json.snapshotsRefreshed === 1 ? '' : 's'}.`,
        )
        setSelected(new Set())
        await Promise.all([fetchData(), fetchKpis()])
      } else {
        toast.error(`Bulk override failed: ${json.error ?? `HTTP ${res.status}`}`)
      }
    } catch (e) {
      toast.error(
        `Bulk override failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      setBulkApplying(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* P.E — Shared KpiStrip. Six tiles match the existing semantics
          (drift, alerts, on-sale, snapshot age, no-cost, buy-box) but
          render with the same tone palette + responsive grid as
          /products + /fulfillment/stock. */}
      <SharedKpiStrip tiles={kpiTiles} className="grid-cols-2 sm:grid-cols-3 lg:grid-cols-6" />

      {/* UI.7 — Repricer status banner */}
      <RepricerStatusBanner />

      {/* P.E — Canonical GridToolbar (matches /products). Search +
          FilterPopover + density/auto-refresh/freshness in one row. */}
      <GridToolbar
        searchSlot={
          <div className="relative flex-1 min-w-[240px] max-w-sm">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500 pointer-events-none"
            />
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t('pricing.search.placeholder')}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
              className="w-full h-8 pl-8 pr-3 text-sm border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-300 dark:focus:ring-slate-600"
            />
          </div>
        }
        filter={
          <FilterPopover
            dimensions={filterDimensions}
            onClearAll={clearAllFilters}
            activeCount={activeFilterCount}
            order={filterOrder}
            onOrderChange={setFilterOrder}
            onResetOrder={filterOrder.length > 0 ? () => setFilterOrder([]) : undefined}
            openEventName="nexus:pricing-open-filter-menu"
          />
        }
        columns={
          <button
            type="button"
            onClick={() => setPreferencesOpen(true)}
            className="h-11 sm:h-8 px-2.5 text-base inline-flex items-center gap-1.5 border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-800 text-slate-600"
            title={t('grid.preferences.trigger')}
            aria-haspopup="dialog"
          >
            <Settings2 size={12} /> {t('grid.preferences.triggerWithCount', { count: visibleColumns.length })}
          </button>
        }
        density={<SharedDensityToggle density={density} onChange={setDensity} />}
        autoRefresh={
          <AutoRefreshSelect
            value={autoRefreshMin}
            onChange={setAutoRefreshMin}
            onTick={() => { fetchData(); fetchKpis() }}
          />
        }
        freshness={
          <FreshnessIndicator
            lastFetchedAt={lastFetchedAt}
            onRefresh={fetchData}
            loading={loading}
            error={!!error}
          />
        }
        shortcuts={
          <button
            type="button"
            onClick={() => setShortcutsOpen(true)}
            className="h-7 w-7 inline-flex items-center justify-center border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <Keyboard size={12} />
          </button>
        }
        trailingSlot={
          <Button
            variant="primary"
            size="sm"
            onClick={refreshAll}
            loading={refreshing}
            disabled={refreshing}
            icon={refreshing ? null : <Zap size={12} />}
          >
            {refreshing
              ? t('pricing.action.recomputing')
              : t('pricing.action.recomputeAll')}
          </Button>
        }
      />

      {/* Bulk action bar — Toast handles success/error feedback so the bar
          stays minimal: count + mode + value + Apply + Deselect. */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-20 bg-slate-900 text-white rounded-lg px-4 py-2.5 flex items-center gap-2.5 flex-wrap shadow-lg ring-1 ring-slate-800">
          {/* Selection count — leftmost so the operator's eye lands
              here first. Big white tabular-nums, full opacity. */}
          <span className="text-base font-semibold tabular-nums text-white">
            {t('pricing.bulk.selected', {
              n: selected.size,
              s: selected.size === 1 ? '' : 's',
            })}
          </span>

          <div className="h-5 w-px bg-slate-600" />

          {/* Mode dropdown — proper visible border, white text on a
              lighter slate fill so the dropdown reads as an input
              control on the dark bar. */}
          <select
            value={bulkMode}
            onChange={(e) =>
              setBulkMode(e.target.value as typeof bulkMode)
            }
            aria-label={t('pricing.bulk.setFixed')}
            className="h-8 px-2.5 rounded-md border border-slate-500 bg-slate-700 text-white text-sm font-medium hover:bg-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <option value="SET_FIXED">{t('pricing.bulk.setFixed')}</option>
            <option value="SET_PERCENT_DISCOUNT">{t('pricing.bulk.percentDiscount')}</option>
            <option value="CLEAR">{t('pricing.bulk.clearOverride')}</option>
          </select>

          {bulkMode !== 'CLEAR' && (
            <input
              type="number"
              step="0.01"
              min="0"
              placeholder={bulkMode === 'SET_FIXED' ? '0.00' : '0–99'}
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
              aria-label={bulkMode === 'SET_FIXED' ? 'New price' : 'Discount %'}
              className="h-8 w-28 px-2.5 rounded-md border border-slate-500 bg-slate-700 text-white text-sm tabular-nums placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            />
          )}

          {/* Apply — primary CTA. Stays on the standard blue variant
              so it remains legible at the disabled state on the dark
              slate-900 bar. (The old `bg-white` override blended with
              the parent at opacity-50 and produced a near-invisible
              block. The new global disabled state in Button.tsx
              forces all disabled actions to a single muted slate
              palette, regardless of variant.) */}
          <Button
            variant="primary"
            size="sm"
            onClick={() => setBulkConfirmOpen(true)}
            loading={bulkApplying}
            disabled={bulkApplying || (bulkMode !== 'CLEAR' && !bulkValue)}
            className="font-semibold"
          >
            {t('pricing.bulk.apply')}
          </Button>

          {/* Spacer pushes Clear to the right edge so it never
              competes with Apply for the operator's attention. */}
          <div className="ml-auto" />

          {/* Clear / Deselect — secondary outlined pill (not the muted
              ghost). Now legibly says "Clear" with the X icon, distinct
              from Apply, but visually subordinate. */}
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            aria-label={t('pricing.bulk.deselect')}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-slate-500 bg-slate-800 text-white text-sm font-medium hover:bg-slate-700 hover:border-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
          >
            <X size={13} aria-hidden="true" />
            {t('pricing.bulk.deselect')}
          </button>
        </div>
      )}

      {/* P.C — VirtualizedGrid replaces the flat <table>. Parent rows come
          from /api/pricing/matrix?hierarchy=parents; clicking a chevron
          lazy-loads variant rows via ?hierarchy=children&parentId=. */}
      {loading && !data ? (
        <Card>
          <div className="text-md text-slate-500 dark:text-slate-400 py-8 text-center inline-flex items-center justify-center gap-2 w-full">
            <Loader2 className="w-4 h-4 animate-spin" /> {t('pricing.matrix.loading')}
          </div>
        </Card>
      ) : error ? (
        <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950 rounded px-3 py-2 text-base text-rose-700 dark:text-rose-300 inline-flex items-start gap-1.5">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      ) : !data || data.rows.length === 0 ? (
        <EmptyState
          icon={Box}
          title={t('pricing.matrix.empty')}
          description={t('pricing.matrix.emptyHint')}
        />
      ) : (
        <Card noPadding>
          <VirtualizedGrid<GridRow>
            rows={data.rows}
            visible={pricingColumns}
            density={density}
            cellPad={DENSITY_CELL_CLASS[density] ?? DENSITY_CELL_CLASS.comfortable}
            selected={displaySelected}
            toggleSelect={(id) => toggleRow(id)}
            toggleSelectAll={toggleAll}
            allSelected={allPageSelected}
            sortBy=""
            onSort={() => {}}
            sortKeys={{}}
            expandedParents={expandedParents}
            childrenByParent={childrenByParent as unknown as Record<string, GridRow[]>}
            loadingChildren={loadingChildren}
            onToggleExpand={toggleExpand}
            focusedRowId={null}
            searchTerm={search}
            riskFlaggedSkus={new Set()}
            storageKey="pricing-matrix"
            showExpandColumn={true}
            stickyLeft={stickyFirstColumn}
            stickyRight={stickyLastColumn}
            renderCell={(row, key) => renderPricingCell(row as ParentRow | VariantRow, key, { selected, toggleRow, openDrawer, t })}
          />

          {/* Pagination — by parent product, not by snapshot. */}
          <div className="px-4 py-2.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-base text-slate-600 dark:text-slate-400">
            <span>
              {t('pricing.grid.productsFooter', { n: data.total, s: data.total === 1 ? '' : 's' })}
              {' · '}page {data.page + 1} / {Math.max(1, totalPages)}
              {selected.size > 0 && (
                <span className="ml-3 text-blue-600 font-medium">
                  {t('pricing.grid.snapshotsSelectedFooter', { n: selected.size, s: selected.size === 1 ? '' : 's' })}
                </span>
              )}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0 || loading}
              >
                {t('pricing.pagination.prev')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={page + 1 >= totalPages || loading}
              >
                {t('pricing.pagination.next')}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Detail drawer */}
      {drawerRow && (
        <PricingDetailDrawer
          row={drawerRow}
          onClose={() => setDrawerRow(null)}
          onPushed={() => fetchData()}
        />
      )}

      {shortcutsOpen && (
        <KeyboardShortcutsModal
          groups={PRICING_SHORTCUTS}
          onClose={() => setShortcutsOpen(false)}
        />
      )}

      {/* XG.6 — shared Preferences modal. Lightest-touch parity:
          - pageSizeChoices=[] hides the page-size section (/pricing has
            fixed pagination via the backend)
          - sortFieldOptions=[] hides the sort section (/pricing sorts
            via column-header click, not a global setting)
          - No ActionCluster on rows; drawer-only paradigm stays
          So the modal effectively just shows sticky toggles + column
          visibility (operator can hide Warnings or Source if they want
          a cleaner matrix). */}
      <PreferencesModal
        open={preferencesOpen}
        onClose={() => setPreferencesOpen(false)}
        allColumns={pricingColumnsAll}
        defaultVisible={PRICING_DEFAULT_VISIBLE}
        sortFieldOptions={[]}
        pageSizeChoices={[]}
        value={{
          pageSize: 0,
          visibleColumns,
          stickyFirstColumn,
          stickyLastColumn,
          sortBy: '',
          sortDir: 'desc',
        }}
        onConfirm={(next: PreferencesValue) => {
          setVisibleColumns(
            next.visibleColumns.filter((k) => k !== 'identity' && k !== 'actions'),
          )
          setStickyFirstColumn(next.stickyFirstColumn)
          setStickyLastColumn(next.stickyLastColumn)
        }}
      />

      {/* P.D — Bulk override confirmation modal. Shows the cascade
          scope explicitly so the operator knows the blast radius
          before committing. */}
      {bulkConfirmOpen && (
        <Modal
          open
          onClose={() => setBulkConfirmOpen(false)}
          size="md"
          title={
            <div className="text-md font-semibold text-slate-900 dark:text-slate-100">
              {t('pricing.bulk.confirm.title')}
            </div>
          }
        >
          <ModalBody className="space-y-4">
            <div className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40 p-4">
              <div className="text-sm uppercase tracking-wider text-blue-700 dark:text-blue-300 font-semibold">
                {t('pricing.bulk.confirm.scope')}
              </div>
              <div className="mt-2 grid grid-cols-3 gap-3">
                <div>
                  <div className="text-[24px] font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {cascadeScope.snapshots}
                  </div>
                  <div className="text-xs uppercase tracking-wider text-slate-500">
                    {t('pricing.bulk.confirm.snapshots', { s: cascadeScope.snapshots === 1 ? '' : 's' })}
                  </div>
                </div>
                <div>
                  <div className="text-[24px] font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {cascadeScope.variants}
                  </div>
                  <div className="text-xs uppercase tracking-wider text-slate-500">
                    {t('pricing.bulk.confirm.variants', { s: cascadeScope.variants === 1 ? '' : 's' })}
                  </div>
                </div>
                <div>
                  <div className="text-[24px] font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {cascadeScope.products}
                  </div>
                  <div className="text-xs uppercase tracking-wider text-slate-500">
                    {t('pricing.bulk.confirm.products', { s: cascadeScope.products === 1 ? '' : 's' })}
                  </div>
                </div>
              </div>
            </div>
            <div className="space-y-1.5 text-base text-slate-700 dark:text-slate-300">
              <div>
                <span className="font-medium">{t('pricing.bulk.confirm.action')}:</span>{' '}
                {bulkMode === 'SET_FIXED' && t('pricing.bulk.confirm.actionSetFixed', { value: bulkValue })}
                {bulkMode === 'SET_PERCENT_DISCOUNT' && t('pricing.bulk.confirm.actionPercent', { value: bulkValue })}
                {bulkMode === 'CLEAR' && t('pricing.bulk.confirm.actionClear')}
              </div>
              <div className="text-sm text-slate-500 dark:text-slate-400">
                {t('pricing.bulk.confirm.audit')}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
              <Button
                variant="secondary"
                size="md"
                onClick={() => setBulkConfirmOpen(false)}
                disabled={bulkApplying}
              >
                {t('pricing.bulk.confirm.cancel')}
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={async () => {
                  setBulkConfirmOpen(false)
                  await applyBulkOverride()
                }}
                loading={bulkApplying}
                disabled={cascadeScope.snapshots === 0}
              >
                {t('pricing.bulk.confirm.apply', { n: cascadeScope.snapshots, s: cascadeScope.snapshots === 1 ? '' : 's' })}
              </Button>
            </div>
          </ModalBody>
        </Modal>
      )}
    </div>
  )
}

const PRICING_SHORTCUTS: ShortcutGroup[] = [
  {
    title: 'Navigation',
    rows: [
      { keys: ['/'], label: 'Focus search' },
      { keys: ['r'], label: 'Refresh data' },
      { keys: ['Esc'], label: 'Close drawer · clear selection' },
    ],
  },
  {
    title: 'Help',
    rows: [{ keys: ['?'], label: 'Toggle this overlay' }],
  },
]

// P.C — Column layout for the new hierarchical grid.
//   identity : product/variant name + thumb + SKU/ASIN (ProductIdentityCell)
//   price    : parent → avg across snapshots; variant → primary channel
//   source   : parent → most-common; variant → primary source
//   channels : per-channel chips on variant rows; chip count on parent
//   warnings : count of snapshots with warnings (parent) / per-row chip (variant)
// Column labels resolve via t() at render time so locale flips refresh
// the headers — see buildPricingColumns().
function buildPricingColumns(
  t: (key: string, vars?: Record<string, string | number>) => string,
): GridLensColumn[] {
  // XG.6 — `identity` (leading) and `actions` (trailing) locked so the
  // shared PreferencesModal renders them with disabled toggles and
  // PG.6 sticky-left/right freezes pin them on horizontal scroll. The
  // 'actions' cell itself still returns null (drawer-only paradigm
  // preserved); the column exists purely as a sticky-right anchor.
  return [
    { key: 'identity', label: t('pricing.grid.col.product'),  subLabel: t('pricing.grid.col.productSub'),  width: 360, locked: true },
    { key: 'price',    label: t('pricing.grid.col.price'),    subLabel: t('pricing.grid.col.priceSub'),    width: 130 },
    { key: 'source',   label: t('pricing.grid.col.source'),   subLabel: t('pricing.grid.col.sourceSub'),   width: 130 },
    { key: 'channels', label: t('pricing.grid.col.channels'), subLabel: t('pricing.grid.col.channelsSub'), width: 280 },
    { key: 'warnings', label: t('pricing.grid.col.warnings'), subLabel: t('pricing.grid.col.warningsSub'), width: 130 },
    { key: 'actions',  label: '',                                                                          width: 40, locked: true },
  ]
}

interface RenderCellCtx {
  selected: Set<string>
  toggleRow: (id: string) => void
  openDrawer: (snap: SnapshotRow) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

function formatPriceCents(cents: number | null): string {
  if (cents == null) return '—'
  return (cents / 100).toFixed(2)
}

function isVariantRow(row: ParentRow | VariantRow): row is VariantRow {
  return !row.isParent && row.parentId != null
}

function renderPricingCell(
  row: ParentRow | VariantRow,
  key: string,
  ctx: RenderCellCtx,
): React.ReactNode {
  if (isVariantRow(row)) return renderVariantCell(row, key, ctx)
  return renderParentCell(row, key, ctx)
}

function renderParentCell(row: ParentRow, key: string, ctx: RenderCellCtx): React.ReactNode {
  const { t } = ctx
  switch (key) {
    case 'identity':
      return (
        <ProductIdentityCell
          id={row.productId ?? row.id}
          name={row.isOrphan ? t('pricing.grid.orphan', { sku: row.sku }) : row.name}
          sku={row.sku}
          amazonAsin={row.amazonAsin}
          isParent={row.isParent}
          parentId={null}
          childCount={row.childCount}
          imageUrl={row.thumbnailUrl}
          showThumb={true}
          productHref={row.isOrphan ? undefined : `/products/${row.productId}/edit`}
        />
      )
    case 'price':
      return (
        <span className="tabular-nums font-semibold text-slate-900 dark:text-slate-100">
          {row.avgPriceCents != null ? `€${formatPriceCents(row.avgPriceCents)}` : '—'}
          {row.snapshotCount > 0 && (
            <span className="ml-1 text-xs font-normal text-slate-400 dark:text-slate-500">
              {t('pricing.grid.avgSuffix', { n: row.snapshotCount })}
            </span>
          )}
        </span>
      )
    case 'source':
      return (
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {row.fallbackCount > 0
            ? <span className="text-amber-700 dark:text-amber-300">{t('pricing.grid.fallbackCount', { n: row.fallbackCount })}</span>
            : <span>—</span>}
        </span>
      )
    case 'channels':
      return (
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {t('pricing.grid.snapshotCount', { n: row.snapshotCount, s: row.snapshotCount === 1 ? '' : 's' })}
        </span>
      )
    case 'warnings':
      return (
        <div className="flex items-center gap-1.5 text-xs">
          {row.clampedCount > 0 && (
            <span className="text-amber-700 dark:text-amber-300" title="Clamped to min/max">
              {t('pricing.grid.clampedCount', { n: row.clampedCount })}
            </span>
          )}
          {row.warningsCount > 0 && (
            <span className="text-amber-700 dark:text-amber-300 inline-flex items-center gap-0.5">
              <AlertCircle size={11} aria-hidden="true" /> {row.warningsCount}
            </span>
          )}
          {row.clampedCount === 0 && row.warningsCount === 0 && (
            <span className="text-slate-400 dark:text-slate-500">—</span>
          )}
        </div>
      )
    case 'actions':
      return null
    default:
      return null
  }
}

const CHIP_TONE: Record<string, string> = {
  FALLBACK: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800',
  CLAMPED:  'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800',
  NEUTRAL:  'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
}

function ChannelChip({
  snap,
  isSelected,
  onToggle,
  onClick,
  t,
}: {
  snap: SnapshotRow
  isSelected: boolean
  onToggle: () => void
  onClick: () => void
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const market = snap.marketplace.replace(/^AMAZON_/, '').replace(/^EBAY_/, '')
  // P.F — WCAG AA: use the bold slate text instead of the muted -400
  // for the market code so contrast on white meets 4.5:1.
  const tone = snap.source === 'FALLBACK' || snap.isClamped ? CHIP_TONE.FALLBACK : CHIP_TONE.NEUTRAL
  const warningCount = snap.warnings?.length ?? 0
  const baseAria = t('pricing.grid.chipAria', {
    channel: snap.channel,
    marketplace: snap.marketplace,
    fm: snap.fulfillmentMethod ?? '',
    price: Number(snap.computedPrice).toFixed(2),
  })
  const ariaLabel = [
    baseAria,
    snap.isClamped ? t('pricing.grid.chipClamped', { from: snap.clampedFrom ?? '?' }) : '',
    warningCount > 0 ? t('pricing.grid.chipWarnings', { n: warningCount, s: warningCount === 1 ? '' : 's' }) : '',
  ].filter(Boolean).join(' · ')
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={isSelected}
      onClick={(e) => {
        // Cmd/Ctrl/Shift + click = select for bulk; bare click opens drawer.
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          e.preventDefault()
          onToggle()
        } else {
          onClick()
        }
      }}
      onKeyDown={(e) => {
        // Keyboard parity: Space/Enter opens drawer; Cmd/Ctrl+Enter
        // toggles selection. Lets keyboard-only operators do everything
        // the mouse can.
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          if (e.metaKey || e.ctrlKey || e.shiftKey) {
            onToggle()
          } else {
            onClick()
          }
        }
      }}
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 border rounded text-xs font-mono tabular-nums',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
        'hover:ring-2 hover:ring-blue-300 dark:hover:ring-blue-700',
        tone,
        isSelected && 'ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-800',
      )}
      title={ariaLabel}
    >
      <span className="text-slate-600 dark:text-slate-300 font-sans not-italic font-semibold">{market}</span>
      <span>{Number(snap.computedPrice).toFixed(2)}</span>
      {(snap.isClamped || warningCount > 0) && (
        <AlertCircle size={9} className="text-amber-700 dark:text-amber-300" aria-hidden="true" />
      )}
    </button>
  )
}

function renderVariantCell(row: VariantRow, key: string, ctx: RenderCellCtx): React.ReactNode {
  const { t } = ctx
  const primary = row.primary
  const primarySelected = ctx.selected.has(primary.id)
  switch (key) {
    case 'identity':
      return (
        <ProductIdentityCell
          id={row.productId ?? row.id}
          name={row.name}
          sku={row.sku}
          amazonAsin={row.amazonAsin}
          isParent={false}
          parentId={row.parentId}
          imageUrl={row.thumbnailUrl}
          showThumb={true}
          productHref={row.productId ? `/products/${row.productId}/edit` : undefined}
          variantDetailHref={row.productId ? `/products/${row.productId}/edit` : undefined}
        />
      )
    case 'price':
      return (
        <button
          type="button"
          onClick={() => ctx.openDrawer(primary)}
          className={cn(
            'tabular-nums font-semibold hover:underline cursor-pointer',
            primary.isClamped ? 'text-amber-700 dark:text-amber-300' : 'text-slate-900 dark:text-slate-100',
          )}
          title={primary.isClamped ? `Clamped from ${primary.clampedFrom} ${primary.currency}` : undefined}
        >
          {Number(primary.computedPrice).toFixed(2)}
          <span className="ml-1 text-xs font-normal text-slate-500 dark:text-slate-400">
            {primary.currency}
          </span>
        </button>
      )
    case 'source':
      return (
        <span
          className={cn(
            'inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded cursor-pointer',
            SOURCE_TONE[primary.source] ?? SOURCE_TONE.FALLBACK,
          )}
          onClick={() => ctx.openDrawer(primary)}
        >
          {SOURCE_LABEL[primary.source] ?? primary.source}
        </span>
      )
    case 'channels':
      return (
        <div className="flex items-center gap-1 flex-wrap">
          {row.channelChips.length === 0 ? (
            <span className="text-xs text-slate-400 dark:text-slate-500">—</span>
          ) : (
            row.channelChips.map((chip) => (
              <ChannelChip
                key={chip.id}
                snap={chip}
                isSelected={ctx.selected.has(chip.id)}
                onToggle={() => ctx.toggleRow(chip.id)}
                onClick={() => ctx.openDrawer(chip)}
                t={t}
              />
            ))
          )}
        </div>
      )
    case 'warnings':
      return (
        <div className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={primarySelected}
            onChange={(e) => { e.stopPropagation(); ctx.toggleRow(primary.id) }}
            className="rounded focus-visible:ring-2 focus-visible:ring-blue-500"
            aria-label={t('pricing.grid.primaryCheckboxAria', {
              channel: primary.channel,
              marketplace: primary.marketplace,
            })}
            title={t('pricing.grid.primaryCheckboxAria', {
              channel: primary.channel,
              marketplace: primary.marketplace,
            })}
          />
          {primary.warnings.length > 0 ? (
            <span
              className="text-xs text-amber-700 dark:text-amber-300 inline-flex items-center gap-0.5"
              title={primary.warnings.join('; ')}
            >
              <AlertCircle size={11} /> {primary.warnings.length}
            </span>
          ) : (
            <span className="text-xs text-slate-400 dark:text-slate-500">—</span>
          )}
        </div>
      )
    case 'actions':
      return (
        <button
          type="button"
          onClick={() => ctx.openDrawer(primary)}
          className="text-slate-400 dark:text-slate-500 hover:text-slate-700"
          title="Open detail drawer"
        >
          <ChevronRight size={14} />
        </button>
      )
    default:
      return null
  }
}

function PricingDetailDrawer({
  row,
  onClose,
  onPushed,
}: {
  row: SnapshotRow
  onClose: () => void
  onPushed: () => void
}) {
  const { t } = useTranslations()
  const [pushing, setPushing] = useState(false)
  const { toast } = useToast()

  const push = async () => {
    setPushing(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/pricing/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: row.sku,
          channel: row.channel,
          marketplace: row.marketplace,
          fulfillmentMethod: row.fulfillmentMethod,
        }),
      })
      const json = await res.json()
      if (json.ok) {
        toast.success(
          `Pushed ${json.pushedPrice} ${json.currency} to ${json.channel}:${json.marketplace}.`,
        )
        onPushed()
      } else {
        toast.error(`Push failed: ${json.error ?? `HTTP ${res.status}`}`)
      }
    } catch (e) {
      toast.error(`Push failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPushing(false)
    }
  }

  const breakdown = (row.breakdown ?? {}) as any
  const headerTitle = (
    <div className="min-w-0">
      <div className="text-md font-semibold text-slate-900 dark:text-slate-100 truncate font-mono">
        {row.sku}
      </div>
      <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
        {row.channel} · {row.marketplace}
        {row.fulfillmentMethod ? ` · ${row.fulfillmentMethod}` : ''}
      </div>
    </div>
  )

  return (
    <Modal
      open
      onClose={onClose}
      placement="drawer-right"
      size="xl"
      title={headerTitle}
    >
      <ModalBody className="space-y-4">
        {/* Resolved */}
        <div className="bg-slate-50 dark:bg-slate-800 rounded p-3">
          <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
            {t('pricing.drawer.resolvedPrice')}
          </div>
          <div className="text-[24px] font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {Number(row.computedPrice).toFixed(2)}{' '}
            <span className="text-lg font-normal text-slate-500 dark:text-slate-400">
              {row.currency}
            </span>
          </div>
          <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            {t('pricing.drawer.source')}: <span className="font-mono">{row.source}</span>
            {row.isClamped && (
              <span className="ml-2 text-amber-700 dark:text-amber-300">
                · {t('pricing.drawer.clampedFrom', { value: row.clampedFrom ?? '?' })}
              </span>
            )}
          </div>
        </div>

        {/* Breakdown */}
        <div>
          <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1.5">
            {t('pricing.drawer.breakdown')}
          </div>
          <dl className="grid grid-cols-2 gap-y-1 text-base">
            <Item label={t('pricing.drawer.masterPrice')} value={breakdown.masterPrice} suffix="EUR" />
            <Item label={t('pricing.drawer.fxRate')} value={breakdown.fxRate} format="rate" />
            <Item label={t('pricing.drawer.costEntered')} value={breakdown.costPrice} suffix="EUR" />
            <Item label={t('pricing.drawer.landedReceipts')} value={breakdown.landedCost} suffix="EUR" />
            <Item
              label={t('pricing.drawer.floorCostBasis')}
              value={breakdown.effectiveCostBasis}
              suffix="EUR"
            />
            <Item label={t('pricing.drawer.fbaFee')} value={breakdown.fbaFee} suffix={row.currency} />
            <Item label={t('pricing.drawer.referralFee')} value={breakdown.referralFee} suffix={row.currency} />
            <Item label={t('pricing.drawer.vatRate')} value={breakdown.vatRate} suffix="%" />
            <Item label={t('pricing.drawer.minMargin')} value={breakdown.minMarginPercent} suffix="%" />
            <Item
              label={t('pricing.drawer.taxInclusive')}
              value={
                breakdown.taxInclusive
                  ? t('pricing.drawer.taxInclusive.yes')
                  : t('pricing.drawer.taxInclusive.no')
              }
            />
            {breakdown.appliedRule && (
              <Item
                label={t('pricing.drawer.appliedRule')}
                value={`${breakdown.appliedRule.type}${breakdown.appliedRule.adjustment != null ? ` (${breakdown.appliedRule.adjustment >= 0 ? '+' : ''}${breakdown.appliedRule.adjustment}%)` : ''}`}
              />
            )}
          </dl>
        </div>

        {/* Warnings */}
        {row.warnings.length > 0 && (
          <div className="border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950 rounded p-3">
            <div className="text-sm uppercase tracking-wider text-amber-800 dark:text-amber-200 font-semibold mb-1">
              {t('pricing.drawer.warnings')}
            </div>
            <ul className="text-base text-amber-800 dark:text-amber-200 space-y-0.5">
              {row.warnings.map((w, i) => (
                <li key={i}>• {w}</li>
              ))}
            </ul>
          </div>
        )}

        {/* PH.3 — Price history timeline */}
        <PriceHistorySection
          sku={row.sku}
          channel={row.channel}
          marketplace={row.marketplace}
        />

        {/* Push action */}
        <div className="border border-slate-200 dark:border-slate-800 rounded p-3">
          <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">
            {t('pricing.drawer.pushTitle')}
          </div>
          <div className="text-base text-slate-600 dark:text-slate-400 mb-2">
            {t('pricing.drawer.pushDescription', { channel: row.channel })}
          </div>
          <Button
            variant="primary"
            size="md"
            onClick={push}
            loading={pushing}
            icon={pushing ? null : <Send size={12} />}
            className="bg-slate-900 hover:bg-slate-800 border-slate-900"
          >
            {pushing
              ? t('pricing.drawer.pushing')
              : t('pricing.drawer.pushButton')}
          </Button>
        </div>

        {row.computedAt && (
          <div className="text-sm text-slate-400 dark:text-slate-500">
            {t('pricing.drawer.lastComputed', {
              when: new Date(row.computedAt).toLocaleString(),
            })}
          </div>
        )}
      </ModalBody>
    </Modal>
  )
}

function Item({
  label,
  value,
  suffix,
  format,
}: {
  label: string
  value: any
  suffix?: string
  format?: 'rate'
}) {
  if (value == null || value === '') return null
  const display =
    format === 'rate'
      ? Number(value).toFixed(4)
      : typeof value === 'number'
      ? value.toFixed(2)
      : String(value)
  return (
    <>
      <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="font-mono text-slate-800 dark:text-slate-200 text-right tabular-nums">
        {display}
        {suffix ? <span className="text-slate-400 dark:text-slate-500 ml-1">{suffix}</span> : null}
      </dd>
    </>
  )
}

// ── PH.3 — Price-history timeline ───────────────────────────────────────
// Reads GET /api/pricing/price-history (PH.2) for this exact coordinate
// and renders a sparkline + a chronological change list with a source
// chip and reason per change. Answers "why did this price change, and
// what was it before?" without leaving the drawer.

interface PriceHistoryEvent {
  id: string
  channel: string
  marketplace: string
  fulfillmentMethod: string | null
  oldPrice: number | null
  newPrice: number | null
  currency: string
  source: string
  reason: string
  ruleId: string | null
  actor: string | null
  changedAt: string
}
interface PriceHistorySeries {
  channel: string
  marketplace: string
  points: Array<{ t: string; price: number }>
}

// Source → chip palette. Operator edits read cool/blue, automation reads
// violet, promotions read warm (start green / end amber), system reads grey.
const PRICE_SOURCE_CHIP: Record<string, string> = {
  MANUAL_OVERRIDE:
    'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-900',
  BULK_OVERRIDE:
    'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-900',
  REPRICER:
    'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-900',
  PROMO_START:
    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-900',
  PROMO_END:
    'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900',
}
const PRICE_SOURCE_LABEL: Record<string, string> = {
  MANUAL_OVERRIDE: 'Manual',
  BULK_OVERRIDE: 'Bulk edit',
  REPRICER: 'Repricer',
  PROMO_START: 'Promo start',
  PROMO_END: 'Promo end',
  CHANNEL_RULE: 'Channel rule',
  MASTER_INHERIT: 'Master',
  FX: 'FX',
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const secs = Math.max(0, (Date.now() - then) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

// Tiny inline sparkline — no chart-lib dependency. Normalizes the series
// to the box and draws a polyline; a flat/single-point series renders a
// centred line so it never collapses to nothing.
function Sparkline({ points }: { points: Array<{ t: string; price: number }> }) {
  const W = 240
  const H = 40
  const P = 4
  if (points.length === 0) return null
  const prices = points.map((p) => p.price)
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const span = max - min || 1
  const n = points.length
  const x = (i: number) =>
    n === 1 ? W / 2 : P + (i / (n - 1)) * (W - 2 * P)
  const y = (v: number) => H - P - ((v - min) / span) * (H - 2 * P)
  const d = points.map((p, i) => `${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(' ')
  const last = points[n - 1]
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-10"
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline
        points={d}
        fill="none"
        className="stroke-violet-500 dark:stroke-violet-400"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(n - 1)} cy={y(last.price)} r={2.5} className="fill-violet-600 dark:fill-violet-400" />
    </svg>
  )
}

function PriceHistorySection({
  sku,
  channel,
  marketplace,
}: {
  sku: string
  channel: string
  marketplace: string
}) {
  const [loading, setLoading] = useState(true)
  const [events, setEvents] = useState<PriceHistoryEvent[]>([])
  const [series, setSeries] = useState<PriceHistorySeries[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ sku, channel, marketplace, limit: '50' })
    fetch(`${getBackendUrl()}/api/pricing/price-history?${params}`, {
      cache: 'no-store',
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json) => {
        if (cancelled) return
        setEvents(json.events ?? [])
        setSeries(json.series ?? [])
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sku, channel, marketplace])

  const coordSeries = series.find(
    (s) => s.channel === channel && s.marketplace === marketplace,
  )
  const currency = events[0]?.currency ?? 'EUR'

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded p-3">
      <div className="flex items-center gap-1.5 text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">
        <Clock size={12} />
        Price history
        {!loading && events.length > 0 && (
          <span className="ml-1 text-slate-400 dark:text-slate-500 normal-case font-normal tracking-normal">
            ({events.length})
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-base text-slate-400 dark:text-slate-500 py-2">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : error ? (
        <div className="text-base text-slate-400 dark:text-slate-500 py-2">
          Couldn’t load history ({error}).
        </div>
      ) : events.length === 0 ? (
        <div className="text-base text-slate-400 dark:text-slate-500 py-2">
          No recorded price changes yet. Changes from bulk edits, the
          repricer, and promotions will appear here.
        </div>
      ) : (
        <>
          {coordSeries && coordSeries.points.length >= 2 && (
            <div className="mb-2">
              <Sparkline points={coordSeries.points} />
            </div>
          )}
          <ul className="space-y-2 max-h-64 overflow-y-auto">
            {events.map((e) => (
              <li key={e.id} className="flex items-start gap-2 text-base">
                <span
                  className={cn(
                    'mt-0.5 px-1.5 py-0.5 rounded border text-xs font-medium whitespace-nowrap',
                    PRICE_SOURCE_CHIP[e.source] ??
                      'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
                  )}
                >
                  {PRICE_SOURCE_LABEL[e.source] ?? e.source}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 font-mono tabular-nums text-slate-800 dark:text-slate-200">
                    {e.oldPrice != null && (
                      <span className="text-slate-400 dark:text-slate-500 line-through">
                        {e.oldPrice.toFixed(2)}
                      </span>
                    )}
                    {e.oldPrice != null && <ChevronRight size={12} className="text-slate-400" />}
                    <span className="font-semibold">
                      {e.newPrice != null ? `${e.newPrice.toFixed(2)} ${currency}` : 'cleared'}
                    </span>
                  </div>
                  {e.reason && (
                    <div className="text-sm text-slate-500 dark:text-slate-400 truncate" title={e.reason}>
                      {e.reason}
                    </div>
                  )}
                </div>
                <span
                  className="text-sm text-slate-400 dark:text-slate-500 whitespace-nowrap"
                  title={new Date(e.changedAt).toLocaleString()}
                >
                  {relativeTime(e.changedAt)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

// Old local KpiStrip + KpiTile removed in P.E — replaced by the shared
// grid-lens KpiStrip with the kpiTiles spec built in the component body.
