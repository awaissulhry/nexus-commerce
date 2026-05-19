'use client'

// F.5 — Smart Replenishment workspace.
//
// Reads from the F.4 forecast layer:
//   - urgency tiles (CRITICAL/HIGH/MEDIUM/LOW counts)
//   - upcoming retail events banner with prep deadlines
//   - virtualized table with forecast-driven velocity, lead-time-window
//     demand + 80% confidence band, ATP composition (on-hand + inbound),
//     lead time + supplier source
//   - row-click drawer with 90-day forecast chart, signal breakdown,
//     open inbound shipments
//   - multi-select → bulk-draft-PO flow (one POST creates one PO per
//     supplier, grouped automatically)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  Download,
  Keyboard,
  Loader2,
  Package,
  RefreshCw,
  ShoppingCart,
  Sparkles,
  X,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import {
  MultiSelectChips,
  ACTIVE_CHANNELS_OPTIONS,
  ACTIVE_MARKETPLACES_OPTIONS,
} from '@/components/ui/MultiSelectChips'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'
import { VirtualizedGrid, GridFooter } from '@/app/_shared/grid-lens'
import type { GridLensColumn, GridLensRow } from '@/app/_shared/grid-lens/types'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { DENSITY_CELL_CLASS } from '@/lib/products/theme'
import { CommandCenterKpis } from './_shared/CommandCenterKpis'
import { ReplenishmentWidgets, WidgetLauncher, useWidgetStore } from './_shared/FloatingWidgetSystem'

// W9.6c — Suggestion + Urgency + OpenShipmentRef moved to
// _shared/types.ts so the extracted shared cards pull the same shape.
import type { Suggestion } from './_shared/types'
import { MobileSuggestionCard } from './_shared/MobileSuggestionCard'
import { BulkPoModal } from './_shared/BulkPoModal'
import { SavedViewsButton } from './_shared/SavedViewsButton'
import type { ContainerFillEntry } from './_shared/ContainerFillCard'
import { KeyboardHelpOverlay } from './_shared/KeyboardHelpOverlay'
import { ForecastDetailDrawer } from './_shared/ForecastDetailDrawer'

// W9.6l — ContainerFillCard + ContainerFillEntry moved to _shared/.
//          KeyboardHelpOverlay moved to _shared/.
// W9.6m — SubstitutionPanel + RecommendationHistoryCard moved to _shared/.
// W9.6o — ForecastDetailDrawer + SupplierAlternativesPanel + drawer-only
//          panels (Reorder/Signal/StockByLocation/ChannelCover/FbaRestockSignal/
//          ForecastAccuracy/Substitution/RecommendationHistory) consumed by
//          the drawer module — workspace no longer imports them directly.

interface ReplenishmentResponse {
  suggestions: Suggestion[]
  counts: { critical: number; high: number; medium: number; low: number }
  window: number
  filter: { channel: string | null; marketplace: string | null }
  // R.19 — per-supplier container fill summary (only suppliers with profiles).
  containerFill?: ContainerFillEntry[]
}

// W9.6 — UpcomingEvent + UrgencyTile + UpcomingEventsBanner moved to
// _shared/UrgencyTiles.tsx so the workspace shrinks below 4400 lines.
import type { UpcomingEvent } from './_shared/UrgencyTiles'
import { UrgencyTile, UpcomingEventsBanner } from './_shared/UrgencyTiles'

import type { SortKey } from './_shared/SortableTh'
import type { Urgency } from './_shared/types'


// One grid row — either a real leaf suggestion or a synthetic parent aggregate.
type RepRow = GridLensRow & {
  sku: string
  name: string
  thumbnailUrl: string | null
  urgency: Urgency | null
  needsReorder: boolean
  currentStock: number
  reorderQty: number
  velocity: number
  daysOfStockLeft: number | null
  leadTimeDays: number
  // Full suggestion data present only for leaf rows
  suggestion: Suggestion | null
}

const URGENCY_ORDER: Record<Urgency, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
const _REP_EMPTY_SET = new Set<string>()

const URGENCY_TONE: Record<Urgency, string> = {
  CRITICAL: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-400 dark:border-rose-900',
  HIGH:     'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-400 dark:border-orange-900',
  MEDIUM:   'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900',
  LOW:      'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
}

const REP_COLUMNS: GridLensColumn[] = [
  { key: 'thumb',      label: '',            width: 44,  locked: true },
  { key: 'product',    label: 'Product',     width: 280, locked: true },
  { key: 'urgency',    label: 'Urgency',     width: 100 },
  { key: 'stock',      label: 'On hand',     width: 90 },
  { key: 'daysLeft',   label: 'Days left',   width: 90 },
  { key: 'velocity',   label: 'Vel/day',     width: 80 },
  { key: 'demand',     label: 'Demand (LT)', width: 100 },
  { key: 'reorderQty', label: 'Suggest qty', width: 100 },
  { key: 'actions',    label: '',            width: 120 },
]

export default function ReplenishmentWorkspace() {
  // R.5 — URL-driven state. Filters / search / sort are bookmarkable
  // and shareable. Selection + bulk modal stay local (ephemeral).
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { t } = useTranslations()

  const filter = (searchParams.get('filter') ??
    'NEEDS_REORDER') as 'ALL' | 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'NEEDS_REORDER'
  const channelFilter = searchParams.get('channel') ?? ''
  const marketplaceFilter = searchParams.get('marketplace') ?? ''
  const urlSearch = searchParams.get('search') ?? ''
  const sortBy = (searchParams.get('sortBy') ?? 'urgency') as SortKey
  const sortDir = (searchParams.get('sortDir') ?? 'desc') as 'asc' | 'desc'
  const drawerProductId = searchParams.get('drawer')

  const [data, setData] = useState<ReplenishmentResponse | null>(null)
  const [events, setEvents] = useState<UpcomingEvent[] | null>(null)
  const [loading, setLoading] = useState(true)
  // W2.2 — replaces window.prompt for dismiss-with-reason. Holds the
  // pending request; cleared on confirm/cancel. `onConfirm` receives
  // the trimmed reason or null when the operator left it blank.
  const [dismissPrompt, setDismissPrompt] = useState<{
    title: string
    onConfirm: (reason: string | null) => void
  } | null>(null)
  // searchInput is local + debounced; the URL param is the persisted value.
  const [searchInput, setSearchInput] = useState(urlSearch)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  // R.5 — auto-refresh interval persisted per-device via localStorage.
  const [autoRefreshMin, setAutoRefreshMin] = useState<0 | 5 | 15>(0)
  // Keyboard shortcuts. focusedIndex is -1 when no row has keyboard
  // focus; helpOpen toggles the "?" overlay.
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [helpOpen, setHelpOpen] = useState(false)
  // Migrated from the inline 30-line toast queue to the app-wide
  // ToastProvider (components/ui/Toast.tsx). Same pushToast(tone, msg)
  // call signature so existing call-sites keep working unchanged;
  // tone 'ok' maps to 'success', 'error' stays.
  const { toast } = useToast()
  const { store: widgetStore, toggle: toggleWidget, close: closeWidget, move: moveWidget, focus: focusWidget } = useWidgetStore()
  const pushToast = useCallback(
    (tone: 'ok' | 'error', msg: string) => {
      if (tone === 'ok') toast.success(msg)
      else toast.error(msg)
    },
    [toast],
  )

  const updateUrl = useCallback((patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }, [searchParams, pathname, router])

  const setFilter = (f: typeof filter) => updateUrl({ filter: f === 'NEEDS_REORDER' ? undefined : f })
  const setChannelFilter = (c: string) => updateUrl({ channel: c || undefined })
  const setMarketplaceFilter = (m: string) => updateUrl({ marketplace: m || undefined })
  const setDrawerProductId = (id: string | null) => updateUrl({ drawer: id ?? undefined })
  const setSort = (key: SortKey) => {
    if (key === sortBy) updateUrl({ sortDir: sortDir === 'asc' ? 'desc' : 'asc' })
    else updateUrl({ sortBy: key === 'urgency' ? undefined : key, sortDir: undefined })
  }
  void setSort // used by mobile cards sort interaction via URL params

  // Debounced search input → URL
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (searchInput !== urlSearch) updateUrl({ search: searchInput || undefined })
    }, 250)
    return () => window.clearTimeout(t)
  }, [searchInput, urlSearch, updateUrl])

  // Restore auto-refresh preference
  useEffect(() => {
    const stored = window.localStorage.getItem('nexus-replenishment-autorefresh')
    const n = Number(stored)
    if (n === 5 || n === 15) setAutoRefreshMin(n)
  }, [])
  useEffect(() => {
    window.localStorage.setItem('nexus-replenishment-autorefresh', String(autoRefreshMin))
  }, [autoRefreshMin])

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ window: '30' })
      if (channelFilter) params.set('channel', channelFilter)
      if (marketplaceFilter) params.set('marketplace', marketplaceFilter)
      const [r1, r2] = await Promise.all([
        fetch(
          `${getBackendUrl()}/api/fulfillment/replenishment?${params.toString()}`,
          { cache: 'no-store' },
        ),
        fetch(
          `${getBackendUrl()}/api/fulfillment/replenishment/upcoming-events`,
          { cache: 'no-store' },
        ),
      ])
      if (r1.ok) setData(await r1.json())
      if (r2.ok) {
        const ev = await r2.json()
        setEvents(ev.events ?? [])
      }
    } finally {
      setLoading(false)
    }
  }, [channelFilter, marketplaceFilter])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Real-time sync — refresh when stock or product data changes elsewhere
  useInvalidationChannel(
    ['stock.adjusted', 'stock.transferred', 'product.updated', 'product.created', 'pim.changed'],
    useCallback(() => { fetchData() }, [fetchData]),
  )

  // Grid expand/collapse state
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const onToggleExpand = useCallback((pid: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev)
      if (next.has(pid)) next.delete(pid); else next.add(pid)
      return next
    })
  }, [])

  // F.5.1 — Facets for the marketplace dropdown. Sourced from
  // /fulfillment/facets (distinct ACTIVE ChannelListing.marketplace
  // values), with a hardcoded fallback during initial load + on
  // facets endpoint failure so the dropdown is never empty.
  const FACETS_FALLBACK = ['IT', 'DE', 'FR', 'ES', 'UK', 'GLOBAL']
  const [marketplaceOptions, setMarketplaceOptions] =
    useState<string[]>(FACETS_FALLBACK)
  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendUrl()}/api/fulfillment/facets`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return
        const list = Array.isArray(j.marketplaces) ? j.marketplaces : []
        if (list.length > 0) setMarketplaceOptions(list)
      })
      .catch(() => {
        // Keep fallback. Operator can still filter manually via URL.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Keep flat filtered list for existing bulk actions / drawer lookup
  const filtered = useMemo(() => {
    if (!data) return []
    let rows = data.suggestions
    if (filter === 'CRITICAL') rows = rows.filter((s) => s.urgency === 'CRITICAL')
    else if (filter === 'HIGH')
      rows = rows.filter((s) => s.urgency === 'HIGH' || s.urgency === 'CRITICAL')
    else if (filter === 'MEDIUM') rows = rows.filter((s) => s.urgency === 'MEDIUM')
    else if (filter === 'NEEDS_REORDER') rows = rows.filter((s) => s.needsReorder)
    if (urlSearch.trim()) {
      const q = urlSearch.trim().toLowerCase()
      rows = rows.filter(
        (r) => r.sku.toLowerCase().includes(q) || r.name.toLowerCase().includes(q),
      )
    }
    const dir = sortDir === 'asc' ? 1 : -1
    if (sortBy !== 'urgency') {
      rows = [...rows].sort((a, b) => {
        switch (sortBy) {
          case 'daysOfCover': return ((a.daysOfStockLeft ?? 999) - (b.daysOfStockLeft ?? 999)) * dir
          case 'velocity':    return ((a.velocity ?? 0) - (b.velocity ?? 0)) * dir
          case 'qty':         return ((a.reorderQuantity ?? 0) - (b.reorderQuantity ?? 0)) * dir
          case 'stock':       return ((a.effectiveStock ?? 0) - (b.effectiveStock ?? 0)) * dir
          case 'sku':         return a.sku.localeCompare(b.sku) * dir
          case 'name':        return a.name.localeCompare(b.name) * dir
          default:            return 0
        }
      })
    }
    return rows
  }, [data, filter, urlSearch, sortBy, sortDir])

  // Build hierarchy grid rows from the flat suggestion list.
  // All child data is pre-loaded — no lazy-fetch needed for Xavia's ~279 SKUs.
  const { gridRows, childrenByParent } = useMemo((): {
    gridRows: RepRow[]
    childrenByParent: Record<string, RepRow[]>
  } => {
    if (!data) return { gridRows: [], childrenByParent: {} }

    // Apply filter/search to leaf suggestions
    const leafRows = filtered

    // Helper: build a RepRow from a leaf suggestion
    const leafToRow = (s: Suggestion): RepRow => ({
      id: s.productId,
      sku: s.sku,
      name: s.name,
      thumbnailUrl: s.thumbnailUrl ?? null,
      isParent: false,
      parentId: s.parentId,
      childCount: 0,
      urgency: s.urgency,
      needsReorder: s.needsReorder,
      currentStock: s.currentStock,
      reorderQty: s.reorderQuantity,
      velocity: s.velocity,
      daysOfStockLeft: s.daysOfStockLeft,
      leadTimeDays: s.leadTimeDays,
      suggestion: s,
    })

    // Helper: build a synthetic parent row aggregating an array of RepRows
    const buildParent = (
      id: string, sku: string, name: string, thumbnailUrl: string | null,
      parentId: string | null, children: RepRow[],
    ): RepRow => {
      const urgencies = children.map((c) => c.urgency).filter((u): u is Urgency => u !== null)
      const worstUrgency = urgencies.length > 0
        ? urgencies.sort((a, b) => URGENCY_ORDER[a] - URGENCY_ORDER[b])[0]
        : null
      return {
        id,
        sku,
        name,
        thumbnailUrl,
        isParent: true,
        parentId,
        childCount: children.length,
        urgency: worstUrgency,
        needsReorder: children.some((c) => c.needsReorder),
        currentStock: children.reduce((s, c) => s + c.currentStock, 0),
        reorderQty: children.filter((c) => c.needsReorder).reduce((s, c) => s + c.reorderQty, 0),
        velocity: children.length > 0 ? children.reduce((s, c) => s + c.velocity, 0) / children.length : 0,
        daysOfStockLeft: children.reduce((min, c) => {
          if (c.daysOfStockLeft === null) return min
          return min === null ? c.daysOfStockLeft : Math.min(min, c.daysOfStockLeft)
        }, null as number | null),
        leadTimeDays: children.length > 0 ? Math.max(...children.map((c) => c.leadTimeDays)) : 0,
        suggestion: null,
      }
    }

    // Collect all unique parent/grandparent IDs so we can build hierarchy rows
    // for parents even if they have no suggestions themselves (0 stock products).
    // We group by: grandparentId → parentId → leaf
    const byGrandparent = new Map<string, Map<string, Suggestion[]>>()  // grandparentId → parentId → suggestions
    const byParent      = new Map<string, Suggestion[]>()                // parentId → suggestions (2-level)
    const standalone    = new Map<string, Suggestion>()                  // productId → suggestion

    for (const s of leafRows) {
      if (s.grandparentId && s.parentId) {
        // 3-level: grandparent → parent → leaf
        if (!byGrandparent.has(s.grandparentId)) byGrandparent.set(s.grandparentId, new Map())
        const midMap = byGrandparent.get(s.grandparentId)!
        if (!midMap.has(s.parentId)) midMap.set(s.parentId, [])
        midMap.get(s.parentId)!.push(s)
      } else if (s.parentId) {
        // 2-level: parent → leaf
        if (!byParent.has(s.parentId)) byParent.set(s.parentId, [])
        byParent.get(s.parentId)!.push(s)
      } else {
        // standalone
        standalone.set(s.productId, s)
      }
    }

    const topRows: RepRow[] = []
    const childMap: Record<string, RepRow[]> = {}

    // 3-level: grandparent rows at top level
    for (const [gpId, midMap] of byGrandparent) {
      // Find a suggestion to get grandparent name/sku (all children know their grandparent)
      const anySug = [...midMap.values()][0]?.[0]
      if (!anySug) continue
      // Build intermediate (parent) rows
      const midRows: RepRow[] = []
      for (const [midId, leaves] of midMap) {
        const leafRepRows = leaves.map(leafToRow)
        const midRow = buildParent(
          midId,
          anySug.parentSku ?? midId,
          anySug.parentName ?? midId,
          anySug.parentThumbnailUrl ?? null,
          gpId,
          leafRepRows,
        )
        midRows.push(midRow)
        childMap[midId] = leafRepRows
      }
      const gpRow = buildParent(
        gpId,
        anySug.grandparentSku ?? gpId,
        anySug.grandparentName ?? gpId,
        anySug.grandparentThumbnailUrl ?? null,
        null,
        midRows,
      )
      topRows.push(gpRow)
      childMap[gpId] = midRows
    }

    // 2-level: parent rows at top level
    for (const [pid, leaves] of byParent) {
      const anySug = leaves[0]
      const leafRepRows = leaves.map(leafToRow)
      const parentRow = buildParent(
        pid,
        anySug.parentSku ?? pid,
        anySug.parentName ?? pid,
        anySug.parentThumbnailUrl ?? null,
        null,
        leafRepRows,
      )
      topRows.push(parentRow)
      childMap[pid] = leafRepRows
    }

    // Standalone leaf rows (no parent)
    for (const s of standalone.values()) topRows.push(leafToRow(s))

    // Sort top-level rows: parents-with-CRITICAL first, then urgency order, then by name
    topRows.sort((a, b) => {
      const ao = a.urgency ? URGENCY_ORDER[a.urgency] : 99
      const bo = b.urgency ? URGENCY_ORDER[b.urgency] : 99
      return ao !== bo ? ao - bo : a.name.localeCompare(b.name)
    })

    return { gridRows: topRows, childrenByParent: childMap }
  }, [data, filtered])

  // R.5 — auto-refresh. Pause when document is hidden so a backgrounded
  // tab doesn't burn requests.
  useEffect(() => {
    if (autoRefreshMin === 0) return
    const ms = autoRefreshMin * 60_000
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchData()
    }, ms)
    return () => window.clearInterval(id)
  }, [autoRefreshMin, fetchData])

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const clearSelection = () => setSelectedIds(new Set())

  const draftSinglePo = async (s: Suggestion) => {
    if (s.isManufactured) {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/work-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: s.productId,
          quantity: s.reorderQuantity,
          notes: 'Replenishment auto-suggestion',
        }),
      })
      if (res.ok) {
        pushToast('ok', `Work order created for ${s.reorderQuantity} × ${s.sku}`)
        fetchData()
      } else pushToast('error', 'Work order create failed')
      return
    }
    const res = await fetch(
      `${getBackendUrl()}/api/fulfillment/replenishment/${s.productId}/draft-po`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quantity: s.reorderQuantity,
          supplierId: s.preferredSupplierId,
          // R.3 — link PO back to source recommendation
          recommendationId: s.recommendationId ?? undefined,
        }),
      },
    )
    if (res.ok) {
      const po = await res.json()
      pushToast('ok', `Draft PO ${po.poNumber} created`)
      fetchData()
    } else {
      pushToast('error', 'Draft PO failed')
    }
  }

  // W2.2 — opens DismissReasonModal with a callback. Replaces 4
  // window.prompt() callsites with a proper modal that supports dark
  // mode, focus management, escape-to-cancel, and Italian i18n.
  const askDismissReason = useCallback(
    (title: string, onConfirm: (reason: string | null) => void) => {
      setDismissPrompt({ title, onConfirm })
    },
    [],
  )

  // R.21 — Bulk-dismiss every currently-selected recommendation. The
  // backend loops single-id dismiss internally; we get back per-id
  // counts. Toast summarises so operators clearing 200 noisy MEDIUMs
  // see exactly what landed.
  const bulkDismissSelected = async (reason: string | null) => {
    const ids = filtered
      .filter((s) => selectedIds.has(s.productId) && s.recommendationId)
      .map((s) => s.recommendationId!)
    if (ids.length === 0) {
      pushToast('error', 'No recommendations selected (or selection lacks rec ids)')
      return
    }
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/recommendations/bulk-dismiss`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recommendationIds: ids, reason }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const r = await res.json()
      const parts = [`${r.succeeded} dismissed`]
      if (r.alreadyTerminal > 0) parts.push(`${r.alreadyTerminal} already gone`)
      if (r.failed?.length > 0) parts.push(`${r.failed.length} errored`)
      pushToast(r.failed?.length > 0 ? 'error' : 'ok', parts.join(' · '))
      clearSelection()
      fetchData()
    } catch (err) {
      pushToast(
        'error',
        `Bulk dismiss failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // R.21 — Dismiss a recommendation. ACTIVE → DISMISSED in DB; the
  // operator's reason flows to dismissedReason for audit. We refetch
  // after success so the row falls out of the visible list (it's no
  // longer ACTIVE on the next forecast pass either, until the engine
  // generates a fresh rec — which it will when the underlying signal
  // changes).
  const dismissRow = async (s: Suggestion, reason: string | null) => {
    if (!s.recommendationId) {
      pushToast('error', 'No recommendation id on this row')
      return
    }
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/recommendations/${s.recommendationId}/dismiss`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      pushToast('ok', `Dismissed: ${s.sku}`)
      fetchData()
    } catch (err) {
      pushToast(
        'error',
        `Dismiss failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const drawerProduct = useMemo(
    () => filtered.find((s) => s.productId === drawerProductId) ?? null,
    [filtered, drawerProductId],
  )

  // Grid renderCell
  const renderCell = useCallback((row: RepRow, colKey: string): React.ReactNode => {
    switch (colKey) {
      case 'thumb':
        return row.thumbnailUrl ? (
          <img src={row.thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover bg-slate-100 flex-shrink-0" />
        ) : (
          <div className="w-8 h-8 rounded bg-slate-100 flex items-center justify-center text-slate-400 flex-shrink-0">
            <Package size={14} />
          </div>
        )
      case 'product':
        return (
          <div className="min-w-0 overflow-hidden">
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{row.name}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate">{row.sku}</div>
          </div>
        )
      case 'urgency':
        if (!row.urgency) return <span className="text-slate-300 dark:text-slate-600">—</span>
        return (
          <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${URGENCY_TONE[row.urgency]}`}>
            {row.urgency}
          </span>
        )
      case 'stock':
        return <span className="tabular-nums font-semibold text-slate-900 dark:text-slate-100">{row.currentStock}</span>
      case 'daysLeft': {
        const d = row.daysOfStockLeft
        if (d === null) return <span className="text-slate-300 dark:text-slate-600">—</span>
        const tone = d <= 7 ? 'text-rose-600 font-semibold' : d <= 14 ? 'text-orange-600 font-semibold' : d <= 30 ? 'text-amber-600' : 'text-slate-600 dark:text-slate-400'
        return <span className={`tabular-nums ${tone}`}>{Math.round(d)}d</span>
      }
      case 'velocity':
        return <span className="tabular-nums text-slate-600 dark:text-slate-400">{row.velocity.toFixed(1)}</span>
      case 'demand': {
        const s = row.suggestion
        if (!s) {
          // parent row — show total reorder demand
          const total = row.reorderQty
          return total > 0 ? <span className="tabular-nums text-slate-600 dark:text-slate-400">{total}</span> : <span className="text-slate-300">—</span>
        }
        const demand = s.forecastedDemandLeadTime ?? (s.velocity * s.leadTimeDays)
        return <span className="tabular-nums text-slate-600 dark:text-slate-400">{Math.round(demand)}</span>
      }
      case 'reorderQty':
        if (row.reorderQty === 0) return <span className="text-slate-300 dark:text-slate-600">—</span>
        return (
          <span className={`tabular-nums font-semibold ${row.needsReorder ? 'text-slate-900 dark:text-slate-100' : 'text-slate-400'}`}>
            {row.reorderQty}
          </span>
        )
      case 'actions': {
        if (row.isParent) return null
        const s = row.suggestion!
        return (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); void draftSinglePo(s) }}
              disabled={!s.needsReorder}
              className="h-6 px-2 text-xs bg-slate-900 dark:bg-slate-700 text-white rounded hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1"
              title={s.isManufactured ? 'Create work order' : 'Draft PO'}
            >
              <ShoppingCart size={10} />
              {s.isManufactured ? 'WO' : 'PO'}
            </button>
            {s.recommendationId && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  askDismissReason(
                    t('replenishment.dismiss.titleSku', { sku: s.sku }),
                    (reason) => { void dismissRow(s, reason) },
                  )
                }}
                className="h-6 px-1.5 text-xs text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900 rounded hover:bg-rose-50 dark:hover:bg-rose-950/40"
                title="Dismiss recommendation"
              >
                <X size={10} />
              </button>
            )}
          </div>
        )
      }
      default:
        return null
    }
  }, [draftSinglePo, dismissRow, askDismissReason, t])

  // Grid row selection — maps to leaf productId
  const gridRowsRef = useRef<RepRow[]>([])
  gridRowsRef.current = gridRows
  const allGridSelected = gridRows.length > 0 && gridRows.every((r) => !r.isParent && selectedIds.has(r.id))

  const toggleGridSelectAll = useCallback(() => {
    const leafIds = gridRowsRef.current.filter((r) => !r.isParent).map((r) => r.id)
    if (allGridSelected) setSelectedIds(new Set())
    else setSelectedIds(new Set(leafIds))
  }, [allGridSelected])

  // Reset focused index when filtered list changes and current focus
  // is out of bounds (e.g. user changed filter and the focused row
  // disappeared).
  useEffect(() => {
    if (focusedIndex >= filtered.length) {
      setFocusedIndex(filtered.length > 0 ? filtered.length - 1 : -1)
    }
  }, [filtered, focusedIndex])

  // Scroll the focused row into view. `block: 'nearest'` keeps the
  // page from scrolling when the row is already visible.
  useEffect(() => {
    if (focusedIndex < 0 || focusedIndex >= filtered.length) return
    const id = filtered[focusedIndex].productId
    const el = document.querySelector<HTMLElement>(`[data-suggestion-id="${id}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [focusedIndex, filtered])

  // Global keyboard handler. Skips when the user is typing in an
  // input/textarea (except Esc, which still routes through to close
  // the drawer / blur the input). Help overlay (?) toggles a modal
  // listing all shortcuts.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const inInput =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable === true

      if (e.key === 'Escape') {
        if (helpOpen) {
          setHelpOpen(false)
          return
        }
        if (inInput) {
          ;(target as HTMLElement).blur()
          return
        }
        if (drawerProductId) {
          setDrawerProductId(null)
          return
        }
        if (selectedIds.size > 0) {
          clearSelection()
          return
        }
        if (focusedIndex >= 0) {
          setFocusedIndex(-1)
          return
        }
      }

      if (inInput) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === '?') {
        e.preventDefault()
        setHelpOpen((v) => !v)
        return
      }
      if (helpOpen) return

      if (e.key === 'j' || e.key === 'ArrowDown') {
        if (filtered.length === 0) return
        e.preventDefault()
        setFocusedIndex((i) => {
          if (i < 0) return 0
          return Math.min(filtered.length - 1, i + 1)
        })
        return
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        if (filtered.length === 0) return
        e.preventDefault()
        setFocusedIndex((i) => Math.max(0, i - 1))
        return
      }

      const focused =
        focusedIndex >= 0 && focusedIndex < filtered.length
          ? filtered[focusedIndex]
          : null

      if (focused) {
        if (e.key === 'Enter') {
          e.preventDefault()
          setDrawerProductId(focused.productId)
          return
        }
        if (e.key === 'x' || e.key === ' ') {
          e.preventDefault()
          toggleSelected(focused.productId)
          return
        }
        if (e.key === 'p') {
          e.preventDefault()
          draftSinglePo(focused)
          return
        }
        if (e.key === 'd') {
          e.preventDefault()
          askDismissReason(
            t('replenishment.dismiss.titleSku', { sku: focused.sku }),
            (reason) => {
              void dismissRow(focused, reason)
            },
          )
          return
        }
      }

      if (e.key === '1') {
        e.preventDefault()
        setFilter('CRITICAL')
        return
      }
      if (e.key === '2') {
        e.preventDefault()
        setFilter('HIGH')
        return
      }
      if (e.key === '3') {
        e.preventDefault()
        setFilter('MEDIUM')
        return
      }
      if (e.key === '0') {
        e.preventDefault()
        setFilter('ALL')
        return
      }
      if (e.key === '/') {
        e.preventDefault()
        const input = document.querySelector<HTMLInputElement>(
          'input[placeholder="Search SKU…"]',
        )
        input?.focus()
        input?.select()
        return
      }
      if (e.key === 'r') {
        e.preventDefault()
        fetchData()
        return
      }
      if (e.key === 'g') {
        if (filtered.length === 0) return
        e.preventDefault()
        setFocusedIndex(0)
        return
      }
      if (e.key === 'G') {
        if (filtered.length === 0) return
        e.preventDefault()
        setFocusedIndex(filtered.length - 1)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filtered,
    focusedIndex,
    helpOpen,
    selectedIds,
    drawerProductId,
  ])

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('replenishment.title')}
        description={t('replenishment.description')}
        breadcrumbs={[
          { label: t('replenishment.breadcrumb.fulfillment'), href: '/fulfillment' },
          { label: t('replenishment.breadcrumb.self') },
        ]}
      />

      {/* U.67 — quick-filters strip. Single-select per dimension because
          the velocity backend does per-channel attribution math; an [All]
          chip + per-channel single-select keeps the UX consistent with
          /products and /listings. */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 flex items-center gap-x-5 gap-y-2 flex-wrap">
        <MultiSelectChips
          label="Channel"
          mode="single"
          options={ACTIVE_CHANNELS_OPTIONS}
          value={channelFilter ? [channelFilter] : []}
          onChange={(next) => setChannelFilter(next[0] ?? '')}
        />
        <MultiSelectChips
          label="Market"
          mode="single"
          options={ACTIVE_MARKETPLACES_OPTIONS}
          value={marketplaceFilter ? [marketplaceFilter] : []}
          onChange={(next) => setMarketplaceFilter(next[0] ?? '')}
        />
      </div>

      {/* W2.2 — dismiss-reason modal. Mounted once at the top of the
          tree; opened imperatively via askDismissReason() from row
          clicks, the bulk-dismiss button, and the 'd' keyboard shortcut. */}
      <DismissReasonModal
        open={dismissPrompt !== null}
        title={dismissPrompt?.title ?? ''}
        onClose={() => setDismissPrompt(null)}
        onConfirm={(reason) => {
          dismissPrompt?.onConfirm(reason)
          setDismissPrompt(null)
        }}
      />

      {/* W3.2 — command-center KPI strip. Five tiles answering
          "what should I do today?" — open POs / awaiting review /
          stockout risk / working capital / forecast accuracy.
          Distinct from the W1.5 pipeline-health strip which answers
          "is the system working?". */}
      <CommandCenterKpis onFilterCritical={() => setFilter('CRITICAL')} />

      {/* Upcoming-events banner — surfaces the next ≤3 events with prep deadlines */}
      {events && events.length > 0 && (
        <UpcomingEventsBanner events={events.slice(0, 3)} />
      )}

      {/* Urgency tiles */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <UrgencyTile
            label={t('replenishment.urgency.critical')}
            value={data.counts.critical}
            tone="CRITICAL"
            onClick={() => setFilter('CRITICAL')}
          />
          <UrgencyTile
            label={t('replenishment.urgency.high')}
            value={data.counts.high}
            tone="HIGH"
            onClick={() => setFilter('HIGH')}
          />
          <UrgencyTile
            label={t('replenishment.urgency.medium')}
            value={data.counts.medium}
            tone="MEDIUM"
            onClick={() => setFilter('MEDIUM')}
          />
          <UrgencyTile
            label={t('replenishment.urgency.lowOk')}
            value={data.counts.low}
            tone="LOW"
            onClick={() => setFilter('ALL')}
          />
        </div>
      )}

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center bg-slate-100 dark:bg-slate-800 rounded-md p-0.5">
          {(['NEEDS_REORDER', 'CRITICAL', 'HIGH', 'MEDIUM', 'ALL'] as const).map(
            (t) => (
              <button
                key={t}
                onClick={() => setFilter(t)}
                className={cn(
                  'h-7 px-3 text-base font-medium rounded transition-colors',
                  filter === t
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100',
                )}
              >
                {t === 'NEEDS_REORDER'
                  ? 'Needs reorder'
                  : t.charAt(0) + t.slice(1).toLowerCase()}
              </button>
            ),
          )}
        </div>
        <select
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value)}
          className="h-8 px-2 border border-slate-200 dark:border-slate-700 rounded-md text-base bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
        >
          <option value="">All channels</option>
          <option value="AMAZON">Amazon</option>
          <option value="EBAY">eBay</option>
          <option value="SHOPIFY">Shopify</option>
          <option value="WOOCOMMERCE">WooCommerce</option>
        </select>
        <select
          value={marketplaceFilter}
          onChange={(e) => setMarketplaceFilter(e.target.value)}
          className="h-8 px-2 border border-slate-200 dark:border-slate-700 rounded-md text-base bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
        >
          <option value="">All marketplaces</option>
          {marketplaceOptions.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <SavedViewsButton
          currentState={{
            filter,
            channelFilter,
            marketplaceFilter,
            search: urlSearch,
            sortBy,
            sortDir,
          }}
          onLoad={(state) => {
            updateUrl({
              filter: state.filter === 'NEEDS_REORDER' ? undefined : state.filter,
              channel: state.channelFilter || undefined,
              marketplace: state.marketplaceFilter || undefined,
              search: state.search || undefined,
              sortBy: state.sortBy === 'urgency' ? undefined : state.sortBy,
              sortDir: state.sortDir === 'desc' ? undefined : state.sortDir,
            })
          }}
        />

        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <Input
            placeholder="Search SKU…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-44 sm:w-56"
          />
          {/* R.5 — auto-refresh dropdown. Pauses when tab is hidden. */}
          <select
            value={autoRefreshMin}
            onChange={(e) => setAutoRefreshMin(Number(e.target.value) as 0 | 5 | 15)}
            className="h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            title="Auto-refresh interval (paused when tab hidden)"
          >
            <option value={0}>Auto-refresh: Off</option>
            <option value={5}>Auto-refresh: 5 min</option>
            <option value={15}>Auto-refresh: 15 min</option>
          </select>
          <Button
            onClick={fetchData}
            variant="secondary"
            size="md"
            icon={<RefreshCw size={12} aria-hidden="true" />}
          >
            Refresh
          </Button>
          {/* R.5 — CSV export of currently filtered + sorted suggestions */}
          <Button
            onClick={() => exportSuggestionsCsv(filtered)}
            variant="secondary"
            size="md"
            icon={<Download size={12} aria-hidden="true" />}
            title="Export the currently filtered + sorted suggestions to CSV"
            disabled={filtered.length === 0}
          >
            Export CSV
          </Button>
          <WidgetLauncher store={widgetStore} onToggle={toggleWidget} />
          <button
            onClick={() => setHelpOpen(true)}
            className="h-8 w-8 grid place-items-center text-base border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <Keyboard size={12} />
          </button>
        </div>
      </div>

      {/* Bulk action bar — visible only when rows are selected */}
      {selectedIds.size > 0 && (
        <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-md px-3 py-2 flex items-center justify-between gap-3">
          <div className="text-md text-slate-700 dark:text-slate-300">
            <span className="font-semibold">{selectedIds.size}</span>{' '}
            selected
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={clearSelection}
              variant="secondary"
              size="sm"
            >
              Clear
            </Button>
            <button
              type="button"
              onClick={() => {
                askDismissReason(
                  t('replenishment.dismiss.titleBulk', { count: selectedIds.size }),
                  (reason) => {
                    void bulkDismissSelected(reason)
                  },
                )
              }}
              className="h-7 px-3 text-base bg-white dark:bg-slate-900 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-900 rounded hover:bg-red-50 dark:hover:bg-red-950/40 inline-flex items-center gap-1.5"
              title={t('replenishment.dismiss.bulkTooltip')}
            >
              <X size={12} /> {t('replenishment.dismiss.bulkButton')}
            </button>
            <Button
              type="button"
              onClick={() => setBulkOpen(true)}
              variant="primary"
              size="sm"
              icon={<ShoppingCart size={12} aria-hidden="true" />}
            >
              Bulk-create POs
            </Button>
          </div>
        </div>
      )}

      {/* Grid */}
      {loading && !data ? (
        <Card>
          <div className="text-md text-slate-500 dark:text-slate-400 py-8 text-center inline-flex items-center justify-center gap-2 w-full">
            <Loader2 className="w-4 h-4 animate-spin" />
            Reading forecast layer…
          </div>
        </Card>
      ) : gridRows.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Nothing to reorder"
          description="All products in this view have plenty of runway."
        />
      ) : (
        <>
          {/* Mobile cards */}
          <div className="lg:hidden space-y-2">
            {filtered.map((s, idx) => (
              <MobileSuggestionCard
                key={s.productId}
                s={s}
                selected={selectedIds.has(s.productId)}
                focused={idx === focusedIndex}
                onToggleSelect={() => toggleSelected(s.productId)}
                onOpenDrawer={() => setDrawerProductId(s.productId)}
                onDraftPo={() => draftSinglePo(s)}
                onDismiss={() =>
                  askDismissReason(
                    t('replenishment.dismiss.titleSku', { sku: s.sku }),
                    (reason) => { void dismissRow(s, reason) },
                  )
                }
              />
            ))}
          </div>
          {/* Desktop — VirtualizedGrid matches /products UX exactly */}
          <div className="hidden lg:block">
            <VirtualizedGrid<RepRow>
              rows={gridRows}
              visible={REP_COLUMNS}
              density="comfortable"
              cellPad={DENSITY_CELL_CLASS.comfortable}
              childrenByParent={childrenByParent}
              loadingChildren={_REP_EMPTY_SET}
              expandedParents={expandedParents}
              onToggleExpand={onToggleExpand}
              selected={selectedIds}
              toggleSelect={(id: string) => toggleSelected(id)}
              toggleSelectAll={toggleGridSelectAll}
              allSelected={allGridSelected}
              sortBy=""
              onSort={() => undefined}
              focusedRowId={null}
              searchTerm={urlSearch}
              riskFlaggedSkus={_REP_EMPTY_SET}
              renderCell={renderCell}
              storageKey="replenishment-grid"
            />
            <GridFooter count={gridRows.length} label="products" />
          </div>
        </>
      )}

      {/* Toast tray now lives at the app layout level (ToastProvider in
          /app/layout.tsx → /components/ui/Toast.tsx). pushToast above
          calls into the shared useToast() hook. */}

      {/* Detail drawer */}
      {drawerProduct && (
        <ForecastDetailDrawer
          productId={drawerProduct.productId}
          marketplace={marketplaceFilter || null}
          channel={channelFilter || null}
          onClose={() => setDrawerProductId(null)}
        />
      )}

      {/* Keyboard shortcuts overlay (?) */}
      {helpOpen && <KeyboardHelpOverlay onClose={() => setHelpOpen(false)} />}

      {/* Bulk-PO modal */}
      {bulkOpen && (
        <BulkPoModal
          suggestions={filtered.filter((s) => selectedIds.has(s.productId))}
          onClose={() => setBulkOpen(false)}
          onSuccess={() => {
            setBulkOpen(false)
            clearSelection()
            fetchData()
          }}
        />
      )}

      {/* Floating widgets — rendered outside the scroll container so they
          can be dragged freely across the viewport */}
      <ReplenishmentWidgets
        store={widgetStore}
        onClose={closeWidget}
        onMove={moveWidget}
        onFocus={focusWidget}
        onRefreshPageData={fetchData}
        containerFill={data?.containerFill}
      />
    </div>
  )
}

// W9.6 — UrgencyTile + UpcomingEventsBanner moved to _shared/UrgencyTiles.tsx
// W9.6b — SortableTh moved to _shared/SortableTh.tsx

// W9.6c — MobileSuggestionCard moved to _shared/MobileSuggestionCard.tsx
// (imported alongside Suggestion at the top of this file).

// R.5 — CSV export of currently filtered + sorted suggestions.
// Pure client-side: build the CSV string, trigger a download via
// <a download>. No new endpoint.
function exportSuggestionsCsv(suggestions: Suggestion[]): void {
  const rows: string[][] = [
    [
      'SKU', 'Name', 'Urgency', 'On-hand', 'Inbound (LT)', 'Effective stock',
      'Velocity (units/day)', 'Forecast 30d', 'Days of cover', 'Reorder point',
      'Reorder qty', 'Safety stock', 'EOQ', 'Constraints', 'Lead time (days)',
      'Supplier', 'Recommendation ID',
    ],
  ]
  for (const s of suggestions) {
    rows.push([
      s.sku,
      s.name,
      s.urgency,
      String(s.currentStock),
      String(s.inboundWithinLeadTime),
      String(s.effectiveStock),
      String(s.velocity),
      s.forecastedDemand30d != null ? String(s.forecastedDemand30d) : '',
      s.daysOfStockLeft != null ? String(s.daysOfStockLeft) : '',
      String(s.reorderPoint),
      String(s.reorderQuantity),
      s.safetyStockUnits != null ? String(s.safetyStockUnits) : '',
      s.eoqUnits != null ? String(s.eoqUnits) : '',
      (s.constraintsApplied ?? []).join('|'),
      String(s.leadTimeDays),
      s.preferredSupplierId ?? '',
      s.recommendationId ?? '',
    ])
  }
  const csv = rows
    .map((r) => r.map((cell) => {
      const needsQuote = /[",\n]/.test(cell)
      return needsQuote ? `"${cell.replace(/"/g, '""')}"` : cell
    }).join(','))
    .join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `replenishment-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}



// W2.2 — Dismiss-reason prompt. Modal-based replacement for the four
// window.prompt() callsites that asked for an optional dismiss reason.
// Centralised so the operator gets focus management, escape-to-cancel,
// dark mode, and Italian i18n — none of which window.prompt offers.
function DismissReasonModal({
  open,
  title,
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  onClose: () => void
  onConfirm: (reason: string | null) => void
}) {
  const { t } = useTranslations()
  const [reason, setReason] = useState('')
  // Reset every time the modal opens for a fresh prompt.
  useEffect(() => {
    if (open) setReason('')
  }, [open])
  return (
    <Modal open={open} onClose={onClose} title={title} size="md">
      <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
        {t('replenishment.dismiss.optionalReasonHint')}
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        autoFocus
        placeholder={t('replenishment.dismiss.placeholder')}
        aria-label={t('replenishment.dismiss.reasonLabel')}
        className="w-full text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
        onKeyDown={(e) => {
          // ⌘+Enter / Ctrl+Enter submits, matching ConfirmDialog ergonomics.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onConfirm(reason.trim() || null)
          }
        }}
      />
      <ModalFooter>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="danger"
          onClick={() => onConfirm(reason.trim() || null)}
        >
          {t('replenishment.dismiss.confirmButton')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

// W1.5 — Pipeline health strip. Surfaces foundation-table row counts
// + cron status + a "Run pipeline now" button so silent failures of
// the forecast layer become visible at a glance. Pairs with W1.3
// (POST .../pipeline/run) and W1.4 (GET .../pipeline/health).
//
// Tone rules:
//   green  — rows > 0 AND last cron success within 48h
//   amber  — rows > 0 AND last cron stale (>48h) OR no recent run
//   red    — rows = 0 (foundation table empty)
//   slate  — disabled via env flag (informational, not a failure)
// W9.6e — ReorderMathPanel (R.4) moved to _shared/ReorderMathPanel.tsx
// (imported at the top of this file).

// W9.6m — SubstitutionPanel (R.17) + RecommendationHistoryCard (R.3)
// moved to _shared/SubstitutionPanel.tsx + _shared/RecommendationHistoryCard.tsx
// (imported at the top of this file).

// W9.6n — ForecastAccuracyCard (R.1) + ForecastHealthCard (R.2) moved
// to _shared/ForecastDiagnosticsCards.tsx (imported at the top).



