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
import Link from 'next/link'
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
  KeyboardShortcutsModal,
  ProductIdentityCell,
  VirtualizedGrid,
  type AutoRefreshInterval,
  type Density,
  type GridLensColumn,
  type GridLensRow,
  type ShortcutGroup,
} from '@/app/_shared/grid-lens'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Modal, ModalBody } from '@/components/ui/Modal'
import {
  MultiSelectChips,
  ACTIVE_CHANNELS_OPTIONS,
  ACTIVE_MARKETPLACES_OPTIONS,
} from '@/components/ui/MultiSelectChips'
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
      {/* B.1 — KPI strip */}
      <KpiStrip kpis={kpis} />

      {/* UI.7 — Repricer status banner */}
      <RepricerStatusBanner />

      {/* Filter bar */}
      <Card>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px] max-w-sm">
            <Search
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
            />
            <Input
              placeholder={t('pricing.search.placeholder')}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
              className="pl-7"
            />
          </div>
          {/* U.67 — channel + marketplace filters migrated from native
              <select> to the shared MultiSelectChips primitive. Single
              mode because the pricing matrix backend filters on a
              single (channel, marketplace) pair per request. */}
          <MultiSelectChips
            label="Channel"
            mode="single"
            options={ACTIVE_CHANNELS_OPTIONS}
            value={channel ? [channel] : []}
            onChange={(next) => {
              setChannel(next[0] ?? '')
              setPage(0)
            }}
          />
          <MultiSelectChips
            label="Market"
            mode="single"
            options={ACTIVE_MARKETPLACES_OPTIONS}
            value={marketplace ? [marketplace] : []}
            onChange={(next) => {
              setMarketplace(next[0] ?? '')
              setPage(0)
            }}
          />
          <select
            value={sourceFilter}
            onChange={(e) => {
              setSourceFilter(e.target.value)
              setPage(0)
            }}
            className="h-8 px-2 border border-slate-200 dark:border-slate-800 rounded-md text-base bg-white dark:bg-slate-900"
          >
            <option value="">{t('pricing.filter.allSources')}</option>
            <option value="SCHEDULED_SALE">{t('pricing.source.SCHEDULED_SALE')}</option>
            <option value="OFFER_OVERRIDE">{t('pricing.source.OFFER_OVERRIDE')}</option>
            <option value="CHANNEL_OVERRIDE">{t('pricing.source.CHANNEL_OVERRIDE')}</option>
            <option value="CHANNEL_RULE">{t('pricing.source.CHANNEL_RULE')}</option>
            <option value="PRICING_RULE">{t('pricing.source.PRICING_RULE')}</option>
            <option value="MASTER_INHERIT">{t('pricing.source.MASTER_INHERIT')}</option>
            <option value="FALLBACK">{t('pricing.source.FALLBACK')}</option>
          </select>
          <label className="inline-flex items-center gap-1.5 text-base text-slate-700 dark:text-slate-300 ml-2">
            <input
              type="checkbox"
              checked={clampedOnly}
              onChange={(e) => {
                setClampedOnly(e.target.checked)
                setPage(0)
              }}
            />
            {t('pricing.filter.clampedOnly')}
          </label>
          <div className="ml-auto flex items-center gap-2">
            <SharedDensityToggle density={density} onChange={setDensity} />
            <AutoRefreshSelect
              value={autoRefreshMin}
              onChange={setAutoRefreshMin}
              onTick={() => { fetchData(); fetchKpis() }}
            />
            <FreshnessIndicator
              lastFetchedAt={lastFetchedAt}
              onRefresh={fetchData}
              loading={loading}
              error={!!error}
            />
            <button
              type="button"
              onClick={() => setShortcutsOpen(true)}
              className="h-7 w-7 inline-flex items-center justify-center border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
              title="Keyboard shortcuts (?)"
              aria-label="Keyboard shortcuts"
            >
              <Keyboard size={12} />
            </button>
            <Button
              variant="primary"
              size="md"
              onClick={refreshAll}
              loading={refreshing}
              disabled={refreshing}
              icon={refreshing ? null : <Zap size={12} />}
            >
              {refreshing
                ? t('pricing.action.recomputing')
                : t('pricing.action.recomputeAll')}
            </Button>
          </div>
        </div>
      </Card>

      {/* Bulk action bar — Toast handles success/error feedback so the bar
          stays minimal: count + mode + value + Apply + Deselect. */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-20 bg-slate-900 text-white rounded-lg px-4 py-3 flex items-center gap-3 flex-wrap shadow-lg">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelected(new Set())}
            icon={<X size={12} />}
            aria-label={t('pricing.bulk.deselect')}
            className="text-slate-300 hover:text-white hover:bg-slate-800 border-transparent"
          >
            {t('pricing.bulk.deselect')}
          </Button>
          <div className="h-4 w-px bg-slate-700" />
          <span className="text-base font-semibold tabular-nums">
            {t('pricing.bulk.selected', {
              n: selected.size,
              s: selected.size === 1 ? '' : 's',
            })}
          </span>
          <div className="h-4 w-px bg-slate-700" />
          <select
            value={bulkMode}
            onChange={(e) =>
              setBulkMode(e.target.value as typeof bulkMode)
            }
            className="h-7 px-2 rounded border border-slate-600 bg-slate-800 text-white text-base"
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
              className="h-7 w-24 px-2 rounded border border-slate-600 bg-slate-800 text-white text-base tabular-nums"
            />
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={() => setBulkConfirmOpen(true)}
            loading={bulkApplying}
            disabled={bulkApplying || (bulkMode !== 'CLEAR' && !bulkValue)}
            className="ml-auto bg-white text-slate-900 hover:bg-slate-100 border-white"
          >
            {t('pricing.bulk.apply')}
          </Button>
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
            visible={PRICING_COLUMNS}
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
            renderCell={(row, key) => renderPricingCell(row as ParentRow | VariantRow, key, { selected, toggleRow, openDrawer })}
          />

          {/* Pagination — by parent product, not by snapshot. */}
          <div className="px-4 py-2.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-base text-slate-600 dark:text-slate-400">
            <span>
              {data.total} product{data.total === 1 ? '' : 's'} · page {data.page + 1} / {Math.max(1, totalPages)}
              {selected.size > 0 && (
                <span className="ml-3 text-blue-600 font-medium">
                  {selected.size} snapshot{selected.size === 1 ? '' : 's'} selected
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
              Confirm bulk override
            </div>
          }
        >
          <ModalBody className="space-y-4">
            <div className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40 p-4">
              <div className="text-sm uppercase tracking-wider text-blue-700 dark:text-blue-300 font-semibold">
                Cascade scope
              </div>
              <div className="mt-2 grid grid-cols-3 gap-3">
                <div>
                  <div className="text-[24px] font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {cascadeScope.snapshots}
                  </div>
                  <div className="text-xs uppercase tracking-wider text-slate-500">
                    snapshot{cascadeScope.snapshots === 1 ? '' : 's'}
                  </div>
                </div>
                <div>
                  <div className="text-[24px] font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {cascadeScope.variants}
                  </div>
                  <div className="text-xs uppercase tracking-wider text-slate-500">
                    variant{cascadeScope.variants === 1 ? '' : 's'}
                  </div>
                </div>
                <div>
                  <div className="text-[24px] font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {cascadeScope.products}
                  </div>
                  <div className="text-xs uppercase tracking-wider text-slate-500">
                    product{cascadeScope.products === 1 ? '' : 's'}
                  </div>
                </div>
              </div>
            </div>
            <div className="space-y-1.5 text-base text-slate-700 dark:text-slate-300">
              <div>
                <span className="font-medium">Action:</span>{' '}
                {bulkMode === 'SET_FIXED' && `Set every selected price to ${bulkValue} EUR`}
                {bulkMode === 'SET_PERCENT_DISCOUNT' && `Discount every selected price by ${bulkValue}%`}
                {bulkMode === 'CLEAR' && 'Clear every selected override (back to engine default)'}
              </div>
              <div className="text-sm text-slate-500 dark:text-slate-400">
                Writes one ChannelListingOverride row per snapshot for
                audit. Pushes happen out-of-band via the outbound queue.
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
              <Button
                variant="secondary"
                size="md"
                onClick={() => setBulkConfirmOpen(false)}
                disabled={bulkApplying}
              >
                Cancel
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
                Apply to {cascadeScope.snapshots} snapshot{cascadeScope.snapshots === 1 ? '' : 's'}
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
const PRICING_COLUMNS: GridLensColumn[] = [
  { key: 'identity', label: 'Product',  subLabel: 'Name · SKU · ASIN',      width: 360 },
  { key: 'price',    label: 'Price',    subLabel: 'Primary · IT-FBA',       width: 130 },
  { key: 'source',   label: 'Source',   subLabel: 'Resolver',               width: 130 },
  { key: 'channels', label: 'Channels', subLabel: 'Other markets',          width: 280 },
  { key: 'warnings', label: 'Warnings', subLabel: 'Clamped · fallback',     width: 130 },
  { key: 'actions',  label: '',                                              width: 40  },
]

interface RenderCellCtx {
  selected: Set<string>
  toggleRow: (id: string) => void
  openDrawer: (snap: SnapshotRow) => void
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

function renderParentCell(row: ParentRow, key: string, _ctx: RenderCellCtx): React.ReactNode {
  switch (key) {
    case 'identity':
      return (
        <ProductIdentityCell
          id={row.productId ?? row.id}
          name={row.isOrphan ? `Orphan SKU · ${row.sku}` : row.name}
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
              avg · {row.snapshotCount}
            </span>
          )}
        </span>
      )
    case 'source':
      return (
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {row.fallbackCount > 0
            ? <span className="text-amber-700 dark:text-amber-300">{row.fallbackCount} fallback</span>
            : <span>—</span>}
        </span>
      )
    case 'channels':
      return (
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {row.snapshotCount} snapshot{row.snapshotCount === 1 ? '' : 's'}
        </span>
      )
    case 'warnings':
      return (
        <div className="flex items-center gap-1.5 text-xs">
          {row.clampedCount > 0 && (
            <span className="text-amber-700 dark:text-amber-300" title="Clamped to min/max">
              {row.clampedCount} clamped
            </span>
          )}
          {row.warningsCount > 0 && (
            <span className="text-amber-700 dark:text-amber-300 inline-flex items-center gap-0.5">
              <AlertCircle size={11} /> {row.warningsCount}
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
}: {
  snap: SnapshotRow
  isSelected: boolean
  onToggle: () => void
  onClick: () => void
}) {
  const market = snap.marketplace.replace(/^AMAZON_/, '').replace(/^EBAY_/, '')
  const tone = snap.source === 'FALLBACK' || snap.isClamped ? CHIP_TONE.FALLBACK : CHIP_TONE.NEUTRAL
  const warningCount = snap.warnings?.length ?? 0
  return (
    <button
      type="button"
      onClick={(e) => {
        // Cmd/Ctrl + click = select for bulk; bare click opens drawer.
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          e.preventDefault()
          onToggle()
        } else {
          onClick()
        }
      }}
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 border rounded text-xs font-mono tabular-nums hover:ring-2 hover:ring-blue-300 dark:hover:ring-blue-700',
        tone,
        isSelected && 'ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-800',
      )}
      title={`${snap.channel} · ${snap.marketplace}${snap.fulfillmentMethod ? ' · ' + snap.fulfillmentMethod : ''}${snap.isClamped ? ' · clamped from ' + (snap.clampedFrom ?? '?') : ''}${warningCount > 0 ? ' · ' + warningCount + ' warning(s)' : ''} — click to open · ⌘+click to select`}
    >
      <span className="text-slate-400 dark:text-slate-500 font-sans not-italic font-medium">{market}</span>
      <span>{Number(snap.computedPrice).toFixed(2)}</span>
      {(snap.isClamped || warningCount > 0) && (
        <AlertCircle size={9} className="text-amber-600 dark:text-amber-400" />
      )}
    </button>
  )
}

function renderVariantCell(row: VariantRow, key: string, ctx: RenderCellCtx): React.ReactNode {
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
            className="rounded"
            title="Select primary channel snapshot for bulk override"
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

// B.1 + F.1.b + H.1 — KPI strip. Six tiles, dense Salesforce/Airtable style
// (per the visibility-over-minimalism feedback memory). Each tile shows the
// count + a one-word label + a hint sentence. Drift + Alerts deep-link to
// /pricing/alerts; On sale → /pricing/promotions; the rest are read-only.
// Labels + hints are i18n'd; numerals stay locale-agnostic.
function KpiStrip({ kpis }: { kpis: KpiResponse | null }) {
  const { t } = useTranslations()
  // Snapshot age: green ≤1h (cron just ran), amber ≤4h, rose >4h.
  const stale = kpis?.snapshots.oldestAgeHours
  const staleTone =
    stale == null
      ? 'slate'
      : stale <= 1
      ? 'emerald'
      : stale <= 4
      ? 'amber'
      : 'rose'
  const staleLabel =
    stale == null ? '—' : stale < 1 ? '<1h' : `${Math.round(stale)}h`

  // Buy Box: rose <50%, amber <80%, emerald ≥80%. Slate when no observations
  // yet (sp-api creds missing OR cron hasn't run since F.1 deploy).
  const wr = kpis?.buyBox.winRatePct
  const buyBoxTone =
    wr == null
      ? 'slate'
      : wr < 50
      ? 'rose'
      : wr < 80
      ? 'amber'
      : 'emerald'
  const buyBoxLabel =
    wr == null
      ? '—'
      : `${wr.toFixed(1)}%`
  const buyBoxHint =
    kpis && kpis.buyBox.observations > 0
      ? t('pricing.kpi.buyBoxHint', {
          wins: kpis.buyBox.ourWins,
          obs: kpis.buyBox.observations,
        })
      : t('pricing.kpi.buyBoxHintEmpty')

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
      <KpiTile
        href="/pricing/alerts"
        icon={TrendingDown}
        value={kpis?.drift ?? '—'}
        label={t('pricing.kpi.drift')}
        tone={kpis && kpis.drift > 0 ? 'rose' : 'slate'}
        hint={t('pricing.kpi.driftHint')}
      />
      <KpiTile
        href="/pricing/alerts"
        icon={AlertTriangle}
        value={kpis?.alerts ?? '—'}
        label={t('pricing.kpi.alerts')}
        tone={kpis && kpis.alerts > 0 ? 'amber' : 'slate'}
        hint={t('pricing.kpi.alertsHint')}
      />
      <KpiTile
        href="/pricing/promotions"
        icon={Tag}
        value={kpis?.salesActive ?? '—'}
        label={t('pricing.kpi.onSale')}
        tone={kpis && kpis.salesActive > 0 ? 'pink' : 'slate'}
        hint={t('pricing.kpi.onSaleHint')}
      />
      <KpiTile
        icon={Clock}
        value={staleLabel}
        label={t('pricing.kpi.snapshotAge')}
        tone={staleTone}
        hint={t('pricing.kpi.snapshotAgeHint')}
      />
      <KpiTile
        icon={AlertCircle}
        value={kpis?.marginAtRisk ?? '—'}
        label={t('pricing.kpi.noCost')}
        tone={kpis && kpis.marginAtRisk > 0 ? 'amber' : 'slate'}
        hint={t('pricing.kpi.noCostHint')}
      />
      <KpiTile
        icon={Trophy}
        value={buyBoxLabel}
        label={t('pricing.kpi.buyBox')}
        tone={buyBoxTone}
        hint={buyBoxHint}
      />
    </div>
  )
}

function KpiTile({
  href,
  icon: Icon,
  value,
  label,
  tone,
  hint,
}: {
  href?: string
  icon: typeof TrendingDown
  value: number | string
  label: string
  tone: 'rose' | 'amber' | 'pink' | 'emerald' | 'slate'
  hint: string
}) {
  const toneClasses: Record<typeof tone, string> = {
    rose: 'border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950 text-rose-700 dark:text-rose-300',
    amber: 'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300',
    pink: 'border-pink-200 dark:border-pink-900 bg-pink-50 dark:bg-pink-950 text-pink-700 dark:text-pink-300',
    emerald: 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300',
    slate: 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400',
  }
  const inner = (
    <div
      className={cn(
        'border rounded-md px-3 py-2 flex items-start gap-2',
        toneClasses[tone],
        href && 'hover:shadow-sm transition-shadow cursor-pointer',
      )}
    >
      <Icon size={14} className="mt-0.5 flex-shrink-0" />
      <div className="min-w-0">
        <div className="text-[20px] leading-tight font-semibold tabular-nums">
          {value}
        </div>
        <div className="text-base font-medium text-slate-700 dark:text-slate-300 leading-tight">
          {label}
        </div>
        <div className="text-sm text-slate-500 dark:text-slate-400 leading-tight mt-0.5 truncate">
          {hint}
        </div>
      </div>
    </div>
  )
  return href ? <Link href={href}>{inner}</Link> : inner
}
