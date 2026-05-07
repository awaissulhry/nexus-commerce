'use client'

// H.3 — multi-location stock workspace.
//
// Reads /api/stock (StockLevel ledger) instead of /api/fulfillment/stock.
// Each row is a (product, location) pair so a single SKU can appear once
// per location it stocks at — Riccione vs Amazon-EU-FBA, etc. The drawer
// opens by productId and aggregates across locations; full multi-location
// breakdown lives in Commit 4.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  Warehouse, Search, RefreshCw, Package, ChevronRight,
  X, History, ExternalLink, ArrowRightLeft, Plus, Minus,
  Boxes, AlertTriangle, TrendingDown, Layers, Activity, Truck,
  Lock as LockIcon, Table as TableIcon, Grid, LayoutGrid,
  Check, Download, Sliders, Undo2, CheckCircle2,
  Lightbulb, Zap, AlertCircle,
  Columns, Maximize2, Minimize2, Keyboard,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'

type StockRow = {
  id: string
  quantity: number
  reserved: number
  available: number
  reorderThreshold: number | null
  syncStatus: string
  lastUpdatedAt: string
  lastSyncedAt: string | null
  location: { id: string; code: string; name: string; type: string }
  product: {
    id: string
    sku: string
    name: string
    amazonAsin: string | null
    lowStockThreshold: number
    costPrice: number | null
    basePrice: number | null
    thumbnailUrl: string | null
  }
  variation: { id: string; sku: string; variationAttributes: any } | null
}

type LocationSummary = {
  id: string
  code: string
  name: string
  type: string
  skuCount: number
  totalQuantity: number
  totalReserved: number
  totalAvailable: number
}

type Density = 'compact' | 'comfortable' | 'spacious'
type ColumnKey = 'thumb' | 'product' | 'location' | 'onHand' | 'reserved' | 'available' | 'threshold' | 'cost' | 'updated'
const ALL_COLUMNS: Array<{ key: ColumnKey; label: string; alwaysOn?: boolean }> = [
  { key: 'thumb',     label: 'Thumb',     alwaysOn: true },
  { key: 'product',   label: 'Product',   alwaysOn: true },
  { key: 'location',  label: 'Location' },
  { key: 'onHand',    label: 'On hand' },
  { key: 'reserved',  label: 'Reserved' },
  { key: 'available', label: 'Available' },
  { key: 'threshold', label: 'Threshold' },
  { key: 'cost',      label: 'Cost' },
  { key: 'updated',   label: 'Updated' },
]
const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = ['thumb', 'product', 'location', 'onHand', 'reserved', 'available', 'threshold', 'cost', 'updated']
const DENSITY_PADDING: Record<Density, string> = {
  compact:     'py-1',
  comfortable: 'py-2',
  spacious:    'py-3',
}

type SyncStatus = {
  amazonFbaCron: {
    configured: boolean
    enabled: boolean
    lastReconciliationAt: string | null
    lastReconciliationDelta: number | null
  }
  reservationSweep: {
    scheduled: boolean
    lastRunAt: string | null
    lastReleasedCount: number
  }
  outboundQueue: {
    pending: number
    syncing: number
    failed: number
    synced: number
    oldestPendingAt: string | null
  }
  recentReconciliationCount: number
}

type Insights = {
  stockoutRisk: Array<{
    id: string; sku: string; name: string; amazonAsin: string | null
    totalStock: number; lowStockThreshold: number
    costPrice: number | null; thumbnailUrl: string | null
  }>
  allocationGaps: Array<{
    productId: string; sku: string; name: string; thumbnailUrl: string | null
    surplusLocation: { id: string; code: string; quantity: number }
    deficitLocation: { id: string; code: string; quantity: number }
    suggestedTransfer: number
  }>
  syncConflicts: Array<{
    id: string; productId: string; sku: string | null; name: string | null
    asin: string | null; locationCode: string | null
    change: number; quantityBefore: number | null; balanceAfter: number
    notes: string | null; createdAt: string
  }>
}

type ProductBundle = {
  id: string
  sku: string
  name: string
  amazonAsin: string | null
  totalStock: number
  lowStockThreshold: number
  costPrice: number | null
  basePrice: number | null
  thumbnailUrl: string | null
  stockLevels: Array<{
    id: string
    locationId: string
    quantity: number
    reserved: number
    available: number
    lastUpdatedAt: string
  }>
}

type ViewMode = 'table' | 'matrix' | 'cards'

type Kpis = {
  totalStockUnits: number
  totalStockValue: number
  totalReserved: number
  totalAvailable: number
  stockouts: number
  critical: number
  low: number
  healthy: number
  totalSkus: number
  activeLocations: number
}

type Movement = {
  id: string
  productId: string
  variationId: string | null
  warehouseId: string | null
  locationId: string | null
  change: number
  balanceAfter: number
  quantityBefore: number | null
  reason: string
  referenceType: string | null
  referenceId: string | null
  notes: string | null
  actor: string | null
  createdAt: string
}

const REASON_TONE: Record<string, string> = {
  ORDER_PLACED: 'text-rose-600 bg-rose-50',
  ORDER_CANCELLED: 'text-emerald-600 bg-emerald-50',
  RETURN_RECEIVED: 'text-blue-600 bg-blue-50',
  RETURN_RESTOCKED: 'text-emerald-600 bg-emerald-50',
  INBOUND_RECEIVED: 'text-emerald-600 bg-emerald-50',
  SUPPLIER_DELIVERY: 'text-emerald-600 bg-emerald-50',
  MANUFACTURING_OUTPUT: 'text-violet-600 bg-violet-50',
  FBA_TRANSFER_OUT: 'text-orange-600 bg-orange-50',
  FBA_TRANSFER_IN: 'text-orange-600 bg-orange-50',
  TRANSFER_OUT: 'text-orange-600 bg-orange-50',
  TRANSFER_IN: 'text-orange-600 bg-orange-50',
  MANUAL_ADJUSTMENT: 'text-slate-600 bg-slate-100',
  WRITE_OFF: 'text-rose-700 bg-rose-100',
  INVENTORY_COUNT: 'text-amber-600 bg-amber-50',
  SYNC_RECONCILIATION: 'text-blue-600 bg-blue-50',
  RESERVATION_CREATED: 'text-violet-600 bg-violet-50',
  RESERVATION_RELEASED: 'text-slate-600 bg-slate-100',
  RESERVATION_CONSUMED: 'text-rose-600 bg-rose-50',
  STOCKLEVEL_BACKFILL: 'text-slate-600 bg-slate-100',
  PARENT_PRODUCT_CLEANUP: 'text-slate-600 bg-slate-100',
}

const LOCATION_TONE: Record<string, string> = {
  WAREHOUSE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  AMAZON_FBA: 'bg-orange-50 text-orange-700 border-orange-200',
  CHANNEL_RESERVED: 'bg-violet-50 text-violet-700 border-violet-200',
}

const STATUS_OPTIONS = [
  { value: 'IN_STOCK', label: 'In stock', tone: 'emerald' },
  { value: 'LOW', label: 'Low', tone: 'amber' },
  { value: 'CRITICAL', label: 'Critical', tone: 'orange' },
  { value: 'OUT_OF_STOCK', label: 'Out of stock', tone: 'rose' },
] as const

export default function StockWorkspace() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const view = (searchParams.get('view') as ViewMode) ?? 'table'
  const locationCode = searchParams.get('location') ?? ''
  const status = searchParams.get('status') ?? ''
  const search = searchParams.get('search') ?? ''
  const page = parseInt(searchParams.get('page') ?? '1', 10) || 1

  const [searchInput, setSearchInput] = useState(search)
  const [items, setItems] = useState<StockRow[]>([])
  const [productBundles, setProductBundles] = useState<ProductBundle[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [drawerProductId, setDrawerProductId] = useState<string | null>(null)
  const [locations, setLocations] = useState<LocationSummary[]>([])
  const [kpis, setKpis] = useState<Kpis | null>(null)
  const [insights, setInsights] = useState<Insights | null>(null)
  const [insightsCollapsed, setInsightsCollapsed] = useState(false)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  // Persisted UI prefs (localStorage). Initialised lazily so SSR
  // doesn't crash on a missing window.
  const [density, setDensity] = useState<Density>('comfortable')
  const [visibleColumns, setVisibleColumns] = useState<ColumnKey[]>(DEFAULT_VISIBLE_COLUMNS)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  useEffect(() => {
    try {
      const d = localStorage.getItem('stock.density')
      if (d === 'compact' || d === 'comfortable' || d === 'spacious') setDensity(d)
      const c = localStorage.getItem('stock.columns')
      if (c) {
        const parsed = JSON.parse(c) as ColumnKey[]
        if (Array.isArray(parsed) && parsed.every((k) => ALL_COLUMNS.some((col) => col.key === k))) {
          setVisibleColumns(parsed)
        }
      }
    } catch { /* ignore */ }
  }, [])
  useEffect(() => {
    try { localStorage.setItem('stock.density', density) } catch { /* ignore */ }
  }, [density])
  useEffect(() => {
    try { localStorage.setItem('stock.columns', JSON.stringify(visibleColumns)) } catch { /* ignore */ }
  }, [visibleColumns])
  // Bulk-selection state. Set of StockLevel ids. Only used in table view —
  // matrix and cards address products directly so per-row selection is
  // less natural there. `lastSelectedIdx` powers shift-click range select.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastSelectedIdx, setLastSelectedIdx] = useState<number | null>(null)
  // Bulk action modal + result toast state
  const [bulkAction, setBulkAction] = useState<null | 'adjust' | 'threshold' | 'export'>(null)
  const [bulkProgress, setBulkProgress] = useState<null | { total: number; done: number; failed: number }>(null)
  const [undoBundle, setUndoBundle] = useState<null | { kind: 'adjust'; entries: Array<{ stockLevelId: string; inverseChange: number }>; expiresAt: number }>(null)

  const updateUrl = useCallback((patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }, [searchParams, pathname, router])

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== search) updateUrl({ search: searchInput || undefined, page: undefined })
    }, 250)
    return () => clearTimeout(t)
  }, [searchInput])

  const fetchStock = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams()
      qs.set('page', String(page))
      // Matrix + Cards aggregate by product, so they need a higher
      // pageSize ceiling to avoid splitting a single product across
      // pages. Table stays at the dense 50-row default.
      qs.set('pageSize', view === 'table' ? '50' : '100')
      if (status) qs.set('status', status)
      if (search) qs.set('search', search)
      // locationCode only applies to table (filters per-StockLevel rows).
      // Matrix shows all locations as columns; cards show all in badges.
      if (view === 'table' && locationCode) qs.set('locationCode', locationCode)
      const endpoint = view === 'table' ? '/api/stock' : '/api/stock/by-product'
      const res = await fetch(`${getBackendUrl()}${endpoint}?${qs.toString()}`, { cache: 'no-store' })
      if (!res.ok) {
        throw new Error(`stock list failed: ${res.status}`)
      }
      const data = await res.json()
      if (view === 'table') {
        setItems(data.items ?? [])
        setProductBundles([])
      } else {
        setProductBundles(data.products ?? [])
        setItems([])
      }
      setTotal(data.total ?? 0)
      setTotalPages(data.totalPages ?? 0)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load stock')
    } finally {
      setLoading(false)
    }
  }, [view, locationCode, status, search, page])

  const fetchSidecar = useCallback(async () => {
    try {
      const [locRes, kpiRes, insightsRes, syncRes] = await Promise.all([
        fetch(`${getBackendUrl()}/api/stock/locations`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/stock/kpis`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/stock/insights`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/stock/sync-status`, { cache: 'no-store' }),
      ])
      if (locRes.ok) {
        const data = await locRes.json()
        setLocations(data.locations ?? [])
      }
      if (kpiRes.ok) {
        setKpis(await kpiRes.json())
      }
      if (insightsRes.ok) {
        setInsights(await insightsRes.json())
      }
      if (syncRes.ok) {
        setSyncStatus(await syncRes.json())
      }
    } catch {
      // Sidecar is best-effort — the table still works without it.
    }
  }, [])

  useEffect(() => { fetchStock() }, [fetchStock])
  useEffect(() => { fetchSidecar() }, [fetchSidecar])

  // 30s poll + visibility-driven refresh
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        fetchStock()
        fetchSidecar()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchStock()
        fetchSidecar()
      }
    }, 30000)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      clearInterval(id)
    }
  }, [fetchStock, fetchSidecar])

  const filterCount = useMemo(
    () => [locationCode, status, search].filter(Boolean).length,
    [locationCode, status, search],
  )

  // Clear selection when the data set changes underneath us. Otherwise
  // `selected` would contain ids that aren't on the current page.
  useEffect(() => {
    setSelected(new Set())
    setLastSelectedIdx(null)
  }, [view, locationCode, status, search, page])

  // Keyboard shortcuts. Skipped when focus is in an input/textarea/select
  // (so typing isn't hijacked) unless the key is Escape.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const inField =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)

      // Escape always wins — closes drawer / cancels action / closes
      // shortcuts help.
      if (e.key === 'Escape') {
        if (shortcutsOpen) { setShortcutsOpen(false); return }
        if (bulkAction) { setBulkAction(null); return }
        if (drawerProductId) { setDrawerProductId(null); return }
        if (selected.size > 0) { setSelected(new Set()); return }
      }
      if (inField) return

      // Ignore mod+key — let browser defaults run, only handle bare keys.
      if (e.metaKey || e.ctrlKey || e.altKey) return

      switch (e.key) {
        case '/':
          e.preventDefault()
          ;(document.querySelector('input[placeholder^="Search"]') as HTMLInputElement | null)?.focus()
          break
        case '?':
          e.preventDefault()
          setShortcutsOpen(true)
          break
        case '1':
          updateUrl({ view: undefined, page: undefined })
          break
        case '2':
          updateUrl({ view: 'matrix', page: undefined })
          break
        case '3':
          updateUrl({ view: 'cards', page: undefined })
          break
        case 'r':
          fetchStock()
          fetchSidecar()
          break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [shortcutsOpen, bulkAction, drawerProductId, selected, updateUrl, fetchStock, fetchSidecar])

  // Tick the undo bundle's expiry every second so the toast disappears.
  useEffect(() => {
    if (!undoBundle) return
    const id = setInterval(() => {
      if (Date.now() > undoBundle.expiresAt) setUndoBundle(null)
    }, 500)
    return () => clearInterval(id)
  }, [undoBundle])

  // Selection helpers — table-view only, shift-click range, cmd-click toggle.
  const toggleSelect = useCallback((id: string, idx: number, ev: React.MouseEvent) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (ev.shiftKey && lastSelectedIdx != null) {
        const [lo, hi] = idx < lastSelectedIdx ? [idx, lastSelectedIdx] : [lastSelectedIdx, idx]
        for (let i = lo; i <= hi; i++) {
          const sl = items[i]
          if (sl) next.add(sl.id)
        }
      } else {
        if (next.has(id)) next.delete(id)
        else next.add(id)
      }
      return next
    })
    setLastSelectedIdx(idx)
  }, [items, lastSelectedIdx])

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size === items.length) return new Set()
      return new Set(items.map((it) => it.id))
    })
    setLastSelectedIdx(null)
  }, [items])

  // Bulk operation runners — sequential calls with progress reporting.
  // Sequential is intentional: 50 parallel PATCHes would let the cron
  // race with itself and the cascade fan-out would queue duplicate
  // OutboundSyncQueue rows. One at a time is honest and observable.
  const runBulkAdjust = useCallback(async (change: number, notes: string | null) => {
    const ids = Array.from(selected)
    setBulkProgress({ total: ids.length, done: 0, failed: 0 })
    const undoEntries: Array<{ stockLevelId: string; inverseChange: number }> = []
    for (const id of ids) {
      try {
        const res = await fetch(`${getBackendUrl()}/api/stock/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ change, notes }),
        })
        if (!res.ok) throw new Error(`${res.status}`)
        undoEntries.push({ stockLevelId: id, inverseChange: -change })
        setBulkProgress((p) => p ? { ...p, done: p.done + 1 } : p)
      } catch {
        setBulkProgress((p) => p ? { ...p, failed: p.failed + 1 } : p)
      }
    }
    setBulkProgress(null)
    setBulkAction(null)
    setSelected(new Set())
    if (undoEntries.length > 0) {
      setUndoBundle({ kind: 'adjust', entries: undoEntries, expiresAt: Date.now() + 30000 })
    }
    fetchStock()
    fetchSidecar()
  }, [selected, fetchStock, fetchSidecar])

  const runBulkThreshold = useCallback(async (threshold: number | null) => {
    const ids = Array.from(selected)
    setBulkProgress({ total: ids.length, done: 0, failed: 0 })
    for (const id of ids) {
      try {
        const res = await fetch(`${getBackendUrl()}/api/stock/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reorderThreshold: threshold }),
        })
        if (!res.ok) throw new Error(`${res.status}`)
        setBulkProgress((p) => p ? { ...p, done: p.done + 1 } : p)
      } catch {
        setBulkProgress((p) => p ? { ...p, failed: p.failed + 1 } : p)
      }
    }
    setBulkProgress(null)
    setBulkAction(null)
    setSelected(new Set())
    fetchStock()
  }, [selected, fetchStock])

  const runUndo = useCallback(async () => {
    if (!undoBundle) return
    const entries = undoBundle.entries
    setUndoBundle(null)
    setBulkProgress({ total: entries.length, done: 0, failed: 0 })
    for (const e of entries) {
      try {
        const res = await fetch(`${getBackendUrl()}/api/stock/${e.stockLevelId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ change: e.inverseChange, notes: 'Undo of bulk adjust', reason: 'MANUAL_ADJUSTMENT' }),
        })
        if (!res.ok) throw new Error(`${res.status}`)
        setBulkProgress((p) => p ? { ...p, done: p.done + 1 } : p)
      } catch {
        setBulkProgress((p) => p ? { ...p, failed: p.failed + 1 } : p)
      }
    }
    setBulkProgress(null)
    fetchStock()
    fetchSidecar()
  }, [undoBundle, fetchStock, fetchSidecar])

  const exportSelectedCsv = useCallback(() => {
    const rows = items.filter((it) => selected.has(it.id))
    if (rows.length === 0) return
    const headers = ['sku', 'name', 'asin', 'location', 'quantity', 'reserved', 'available', 'threshold', 'cost', 'updated']
    const lines = [headers.join(',')]
    for (const r of rows) {
      const cells = [
        r.product.sku,
        `"${r.product.name.replace(/"/g, '""')}"`,
        r.product.amazonAsin ?? '',
        r.location.code,
        r.quantity,
        r.reserved,
        r.available,
        r.reorderThreshold ?? r.product.lowStockThreshold,
        r.product.costPrice ?? '',
        r.lastUpdatedAt,
      ]
      lines.push(cells.join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `stock-export-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    setBulkAction(null)
  }, [items, selected])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Stock"
        description="Multi-location inventory ledger across Riccione, Amazon FBA, and per-channel allocations."
        breadcrumbs={[{ label: 'Fulfillment', href: '/fulfillment' }, { label: 'Stock' }]}
        actions={
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {syncStatus && <SyncIndicator status={syncStatus} />}
            <ViewToggle view={view} onChange={(v) => updateUrl({ view: v === 'table' ? undefined : v, page: undefined })} />
            {view === 'table' && (
              <>
                <DensityToggle density={density} onChange={setDensity} />
                <ColumnPicker visible={visibleColumns} onChange={setVisibleColumns} />
              </>
            )}
            <button
              onClick={() => setShortcutsOpen(true)}
              className="h-8 w-8 inline-flex items-center justify-center border border-slate-200 rounded-md hover:bg-slate-50 text-slate-600"
              title="Keyboard shortcuts (?)"
              aria-label="Keyboard shortcuts"
            >
              <Keyboard size={12} />
            </button>
            <button
              onClick={() => { fetchStock(); fetchSidecar() }}
              className="h-8 px-3 text-base border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5"
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        }
      />

      {/* KPI strip */}
      <KpiStrip kpis={kpis} />

      {/* Insights panel — only renders when there's signal */}
      {insights && (
        <InsightsPanel
          insights={insights}
          collapsed={insightsCollapsed}
          onToggle={() => setInsightsCollapsed((c) => !c)}
          onOpenProduct={setDrawerProductId}
        />
      )}

      {/* Filter bar */}
      <Card>
        <div className="space-y-3">
          {/* Location chips */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm uppercase tracking-wider text-slate-500 font-semibold mr-1">Location</span>
            <button
              onClick={() => updateUrl({ location: undefined, page: undefined })}
              className={`h-7 px-3 text-sm rounded-full font-medium border ${
                !locationCode
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
              }`}
            >All</button>
            {locations.map((loc) => (
              <button
                key={loc.id}
                onClick={() => updateUrl({ location: loc.code, page: undefined })}
                className={`h-7 px-3 text-sm rounded-full font-medium border inline-flex items-center gap-1.5 ${
                  locationCode === loc.code
                    ? 'bg-slate-900 text-white border-slate-900'
                    : `bg-white text-slate-600 border-slate-200 hover:border-slate-300`
                }`}
              >
                {loc.code}
                <span className={`text-xs tabular-nums ${locationCode === loc.code ? 'text-slate-300' : 'text-slate-400'}`}>
                  {loc.totalQuantity}
                </span>
              </button>
            ))}
          </div>

          {/* Search + status chips */}
          <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-slate-100">
            <div className="flex-1 min-w-[240px] max-w-md relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Search SKU, product name, ASIN"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="pl-7"
              />
            </div>
            <span className="text-sm uppercase tracking-wider text-slate-500 font-semibold ml-1">Status</span>
            {STATUS_OPTIONS.map((s) => {
              const active = status === s.value
              const toneActive: Record<string, string> = {
                emerald: 'bg-emerald-50 text-emerald-700 border-emerald-300',
                amber: 'bg-amber-50 text-amber-700 border-amber-300',
                orange: 'bg-orange-50 text-orange-700 border-orange-300',
                rose: 'bg-rose-50 text-rose-700 border-rose-300',
              }
              return (
                <button
                  key={s.value}
                  onClick={() => updateUrl({ status: active ? undefined : s.value, page: undefined })}
                  className={`h-7 px-3 text-sm border rounded-full font-medium ${
                    active ? toneActive[s.tone] : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
                  }`}
                >{s.label}</button>
              )
            })}
            {filterCount > 0 && (
              <button
                onClick={() => updateUrl({ location: undefined, status: undefined, search: undefined, page: undefined })}
                className="h-7 px-2 text-base text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
              >
                <X size={12} /> Clear
              </button>
            )}
            <div className="ml-auto text-base text-slate-500">
              <span className="font-semibold text-slate-700 tabular-nums">{total}</span> rows
            </div>
          </div>
        </div>
      </Card>

      {/* Body — view-switched */}
      {(() => {
        const noResults = view === 'table' ? items.length === 0 : productBundles.length === 0
        if (error) {
          return (
            <Card>
              <div className="text-md text-rose-700 py-8 text-center">
                Failed to load stock: {error}
              </div>
            </Card>
          )
        }
        if (loading && noResults) {
          return <Card><div className="text-md text-slate-500 py-8 text-center">Loading stock…</div></Card>
        }
        if (noResults) {
          return (
            <EmptyState
              icon={Warehouse}
              title="No stock matches these filters"
              description={filterCount > 0 ? 'Try clearing filters.' : 'Stock levels appear once products are imported and seeded.'}
              action={filterCount > 0
                ? { label: 'Clear filters', onClick: () => updateUrl({ location: undefined, status: undefined, search: undefined, page: undefined }) }
                : { label: 'Go to Catalog', href: '/products' }
              }
            />
          )
        }
        if (view === 'matrix') {
          return <MatrixView products={productBundles} locations={locations} onOpenProduct={setDrawerProductId} />
        }
        if (view === 'cards') {
          return <CardsView products={productBundles} locations={locations} onOpenProduct={setDrawerProductId} />
        }
        return (
          <TableView
            items={items}
            onOpenProduct={setDrawerProductId}
            selected={selected}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
            density={density}
            visibleColumns={visibleColumns}
          />
        )
      })()}

      {/* Bulk action bar — appears when selection is non-empty in table view */}
      {view === 'table' && selected.size > 0 && !bulkProgress && (
        <BulkActionBar
          count={selected.size}
          onClear={() => setSelected(new Set())}
          onAdjust={() => setBulkAction('adjust')}
          onThreshold={() => setBulkAction('threshold')}
          onExport={exportSelectedCsv}
        />
      )}

      {/* Progress toast — shown during sequential bulk runs */}
      {bulkProgress && <BulkProgressToast progress={bulkProgress} />}

      {/* Undo toast — 30s window after a successful bulk adjust */}
      {undoBundle && !bulkProgress && (
        <UndoToast
          count={undoBundle.entries.length}
          expiresAt={undoBundle.expiresAt}
          onUndo={runUndo}
          onDismiss={() => setUndoBundle(null)}
        />
      )}

      {/* Bulk modals */}
      {bulkAction === 'adjust' && (
        <BulkAdjustModal
          selectedItems={items.filter((it) => selected.has(it.id))}
          onCancel={() => setBulkAction(null)}
          onConfirm={runBulkAdjust}
        />
      )}
      {bulkAction === 'threshold' && (
        <BulkThresholdModal
          selectedItems={items.filter((it) => selected.has(it.id))}
          onCancel={() => setBulkAction(null)}
          onConfirm={runBulkThreshold}
        />
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-base text-slate-500">
          <span>Page <span className="font-semibold text-slate-700 tabular-nums">{page}</span> of <span className="tabular-nums">{totalPages}</span></span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => updateUrl({ page: page <= 2 ? undefined : String(page - 1) })}
              disabled={page === 1}
              className="h-7 px-3 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >Previous</button>
            <button
              onClick={() => updateUrl({ page: String(Math.min(totalPages, page + 1)) })}
              disabled={page >= totalPages}
              className="h-7 px-3 border border-slate-200 rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >Next</button>
          </div>
        </div>
      )}

      {drawerProductId && (
        <StockDrawer
          productId={drawerProductId}
          onClose={() => setDrawerProductId(null)}
          onChanged={() => { fetchStock(); fetchSidecar() }}
        />
      )}

      {shortcutsOpen && <ShortcutsHelp onClose={() => setShortcutsOpen(false)} />}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// KPI strip
// ─────────────────────────────────────────────────────────────────────
function KpiStrip({ kpis }: { kpis: Kpis | null }) {
  if (!kpis) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <div className="h-[68px] flex items-center justify-center text-base text-slate-400">…</div>
          </Card>
        ))}
      </div>
    )
  }

  const cards = [
    {
      icon: Boxes,
      label: 'Total stock value',
      value: `€${kpis.totalStockValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      detail: `${kpis.totalStockUnits.toLocaleString()} units across ${kpis.activeLocations} location${kpis.activeLocations === 1 ? '' : 's'}`,
      tone: 'bg-emerald-50 text-emerald-600',
    },
    {
      icon: AlertTriangle,
      label: 'Stockouts',
      value: kpis.stockouts.toLocaleString(),
      detail: `${kpis.totalSkus.toLocaleString()} SKUs total`,
      tone: kpis.stockouts > 0 ? 'bg-rose-50 text-rose-600' : 'bg-slate-50 text-slate-600',
    },
    {
      icon: TrendingDown,
      label: 'Critical stock',
      value: kpis.critical.toLocaleString(),
      detail: `+ ${kpis.low.toLocaleString()} below threshold`,
      tone: kpis.critical > 0 ? 'bg-orange-50 text-orange-600' : 'bg-slate-50 text-slate-600',
    },
    {
      icon: Layers,
      label: 'Available units',
      value: kpis.totalAvailable.toLocaleString(),
      detail: `${kpis.totalReserved.toLocaleString()} reserved`,
      tone: 'bg-blue-50 text-blue-600',
    },
  ]

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((c, i) => (
        <Card key={i}>
          <div className="flex items-start gap-3">
            <div className={`w-9 h-9 rounded-md inline-flex items-center justify-center flex-shrink-0 ${c.tone}`}>
              <c.icon size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">{c.label}</div>
              <div className="text-[20px] font-semibold tabular-nums text-slate-900 mt-0.5">{c.value}</div>
              <div className="text-sm text-slate-500 mt-0.5 truncate">{c.detail}</div>
            </div>
          </div>
        </Card>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Insights panel — H.7 smart features
// ─────────────────────────────────────────────────────────────────────
function InsightsPanel({
  insights, collapsed, onToggle, onOpenProduct,
}: {
  insights: Insights
  collapsed: boolean
  onToggle: () => void
  onOpenProduct: (id: string) => void
}) {
  const totalSignal =
    insights.stockoutRisk.length + insights.allocationGaps.length + insights.syncConflicts.length
  if (totalSignal === 0) return null

  return (
    <Card>
      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-2">
          <Lightbulb size={14} className="text-amber-500" />
          <span className="text-md font-semibold text-slate-900">Insights</span>
          <span className="text-sm text-slate-500">
            {insights.stockoutRisk.length > 0 && (
              <span className="inline-flex items-center gap-1 mr-3">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                {insights.stockoutRisk.length} at-risk
              </span>
            )}
            {insights.allocationGaps.length > 0 && (
              <span className="inline-flex items-center gap-1 mr-3">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-500" />
                {insights.allocationGaps.length} allocation gap{insights.allocationGaps.length === 1 ? '' : 's'}
              </span>
            )}
            {insights.syncConflicts.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                {insights.syncConflicts.length} sync diff{insights.syncConflicts.length === 1 ? '' : 's'} (24h)
              </span>
            )}
          </span>
        </div>
        <button
          onClick={onToggle}
          className="h-7 px-2 text-sm text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
        >
          {collapsed ? 'Show' : 'Hide'}
          <ChevronRight
            size={12}
            className={`transition-transform ${collapsed ? '' : 'rotate-90'}`}
          />
        </button>
      </div>

      {!collapsed && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-3 pt-3 border-t border-slate-100">
          {/* Stockout risk */}
          <InsightCategory
            icon={AlertCircle}
            iconTone="text-rose-500"
            title="Stockout risk"
            description="Products at zero or critically low. Reorder before a customer hits a 'unavailable' page."
            cta={{ label: 'Open replenishment', href: '/fulfillment/replenishment' }}
            empty="No SKUs at risk"
          >
            {insights.stockoutRisk.slice(0, 5).map((p) => (
              <button
                key={p.id}
                onClick={() => onOpenProduct(p.id)}
                className="w-full text-left flex items-center gap-2 py-1 px-1.5 -mx-1.5 rounded hover:bg-slate-50"
              >
                {p.thumbnailUrl ? (
                  <img src={p.thumbnailUrl} alt="" className="w-7 h-7 rounded object-cover bg-slate-100 flex-shrink-0" />
                ) : (
                  <div className="w-7 h-7 rounded bg-slate-100 flex items-center justify-center text-slate-400 flex-shrink-0">
                    <Package size={12} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-base font-medium text-slate-900 truncate">{p.name}</div>
                  <div className="text-xs text-slate-500 font-mono truncate">{p.sku}</div>
                </div>
                <div className={`text-base font-semibold tabular-nums ${
                  p.totalStock === 0 ? 'text-rose-600' : 'text-orange-600'
                }`}>
                  {p.totalStock}
                </div>
              </button>
            ))}
            {insights.stockoutRisk.length > 5 && (
              <div className="text-sm text-slate-400 italic pt-1">
                +{insights.stockoutRisk.length - 5} more
              </div>
            )}
          </InsightCategory>

          {/* Allocation gaps */}
          <InsightCategory
            icon={Zap}
            iconTone="text-violet-500"
            title="Allocation gaps"
            description="One location has surplus while another is starving. Transfer rebalances without touching reorder cadence."
            empty="No transfer candidates"
          >
            {insights.allocationGaps.slice(0, 5).map((g) => (
              <button
                key={g.productId}
                onClick={() => onOpenProduct(g.productId)}
                className="w-full text-left flex items-center gap-2 py-1 px-1.5 -mx-1.5 rounded hover:bg-slate-50"
              >
                {g.thumbnailUrl ? (
                  <img src={g.thumbnailUrl} alt="" className="w-7 h-7 rounded object-cover bg-slate-100 flex-shrink-0" />
                ) : (
                  <div className="w-7 h-7 rounded bg-slate-100 flex items-center justify-center text-slate-400 flex-shrink-0">
                    <Package size={12} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-base font-medium text-slate-900 truncate">{g.name}</div>
                  <div className="text-xs text-slate-500 inline-flex items-center gap-1.5">
                    <span className="font-mono">{g.surplusLocation.code}</span>
                    <span className="tabular-nums">{g.surplusLocation.quantity}</span>
                    <ArrowRightLeft size={9} className="text-slate-400" />
                    <span className="font-mono">{g.deficitLocation.code}</span>
                    <span className="tabular-nums">{g.deficitLocation.quantity}</span>
                  </div>
                </div>
                <div className="text-sm font-semibold text-violet-700 inline-flex items-center gap-0.5 flex-shrink-0">
                  +{g.suggestedTransfer}
                  <ChevronRight size={12} className="text-slate-400" />
                </div>
              </button>
            ))}
            {insights.allocationGaps.length > 5 && (
              <div className="text-sm text-slate-400 italic pt-1">
                +{insights.allocationGaps.length - 5} more
              </div>
            )}
          </InsightCategory>

          {/* Sync conflicts */}
          <InsightCategory
            icon={Activity}
            iconTone="text-blue-500"
            title="Sync diffs (24h)"
            description="Amazon FBA cron found a quantity that didn't match Nexus's cached value. Could mean lost/found units, or a delayed inbound."
            empty="No sync conflicts"
          >
            {insights.syncConflicts.slice(0, 5).map((c) => (
              <button
                key={c.id}
                onClick={() => c.productId && onOpenProduct(c.productId)}
                className="w-full text-left flex items-center gap-2 py-1 px-1.5 -mx-1.5 rounded hover:bg-slate-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-base font-medium text-slate-900 truncate">{c.name ?? c.sku ?? 'Unknown'}</div>
                  <div className="text-xs text-slate-500 font-mono truncate">
                    {c.locationCode && <span>{c.locationCode} · </span>}
                    {c.quantityBefore != null ? `${c.quantityBefore}` : '?'}
                    {' → '}
                    {c.balanceAfter}
                  </div>
                </div>
                <div className={`text-sm font-semibold tabular-nums flex-shrink-0 ${
                  c.change > 0 ? 'text-emerald-600' : c.change < 0 ? 'text-rose-600' : 'text-slate-500'
                }`}>
                  {c.change > 0 ? '+' : ''}{c.change}
                </div>
              </button>
            ))}
            {insights.syncConflicts.length > 5 && (
              <div className="text-sm text-slate-400 italic pt-1">
                +{insights.syncConflicts.length - 5} more
              </div>
            )}
          </InsightCategory>
        </div>
      )}
    </Card>
  )
}

function InsightCategory({
  icon: Icon, iconTone, title, description, cta, empty, children,
}: {
  icon: any
  iconTone: string
  title: string
  description: string
  cta?: { label: string; href: string }
  empty: string
  children: React.ReactNode
}) {
  // Detect emptiness — if children is an empty array (no nodes
  // rendered), show the empty placeholder.
  const arr = Array.isArray(children) ? children : [children]
  const isEmpty = arr.flat().filter(Boolean).length === 0

  return (
    <div className="space-y-1.5">
      <div className="inline-flex items-center gap-1.5">
        <Icon size={12} className={iconTone} />
        <span className="text-sm font-semibold uppercase tracking-wider text-slate-700">{title}</span>
      </div>
      <div className="text-xs text-slate-500 leading-snug">{description}</div>
      <div className="space-y-0.5 pt-1">
        {isEmpty ? (
          <div className="text-sm text-slate-400 py-1.5">{empty}</div>
        ) : children}
      </div>
      {cta && !isEmpty && (
        <Link
          href={cta.href}
          className="text-sm text-blue-700 hover:text-blue-900 hover:underline inline-flex items-center gap-0.5 mt-1"
        >
          {cta.label} <ChevronRight size={10} />
        </Link>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// StockDrawer — H.4 multi-location rebuild.
// One bundle fetch (/api/stock/product/:id) drives every section.
// ─────────────────────────────────────────────────────────────────────
type DrawerBundle = {
  product: {
    id: string; sku: string; name: string; amazonAsin: string | null
    totalStock: number; lowStockThreshold: number
    basePrice: number | null; costPrice: number | null
    thumbnailUrl: string | null
  }
  stockLevels: Array<{
    id: string
    location: { id: string; code: string; name: string; type: string; isActive: boolean }
    quantity: number; reserved: number; available: number
    reorderThreshold: number | null
    lastUpdatedAt: string; lastSyncedAt: string | null; syncStatus: string
    activeReservations: number
  }>
  channelListings: Array<{
    id: string; channel: string; marketplace: string
    listingStatus: string; syncStatus: string
    lastSyncedAt: string | null; lastSyncStatus: string | null; lastSyncError: string | null
    quantity: number | null; stockBuffer: number; externalListingId: string | null
  }>
  movements: Movement[]
  salesVelocity: {
    last30Units: number; last30Revenue: number
    avgDailyUnits: number; daysOfStock: number | null
    totalAvailable: number
    dailyHistory: Array<{ day: string; units: number; revenue: number; orders: number }>
  }
  atp: {
    leadTimeDays: number; leadTimeSource: string
    inboundWithinLeadTime: number; totalOpenInbound: number
    openShipments: Array<{ shipmentId: string; type: string; status: string; expectedAt: string | null; remainingUnits: number; reference: string | null }>
  } | null
  reservations: Array<{
    id: string; quantity: number; reason: string; orderId: string | null
    expiresAt: string; createdAt: string
    location: { id: string; code: string }
  }>
}

type ActionMode = null | { kind: 'adjust'; stockLevelId: string; locationCode: string } | { kind: 'transfer' } | { kind: 'reserve' }

function StockDrawer({ productId, onClose, onChanged }: { productId: string; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [bundle, setBundle] = useState<DrawerBundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [action, setAction] = useState<ActionMode>(null)

  const fetchBundle = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/product/${productId}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`drawer load failed: ${res.status}`)
      setBundle(await res.json())
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load drawer')
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => { fetchBundle() }, [fetchBundle])

  const handleActionDone = useCallback(() => {
    setAction(null)
    fetchBundle()
    onChanged()
  }, [fetchBundle, onChanged])

  return (
    <div className="fixed inset-0 z-30 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" />
      <aside
        onClick={(e) => e.stopPropagation()}
        className="relative h-full w-full max-w-2xl bg-white shadow-2xl overflow-y-auto"
      >
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="text-md font-semibold text-slate-900 inline-flex items-center gap-2">
            <Boxes size={14} /> Stock detail
          </div>
          <div className="flex items-center gap-2">
            <button onClick={fetchBundle} className="h-7 px-2 text-sm text-slate-500 hover:text-slate-900 inline-flex items-center gap-1">
              <RefreshCw size={11} /> Refresh
            </button>
            <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="p-5 space-y-5">
          {error && (
            <div className="text-md text-rose-700 py-3 px-3 bg-rose-50 border border-rose-200 rounded">
              {error}
            </div>
          )}

          {loading && !bundle ? (
            <div className="text-md text-slate-500 py-8 text-center">Loading…</div>
          ) : bundle ? (
            <>
              {/* Product header */}
              <div className="flex items-start gap-3">
                {bundle.product.thumbnailUrl ? (
                  <img src={bundle.product.thumbnailUrl} alt="" className="w-14 h-14 rounded object-cover bg-slate-100 flex-shrink-0" />
                ) : (
                  <div className="w-14 h-14 rounded bg-slate-100 flex items-center justify-center text-slate-400 flex-shrink-0">
                    <Package size={20} />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-lg font-semibold text-slate-900">{bundle.product.name}</div>
                  <div className="text-sm text-slate-500 font-mono">
                    {bundle.product.sku}
                    {bundle.product.amazonAsin && <span> · {bundle.product.amazonAsin}</span>}
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-base text-slate-600">
                    <span className="inline-flex items-center gap-1">
                      <Boxes size={11} className="text-slate-400" />
                      <span className="font-semibold tabular-nums">{bundle.product.totalStock}</span> total
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <LockIcon size={11} className="text-slate-400" />
                      <span className="tabular-nums">{bundle.salesVelocity.totalAvailable}</span> available
                    </span>
                  </div>
                </div>
              </div>

              {/* Quick actions */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => setAction({ kind: 'transfer' })}
                  disabled={bundle.stockLevels.length < 1}
                  className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-40"
                ><ArrowRightLeft size={12} /> Transfer</button>
                <button
                  onClick={() => setAction({ kind: 'reserve' })}
                  disabled={bundle.stockLevels.length < 1}
                  className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-40"
                ><LockIcon size={12} /> Reserve</button>
                <Link
                  href={`/products/${productId}/edit`}
                  className="h-8 px-3 text-base bg-white text-slate-700 border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
                ><ExternalLink size={12} /> Open in editor</Link>
              </div>

              {/* Inline action panel */}
              {action?.kind === 'adjust' && (
                <AdjustPanel
                  stockLevelId={action.stockLevelId}
                  locationCode={action.locationCode}
                  onCancel={() => setAction(null)}
                  onDone={handleActionDone}
                />
              )}
              {action?.kind === 'transfer' && (
                <TransferPanel
                  productId={productId}
                  stockLevels={bundle.stockLevels}
                  onCancel={() => setAction(null)}
                  onDone={handleActionDone}
                />
              )}
              {action?.kind === 'reserve' && (
                <ReservePanel
                  productId={productId}
                  stockLevels={bundle.stockLevels}
                  onCancel={() => setAction(null)}
                  onDone={handleActionDone}
                />
              )}

              {/* Multi-location breakdown */}
              <Section title="Stock by location" icon={Warehouse}>
                {bundle.stockLevels.length === 0 ? (
                  <div className="text-base text-slate-400 text-center py-3">No StockLevel rows yet.</div>
                ) : (
                  <ul className="space-y-1.5">
                    {bundle.stockLevels.map((sl) => (
                      <li key={sl.id} className="flex items-center justify-between gap-3 py-2 px-3 border border-slate-200 rounded">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${LOCATION_TONE[sl.location.type] ?? 'bg-slate-50 text-slate-600 border-slate-200'}`}>
                              {sl.location.code}
                            </span>
                            <span className="text-base text-slate-700">{sl.location.name}</span>
                            {sl.activeReservations > 0 && (
                              <span className="text-xs text-violet-700 bg-violet-50 px-1.5 py-0.5 rounded">
                                {sl.activeReservations} active reservation{sl.activeReservations === 1 ? '' : 's'}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-sm text-slate-500 inline-flex items-center gap-3">
                            <span><span className="font-semibold tabular-nums text-slate-700">{sl.quantity}</span> on hand</span>
                            <span><span className="tabular-nums">{sl.reserved}</span> reserved</span>
                            <span><span className="tabular-nums">{sl.available}</span> available</span>
                            <span className="text-slate-400">· {formatRelative(sl.lastUpdatedAt)}</span>
                          </div>
                        </div>
                        <button
                          onClick={() => setAction({ kind: 'adjust', stockLevelId: sl.id, locationCode: sl.location.code })}
                          className="h-7 px-2 text-sm border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1"
                        >
                          <Plus size={11} className="-mr-0.5" /><Minus size={11} /> Adjust
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {/* Channel listing status */}
              {bundle.channelListings.length > 0 && (
                <Section title="Channel listings" icon={Activity}>
                  <ul className="space-y-1">
                    {bundle.channelListings.map((cl) => {
                      const tone =
                        cl.lastSyncStatus === 'FAILED' || cl.syncStatus === 'FAILED' ? 'rose' :
                        cl.syncStatus === 'PENDING' || cl.syncStatus === 'SYNCING' ? 'amber' :
                        cl.listingStatus === 'ACTIVE' ? 'emerald' : 'slate'
                      const toneCls: Record<string, string> = {
                        emerald: 'bg-emerald-50 text-emerald-700',
                        amber: 'bg-amber-50 text-amber-700',
                        rose: 'bg-rose-50 text-rose-700',
                        slate: 'bg-slate-100 text-slate-600',
                      }
                      return (
                        <li key={cl.id} className="flex items-center justify-between gap-3 py-1.5 px-2 -mx-2 border-b border-slate-100 last:border-0">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-slate-700">{cl.channel} · {cl.marketplace}</span>
                              <span className={`text-xs uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${toneCls[tone]}`}>
                                {cl.listingStatus}
                              </span>
                            </div>
                            <div className="text-xs text-slate-400 mt-0.5">
                              {cl.lastSyncedAt ? `Synced ${formatRelative(cl.lastSyncedAt)}` : 'Never synced'}
                              {cl.lastSyncError && <span className="text-rose-600"> · {cl.lastSyncError.slice(0, 60)}</span>}
                            </div>
                          </div>
                          <div className="text-right flex-shrink-0 text-sm text-slate-500 tabular-nums">
                            {cl.quantity == null ? <span className="text-slate-400">follows master</span> : <><span className="font-semibold text-slate-700">{cl.quantity}</span> shown</>}
                            {cl.stockBuffer > 0 && <span className="text-slate-400"> · −{cl.stockBuffer} buffer</span>}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </Section>
              )}

              {/* Sales velocity */}
              <Section
                title="Sales velocity (last 30d)"
                icon={TrendingDown}
                right={
                  bundle.salesVelocity.last30Units > 0 ? (
                    <span className="text-sm text-slate-500">
                      {bundle.salesVelocity.avgDailyUnits.toFixed(2)}/day avg
                    </span>
                  ) : null
                }
              >
                {bundle.salesVelocity.last30Units === 0 ? (
                  <div className="text-base text-slate-400 py-2">No sales in the last 30 days.</div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-4 text-base text-slate-700">
                      <div>
                        <span className="font-semibold tabular-nums">{bundle.salesVelocity.last30Units}</span>
                        <span className="text-slate-500 text-sm"> units</span>
                      </div>
                      <div>
                        <span className="font-semibold tabular-nums">€{bundle.salesVelocity.last30Revenue.toFixed(2)}</span>
                        <span className="text-slate-500 text-sm"> revenue</span>
                      </div>
                      {bundle.salesVelocity.daysOfStock != null && (
                        <div className={bundle.salesVelocity.daysOfStock <= 7 ? 'text-rose-700' : bundle.salesVelocity.daysOfStock <= 21 ? 'text-amber-700' : 'text-slate-700'}>
                          <span className="font-semibold tabular-nums">{bundle.salesVelocity.daysOfStock}</span>
                          <span className="text-sm"> days of stock</span>
                        </div>
                      )}
                    </div>
                    <Sparkline points={bundle.salesVelocity.dailyHistory.slice(-30).map((d) => d.units)} />
                  </div>
                )}
              </Section>

              {/* ATP / reorder */}
              {bundle.atp && (bundle.atp.totalOpenInbound > 0 || bundle.atp.leadTimeSource !== 'FALLBACK') && (
                <Section title="Replenishment" icon={Truck}>
                  <div className="text-base text-slate-700 space-y-1">
                    <div>
                      Lead time:{' '}
                      <span className="font-semibold tabular-nums">{bundle.atp.leadTimeDays} days</span>
                      <span className="text-slate-400 text-sm"> · {bundle.atp.leadTimeSource.toLowerCase().replace(/_/g, ' ')}</span>
                    </div>
                    {bundle.atp.totalOpenInbound > 0 && (
                      <div>
                        Inbound:{' '}
                        <span className="font-semibold tabular-nums">{bundle.atp.totalOpenInbound}</span>
                        <span className="text-slate-500 text-sm"> units</span>
                        {bundle.atp.inboundWithinLeadTime !== bundle.atp.totalOpenInbound && (
                          <span className="text-slate-400 text-sm"> ({bundle.atp.inboundWithinLeadTime} within lead time)</span>
                        )}
                      </div>
                    )}
                    {bundle.atp.openShipments.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {bundle.atp.openShipments.slice(0, 5).map((s) => (
                          <li key={s.shipmentId} className="text-sm text-slate-500 inline-flex items-center gap-2">
                            <span className="font-mono">{s.reference ?? s.shipmentId.slice(0, 8)}</span>
                            <span>·</span>
                            <span>{s.type} {s.status.toLowerCase()}</span>
                            <span>·</span>
                            <span className="tabular-nums">{s.remainingUnits} units</span>
                            {s.expectedAt && <span className="text-slate-400">· ETA {new Date(s.expectedAt).toLocaleDateString()}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </Section>
              )}

              {/* Active reservations */}
              {bundle.reservations.length > 0 && (
                <Section title="Active reservations" icon={LockIcon}>
                  <ul className="space-y-1">
                    {bundle.reservations.map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-2 py-1.5 px-2 -mx-2 border-b border-slate-100 last:border-0">
                        <div className="min-w-0">
                          <div className="text-base text-slate-700">
                            <span className="font-semibold tabular-nums">{r.quantity}</span> at{' '}
                            <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">{r.location.code}</span>
                            <span className="text-slate-400 text-sm"> · {r.reason}</span>
                          </div>
                          <div className="text-xs text-slate-400">
                            {r.orderId && <span>order {r.orderId.slice(0, 8)} · </span>}
                            expires {formatRelative(r.expiresAt)}
                          </div>
                        </div>
                        <button
                          onClick={async () => {
                            if (!(await askConfirm({ title: `Release ${r.quantity} units?`, confirmLabel: 'Release', tone: 'warning' }))) return
                            try {
                              const res = await fetch(`${getBackendUrl()}/api/stock/release/${r.id}`, { method: 'POST' })
                              if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Release failed')
                              handleActionDone()
                            } catch (e: any) { toast.error(e.message) }
                          }}
                          className="h-6 px-2 text-xs text-slate-500 hover:text-slate-900 border border-slate-200 rounded"
                        >Release</button>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {/* Movement history */}
              <Section title={`Movement history (${bundle.movements.length})`} icon={History}>
                {bundle.movements.length === 0 ? (
                  <div className="text-base text-slate-400 text-center py-2">No movements yet.</div>
                ) : (
                  <ul className="space-y-1">
                    {bundle.movements.map((m) => (
                      <li key={m.id} className="flex items-start justify-between gap-3 py-1.5 px-2 -mx-2 border-b border-slate-100 last:border-0">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className={`text-xs uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${REASON_TONE[m.reason] ?? 'bg-slate-100 text-slate-600'}`}>
                              {m.reason.replace(/_/g, ' ')}
                            </span>
                            {m.referenceType && (
                              <span className="text-xs text-slate-400 font-mono">{m.referenceType}</span>
                            )}
                          </div>
                          {m.notes && <div className="text-sm text-slate-600 mt-0.5">{m.notes}</div>}
                          <div className="text-xs text-slate-400 mt-0.5">
                            {new Date(m.createdAt).toLocaleString()} {m.actor && `· ${m.actor}`}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <div className={`text-lg font-semibold tabular-nums ${m.change > 0 ? 'text-emerald-600' : m.change < 0 ? 'text-rose-600' : 'text-slate-500'}`}>
                            {m.change > 0 ? '+' : ''}{m.change}
                          </div>
                          <div className="text-xs text-slate-400 tabular-nums">→ {m.balanceAfter}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </>
          ) : null}
        </div>
      </aside>
    </div>
  )
}

function Section({ title, icon: Icon, right, children }: { title: string; icon: any; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold uppercase tracking-wider text-slate-500 inline-flex items-center gap-1.5">
          <Icon size={11} className="text-slate-400" />
          {title}
        </div>
        {right}
      </div>
      {children}
    </div>
  )
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length === 0) return null
  const max = Math.max(...points, 1)
  return (
    <div className="flex items-end gap-px h-10 mt-1">
      {points.map((v, i) => (
        <div
          key={i}
          className="flex-1 bg-blue-200 rounded-sm min-h-[1px]"
          style={{ height: `${Math.max(2, (v / max) * 100)}%` }}
          title={`${v} units`}
        />
      ))}
    </div>
  )
}

function AdjustPanel({ stockLevelId, locationCode, onCancel, onDone }: { stockLevelId: string; locationCode: string; onCancel: () => void; onDone: () => void }) {
  const { toast } = useToast()
  const [change, setChange] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    const n = Number(change)
    if (!Number.isFinite(n) || n === 0) {
      toast.error('Enter a non-zero number (positive to add, negative to remove)')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/${stockLevelId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ change: n, notes: notes || null }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Adjust failed')
      onDone()
    } catch (e: any) {
      toast.error(e.message)
    } finally { setSubmitting(false) }
  }

  return (
    <div className="border border-slate-300 rounded-md p-3 bg-slate-50">
      <div className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-2 inline-flex items-center gap-1.5">
        Adjust at <span className="text-slate-700">{locationCode}</span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number" value={change} onChange={(e) => setChange(e.target.value)}
          placeholder="±n" autoFocus
          className="h-8 w-24 px-2 text-md border border-slate-200 rounded font-mono tabular-nums"
        />
        <input
          type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="Reason (optional)"
          className="flex-1 h-8 px-2 text-base border border-slate-200 rounded"
        />
        <button onClick={submit} disabled={submitting} className="h-8 px-3 text-base bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50">Apply</button>
        <button onClick={onCancel} className="h-8 px-2 text-base text-slate-500 hover:text-slate-900">Cancel</button>
      </div>
    </div>
  )
}

function TransferPanel({
  productId, stockLevels, onCancel, onDone,
}: { productId: string; stockLevels: DrawerBundle['stockLevels']; onCancel: () => void; onDone: () => void }) {
  const { toast } = useToast()
  const [fromId, setFromId] = useState<string>(stockLevels[0]?.location.id ?? '')
  const [toId, setToId] = useState<string>(stockLevels[1]?.location.id ?? stockLevels[0]?.location.id ?? '')
  const [qty, setQty] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    const n = Number(qty)
    if (!Number.isFinite(n) || n <= 0) { toast.error('Quantity must be > 0'); return }
    if (fromId === toId) { toast.error('From and to locations must differ'); return }
    setSubmitting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, fromLocationId: fromId, toLocationId: toId, quantity: n }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Transfer failed')
      onDone()
    } catch (e: any) {
      toast.error(e.message)
    } finally { setSubmitting(false) }
  }

  return (
    <div className="border border-slate-300 rounded-md p-3 bg-slate-50 space-y-2">
      <div className="text-sm font-semibold uppercase tracking-wider text-slate-500 inline-flex items-center gap-1.5">
        <ArrowRightLeft size={11} /> Transfer between locations
      </div>
      <div className="flex items-center gap-2">
        <select value={fromId} onChange={(e) => setFromId(e.target.value)} className="h-8 flex-1 px-2 text-base border border-slate-200 rounded">
          {stockLevels.map((sl) => (
            <option key={sl.id} value={sl.location.id}>From {sl.location.code} ({sl.available} avail)</option>
          ))}
        </select>
        <ArrowRightLeft size={12} className="text-slate-400" />
        <select value={toId} onChange={(e) => setToId(e.target.value)} className="h-8 flex-1 px-2 text-base border border-slate-200 rounded">
          {stockLevels.map((sl) => (
            <option key={sl.id} value={sl.location.id}>To {sl.location.code}</option>
          ))}
        </select>
        <input
          type="number" value={qty} onChange={(e) => setQty(e.target.value)}
          placeholder="qty"
          className="h-8 w-20 px-2 text-md border border-slate-200 rounded font-mono tabular-nums"
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className="h-8 px-2 text-base text-slate-500 hover:text-slate-900">Cancel</button>
        <button onClick={submit} disabled={submitting} className="h-8 px-3 text-base bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50">Transfer</button>
      </div>
      <div className="text-xs text-slate-500">
        If the target location has no StockLevel row, one is created with the transferred quantity.
      </div>
    </div>
  )
}

function ReservePanel({
  productId, stockLevels, onCancel, onDone,
}: { productId: string; stockLevels: DrawerBundle['stockLevels']; onCancel: () => void; onDone: () => void }) {
  const { toast } = useToast()
  const [locId, setLocId] = useState<string>(stockLevels[0]?.location.id ?? '')
  const [qty, setQty] = useState('')
  const [orderId, setOrderId] = useState('')
  const [reason, setReason] = useState<'PENDING_ORDER' | 'MANUAL_HOLD' | 'PROMOTION'>('MANUAL_HOLD')
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    const n = Number(qty)
    if (!Number.isFinite(n) || n <= 0) { toast.error('Quantity must be > 0'); return }
    setSubmitting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/stock/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, locationId: locId, quantity: n, orderId: orderId || undefined, reason }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Reserve failed')
      onDone()
    } catch (e: any) {
      toast.error(e.message)
    } finally { setSubmitting(false) }
  }

  return (
    <div className="border border-slate-300 rounded-md p-3 bg-slate-50 space-y-2">
      <div className="text-sm font-semibold uppercase tracking-wider text-slate-500 inline-flex items-center gap-1.5">
        <LockIcon size={11} /> Reserve stock
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <select value={locId} onChange={(e) => setLocId(e.target.value)} className="h-8 px-2 text-base border border-slate-200 rounded">
          {stockLevels.map((sl) => (
            <option key={sl.id} value={sl.location.id}>{sl.location.code} ({sl.available} avail)</option>
          ))}
        </select>
        <select value={reason} onChange={(e) => setReason(e.target.value as any)} className="h-8 px-2 text-base border border-slate-200 rounded">
          <option value="MANUAL_HOLD">Manual hold</option>
          <option value="PENDING_ORDER">Pending order</option>
          <option value="PROMOTION">Promotion</option>
        </select>
        <input
          type="number" value={qty} onChange={(e) => setQty(e.target.value)}
          placeholder="quantity"
          className="h-8 px-2 text-md border border-slate-200 rounded font-mono tabular-nums"
        />
        <input
          type="text" value={orderId} onChange={(e) => setOrderId(e.target.value)}
          placeholder="Order ID (optional)"
          className="h-8 px-2 text-base border border-slate-200 rounded"
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className="h-8 px-2 text-base text-slate-500 hover:text-slate-900">Cancel</button>
        <button onClick={submit} disabled={submitting} className="h-8 px-3 text-base bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50">Reserve</button>
      </div>
      <div className="text-xs text-slate-500">
        PENDING_ORDER reservations expire after 24h. Manual holds and promotions never expire automatically.
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// View toggle + view components
// ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────
// Polish (H.9) — density toggle, column picker, shortcuts help
// ─────────────────────────────────────────────────────────────────────
function DensityToggle({ density, onChange }: { density: Density; onChange: (d: Density) => void }) {
  const order: Density[] = ['compact', 'comfortable', 'spacious']
  const next = () => onChange(order[(order.indexOf(density) + 1) % order.length])
  const icon = density === 'compact' ? Minimize2 : density === 'spacious' ? Maximize2 : Sliders
  const Icon = icon
  return (
    <button
      onClick={next}
      className="h-8 w-8 inline-flex items-center justify-center border border-slate-200 rounded-md hover:bg-slate-50 text-slate-600"
      title={`Density: ${density}`}
      aria-label={`Density: ${density}`}
    >
      <Icon size={12} />
    </button>
  )
}

function ColumnPicker({ visible, onChange }: { visible: ColumnKey[]; onChange: (next: ColumnKey[]) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="h-8 px-2.5 text-base inline-flex items-center gap-1.5 border border-slate-200 rounded-md hover:bg-slate-50 text-slate-600"
        title="Show / hide columns"
      >
        <Columns size={12} /> Columns
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-full mt-1 w-56 z-20 bg-white border border-slate-200 rounded-md shadow-lg p-2 text-base"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold px-1.5 pb-1.5">Columns</div>
            {ALL_COLUMNS.map((col) => {
              const checked = visible.includes(col.key)
              return (
                <label
                  key={col.key}
                  className={`flex items-center justify-between gap-2 px-1.5 py-1 rounded cursor-pointer ${col.alwaysOn ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-50'}`}
                >
                  <span className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={col.alwaysOn}
                      onChange={() => {
                        if (col.alwaysOn) return
                        onChange(
                          checked
                            ? visible.filter((k) => k !== col.key)
                            : [...visible, col.key],
                        )
                      }}
                      className="cursor-pointer"
                    />
                    {col.label}
                  </span>
                  {col.alwaysOn && <span className="text-xs text-slate-400">always on</span>}
                </label>
              )
            })}
            <button
              onClick={() => onChange(DEFAULT_VISIBLE_COLUMNS)}
              className="w-full mt-1.5 pt-1.5 border-t border-slate-100 text-sm text-slate-500 hover:text-slate-900 text-left px-1.5 py-1"
            >
              Reset to default
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ['/', 'Focus search'],
    ['1', 'Switch to Table view'],
    ['2', 'Switch to Matrix view'],
    ['3', 'Switch to Cards view'],
    ['r', 'Refresh data'],
    ['?', 'Show this help'],
    ['Esc', 'Close drawer / cancel action / clear selection'],
    ['Shift + Click', 'Range-select rows in table'],
  ]
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <div className="space-y-1">
        {rows.map(([key, desc]) => (
          <div key={key} className="flex items-center justify-between gap-3 py-1 border-b border-slate-100 last:border-0">
            <span className="text-base text-slate-700">{desc}</span>
            <kbd className="px-2 py-0.5 text-sm font-mono bg-slate-100 border border-slate-200 rounded text-slate-700">{key}</kbd>
          </div>
        ))}
      </div>
      <div className="text-sm text-slate-400 mt-3 pt-3 border-t border-slate-100">
        Shortcuts skipped when focus is in an input — type freely without hijacking.
      </div>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Sync engine status indicator (H.8)
// ─────────────────────────────────────────────────────────────────────
function SyncIndicator({ status }: { status: SyncStatus }) {
  const [open, setOpen] = useState(false)

  // Health rollup. Failed > stale > healthy.
  const failed = status.outboundQueue.failed > 0
  const fbaConfiguredButDisabled = status.amazonFbaCron.configured && !status.amazonFbaCron.enabled
  const stalePendingMs = status.outboundQueue.oldestPendingAt
    ? Date.now() - new Date(status.outboundQueue.oldestPendingAt).getTime()
    : 0
  const stale = stalePendingMs > 30 * 60 * 1000 // >30 min queued

  const tone =
    failed ? 'bg-rose-50 text-rose-700 border-rose-200' :
    stale ? 'bg-amber-50 text-amber-700 border-amber-200' :
    fbaConfiguredButDisabled ? 'bg-slate-50 text-slate-500 border-slate-200' :
    'bg-emerald-50 text-emerald-700 border-emerald-200'

  const label =
    failed ? `${status.outboundQueue.failed} failed` :
    stale ? `${status.outboundQueue.pending} pending` :
    fbaConfiguredButDisabled ? 'FBA cron off' :
    'Synced'

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`h-8 px-2.5 text-sm border rounded inline-flex items-center gap-1.5 font-medium ${tone}`}
        title="Sync engine status"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${
          failed ? 'bg-rose-500' :
          stale ? 'bg-amber-500' :
          fbaConfiguredButDisabled ? 'bg-slate-400' :
          'bg-emerald-500 animate-pulse'
        }`} />
        {label}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-80 z-20 bg-white border border-slate-200 rounded-md shadow-lg p-3 text-base space-y-2"
          onClick={(e) => e.stopPropagation()}
        >
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Amazon FBA cron</div>
            <div className="text-slate-700 mt-0.5">
              {status.amazonFbaCron.enabled
                ? <span className="text-emerald-700">Enabled · 15-min cadence</span>
                : status.amazonFbaCron.configured
                  ? <span className="text-amber-700">Configured but disabled</span>
                  : <span className="text-slate-500">Not configured</span>}
            </div>
            {status.amazonFbaCron.lastReconciliationAt && (
              <div className="text-sm text-slate-500 mt-0.5">
                Last reconciliation {formatRelative(status.amazonFbaCron.lastReconciliationAt)}
                {status.amazonFbaCron.lastReconciliationDelta != null && (
                  <span className={status.amazonFbaCron.lastReconciliationDelta > 0 ? ' text-emerald-700' : status.amazonFbaCron.lastReconciliationDelta < 0 ? ' text-rose-700' : ''}>
                    {' '}({status.amazonFbaCron.lastReconciliationDelta > 0 ? '+' : ''}{status.amazonFbaCron.lastReconciliationDelta})
                  </span>
                )}
              </div>
            )}
            <div className="text-sm text-slate-500">
              {status.recentReconciliationCount} reconciliation{status.recentReconciliationCount === 1 ? '' : 's'} in last 24h
            </div>
          </div>
          <div className="border-t border-slate-100 pt-2">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Outbound queue</div>
            <div className="grid grid-cols-3 gap-2 mt-1 text-center">
              <div>
                <div className={`text-lg font-semibold tabular-nums ${status.outboundQueue.pending > 0 ? 'text-amber-700' : 'text-slate-900'}`}>
                  {status.outboundQueue.pending}
                </div>
                <div className="text-xs text-slate-500">pending</div>
              </div>
              <div>
                <div className={`text-lg font-semibold tabular-nums ${status.outboundQueue.failed > 0 ? 'text-rose-700' : 'text-slate-900'}`}>
                  {status.outboundQueue.failed}
                </div>
                <div className="text-xs text-slate-500">failed</div>
              </div>
              <div>
                <div className="text-lg font-semibold tabular-nums text-slate-700">{status.outboundQueue.synced}</div>
                <div className="text-xs text-slate-500">synced</div>
              </div>
            </div>
            {status.outboundQueue.oldestPendingAt && (
              <div className="text-xs text-slate-500 mt-1">
                Oldest pending {formatRelative(status.outboundQueue.oldestPendingAt)}
              </div>
            )}
          </div>
          <div className="border-t border-slate-100 pt-2">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Reservation sweep</div>
            <div className="text-slate-700 mt-0.5">
              {status.reservationSweep.scheduled
                ? <span className="text-emerald-700">Scheduled · 5-min cadence</span>
                : <span className="text-slate-500">Not scheduled</span>}
            </div>
            {status.reservationSweep.lastRunAt && (
              <div className="text-sm text-slate-500 mt-0.5">
                Last run {formatRelative(status.reservationSweep.lastRunAt)}
                {status.reservationSweep.lastReleasedCount > 0 && (
                  <span> · {status.reservationSweep.lastReleasedCount} released</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  const tabs: Array<{ key: ViewMode; label: string; icon: any }> = [
    { key: 'table', label: 'Table', icon: TableIcon },
    { key: 'matrix', label: 'Matrix', icon: Grid },
    { key: 'cards', label: 'Cards', icon: LayoutGrid },
  ]
  return (
    <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`h-7 px-2.5 text-base font-medium inline-flex items-center gap-1.5 rounded transition-colors ${
            view === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <t.icon size={12} />
          {t.label}
        </button>
      ))}
    </div>
  )
}

function TableView({
  items, onOpenProduct, selected, onToggleSelect, onToggleSelectAll,
  density, visibleColumns,
}: {
  items: StockRow[]
  onOpenProduct: (id: string) => void
  selected: Set<string>
  onToggleSelect: (id: string, idx: number, ev: React.MouseEvent) => void
  onToggleSelectAll: () => void
  density: Density
  visibleColumns: ColumnKey[]
}) {
  const allSelected = items.length > 0 && items.every((it) => selected.has(it.id))
  const someSelected = !allSelected && items.some((it) => selected.has(it.id))
  const padY = DENSITY_PADDING[density]
  const visible = (k: ColumnKey) => visibleColumns.includes(k)

  return (
    <Card noPadding>
      <div className="overflow-x-auto">
        <table className="w-full text-md">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th className={`px-3 ${padY} w-10`}>
                <input
                  type="checkbox"
                  aria-label="Select all rows"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected }}
                  onChange={onToggleSelectAll}
                  className="cursor-pointer"
                />
              </th>
              {visible('thumb')     && <th className={`px-3 ${padY} text-left text-sm font-semibold uppercase tracking-wider text-slate-700 w-10`}></th>}
              {visible('product')   && <th className={`px-3 ${padY} text-left text-sm font-semibold uppercase tracking-wider text-slate-700`}>Product</th>}
              {visible('location')  && <th className={`px-3 ${padY} text-left text-sm font-semibold uppercase tracking-wider text-slate-700`}>Location</th>}
              {visible('onHand')    && <th className={`px-3 ${padY} text-right text-sm font-semibold uppercase tracking-wider text-slate-700`}>On hand</th>}
              {visible('reserved')  && <th className={`px-3 ${padY} text-right text-sm font-semibold uppercase tracking-wider text-slate-700`}>Reserved</th>}
              {visible('available') && <th className={`px-3 ${padY} text-right text-sm font-semibold uppercase tracking-wider text-slate-700`}>Available</th>}
              {visible('threshold') && <th className={`px-3 ${padY} text-right text-sm font-semibold uppercase tracking-wider text-slate-700`}>Threshold</th>}
              {visible('cost')      && <th className={`px-3 ${padY} text-right text-sm font-semibold uppercase tracking-wider text-slate-700`}>Cost</th>}
              {visible('updated')   && <th className={`px-3 ${padY} text-right text-sm font-semibold uppercase tracking-wider text-slate-700`}>Updated</th>}
              <th className={`px-3 ${padY} text-right text-sm font-semibold uppercase tracking-wider text-slate-700`}></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => {
              const threshold = it.reorderThreshold ?? it.product.lowStockThreshold
              const stockTone =
                it.quantity === 0 ? 'text-rose-600' :
                it.quantity <= 5 ? 'text-orange-600' :
                it.quantity <= threshold ? 'text-amber-600' : 'text-slate-900'
              const isSelected = selected.has(it.id)
              return (
                <tr
                  key={it.id}
                  onClick={() => onOpenProduct(it.product.id)}
                  className={`border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors ${isSelected ? 'bg-blue-50/40' : ''}`}
                >
                  <td className={`px-3 ${padY}`} onClick={(e) => { e.stopPropagation(); onToggleSelect(it.id, idx, e) }}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${it.product.sku}`}
                      checked={isSelected}
                      readOnly
                      className="cursor-pointer"
                    />
                  </td>
                  {visible('thumb') && (
                    <td className={`px-3 ${padY}`}>
                      {it.product.thumbnailUrl ? (
                        <img src={it.product.thumbnailUrl} alt="" className={`${density === 'compact' ? 'w-6 h-6' : 'w-8 h-8'} rounded object-cover bg-slate-100`} />
                      ) : (
                        <div className={`${density === 'compact' ? 'w-6 h-6' : 'w-8 h-8'} rounded bg-slate-100 flex items-center justify-center text-slate-400`}>
                          <Package size={density === 'compact' ? 12 : 14} />
                        </div>
                      )}
                    </td>
                  )}
                  {visible('product') && (
                    <td className={`px-3 ${padY}`}>
                      <div className="text-md font-medium text-slate-900 truncate max-w-md">{it.product.name}</div>
                      <div className="text-sm text-slate-500 font-mono">
                        {it.product.sku}
                        {it.variation && <span> · {it.variation.sku}</span>}
                        {it.product.amazonAsin && <span> · {it.product.amazonAsin}</span>}
                      </div>
                    </td>
                  )}
                  {visible('location') && (
                    <td className={`px-3 ${padY}`}>
                      <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${
                        LOCATION_TONE[it.location.type] ?? 'bg-slate-50 text-slate-600 border-slate-200'
                      }`} title={it.location.name}>
                        {it.location.code}
                      </span>
                    </td>
                  )}
                  {visible('onHand')    && <td className={`px-3 ${padY} text-right tabular-nums font-semibold ${stockTone}`}>{it.quantity}</td>}
                  {visible('reserved')  && <td className={`px-3 ${padY} text-right tabular-nums text-slate-500`}>{it.reserved}</td>}
                  {visible('available') && <td className={`px-3 ${padY} text-right tabular-nums text-slate-700`}>{it.available}</td>}
                  {visible('threshold') && <td className={`px-3 ${padY} text-right tabular-nums text-slate-500`}>{threshold}</td>}
                  {visible('cost') && (
                    <td className={`px-3 ${padY} text-right tabular-nums text-slate-600`}>
                      {it.product.costPrice != null ? `€${it.product.costPrice.toFixed(2)}` : <span className="text-slate-400">—</span>}
                    </td>
                  )}
                  {visible('updated') && (
                    <td className={`px-3 ${padY} text-right tabular-nums text-slate-400 text-sm`}>
                      {formatRelative(it.lastUpdatedAt)}
                    </td>
                  )}
                  <td className={`px-3 ${padY} text-right`}>
                    <ChevronRight size={14} className="text-slate-400 inline" />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// Color-coded heatmap. Cells show quantity; tone is a function of
// quantity (red=zero, orange=critical, amber=low, blue tint scaled
// by quantity for healthy). Empty cell = no StockLevel row, rendered
// as a grey dash so allocation gaps are visually obvious.
function MatrixView({
  products, locations, onOpenProduct,
}: { products: ProductBundle[]; locations: LocationSummary[]; onOpenProduct: (id: string) => void }) {
  // Compute the max quantity across the visible page for color scaling.
  const maxQty = Math.max(
    1,
    ...products.flatMap((p) => p.stockLevels.map((sl) => sl.quantity)),
  )

  return (
    <Card noPadding>
      <div className="overflow-x-auto">
        <table className="w-full text-md">
          <thead className="border-b border-slate-200 bg-slate-50 sticky top-0">
            <tr>
              <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 sticky left-0 bg-slate-50 z-10 min-w-[280px]">
                Product
              </th>
              {locations.map((loc) => (
                <th
                  key={loc.id}
                  className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700 min-w-[80px]"
                  title={loc.name}
                >
                  {loc.code}
                </th>
              ))}
              <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700">Total</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => {
              const cellByLoc = new Map(p.stockLevels.map((sl) => [sl.locationId, sl]))
              return (
                <tr
                  key={p.id}
                  onClick={() => onOpenProduct(p.id)}
                  className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                >
                  <td className="px-3 py-2 sticky left-0 bg-white hover:bg-slate-50 z-10 min-w-[280px]">
                    <div className="flex items-center gap-2">
                      {p.thumbnailUrl ? (
                        <img src={p.thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover bg-slate-100 flex-shrink-0" />
                      ) : (
                        <div className="w-8 h-8 rounded bg-slate-100 flex items-center justify-center text-slate-400 flex-shrink-0">
                          <Package size={14} />
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="text-md font-medium text-slate-900 truncate max-w-[220px]">{p.name}</div>
                        <div className="text-sm text-slate-500 font-mono">{p.sku}</div>
                      </div>
                    </div>
                  </td>
                  {locations.map((loc) => {
                    const cell = cellByLoc.get(loc.id)
                    if (!cell) {
                      return (
                        <td key={loc.id} className="px-3 py-2 text-right text-slate-300">
                          —
                        </td>
                      )
                    }
                    return (
                      <td key={loc.id} className="px-3 py-2 text-right">
                        <MatrixCell quantity={cell.quantity} reserved={cell.reserved} maxQty={maxQty} threshold={p.lowStockThreshold} />
                      </td>
                    )
                  })}
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">
                    {p.totalStock}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function MatrixCell({ quantity, reserved, maxQty, threshold }: { quantity: number; reserved: number; maxQty: number; threshold: number }) {
  const tone =
    quantity === 0 ? 'bg-rose-100 text-rose-800' :
    quantity <= 5 ? 'bg-orange-100 text-orange-800' :
    quantity <= threshold ? 'bg-amber-100 text-amber-800' :
    // Healthy → blue tint scaled by quantity / maxQty
    quantity > maxQty * 0.66 ? 'bg-blue-200 text-blue-900' :
    quantity > maxQty * 0.33 ? 'bg-blue-100 text-blue-800' :
    'bg-blue-50 text-blue-700'
  return (
    <span
      className={`inline-block min-w-[40px] px-2 py-1 rounded text-center font-semibold tabular-nums ${tone}`}
      title={reserved > 0 ? `${quantity} on hand (${reserved} reserved)` : `${quantity} on hand`}
    >
      {quantity}
      {reserved > 0 && (
        <span className="ml-1 text-xs opacity-60">({quantity - reserved})</span>
      )}
    </span>
  )
}

function CardsView({
  products, locations, onOpenProduct,
}: { products: ProductBundle[]; locations: LocationSummary[]; onOpenProduct: (id: string) => void }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {products.map((p) => {
        const cellByLoc = new Map(p.stockLevels.map((sl) => [sl.locationId, sl]))
        const stockTone =
          p.totalStock === 0 ? 'text-rose-600' :
          p.totalStock <= 5 ? 'text-orange-600' :
          p.totalStock <= p.lowStockThreshold ? 'text-amber-600' : 'text-slate-900'
        return (
          <Card
            key={p.id}
            className="cursor-pointer hover:border-slate-300 transition-colors"
          >
            <button onClick={() => onOpenProduct(p.id)} className="block w-full text-left">
              {p.thumbnailUrl ? (
                <img src={p.thumbnailUrl} alt="" className="w-full aspect-square rounded object-cover bg-slate-100 mb-3" />
              ) : (
                <div className="w-full aspect-square rounded bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
                  <Package size={28} />
                </div>
              )}
              <div className="text-md font-medium text-slate-900 line-clamp-2 min-h-[36px]">{p.name}</div>
              <div className="text-sm text-slate-500 font-mono mt-0.5 truncate">{p.sku}</div>
              <div className={`text-[24px] font-semibold tabular-nums mt-2 ${stockTone}`}>
                {p.totalStock}
                <span className="text-sm text-slate-500 font-normal ml-1.5">total</span>
              </div>
              <div className="mt-2 flex items-center gap-1 flex-wrap">
                {locations.map((loc) => {
                  const cell = cellByLoc.get(loc.id)
                  if (!cell) {
                    return (
                      <span
                        key={loc.id}
                        className="text-xs font-mono uppercase px-1.5 py-0.5 border border-slate-200 rounded bg-slate-50 text-slate-300"
                        title={`No stock at ${loc.code}`}
                      >
                        {loc.code} —
                      </span>
                    )
                  }
                  const tone =
                    cell.quantity === 0 ? 'border-rose-200 bg-rose-50 text-rose-700' :
                    cell.quantity <= 5 ? 'border-orange-200 bg-orange-50 text-orange-700' :
                    cell.quantity <= p.lowStockThreshold ? 'border-amber-200 bg-amber-50 text-amber-700' :
                    'border-emerald-200 bg-emerald-50 text-emerald-700'
                  return (
                    <span
                      key={loc.id}
                      className={`text-xs font-mono uppercase px-1.5 py-0.5 border rounded ${tone}`}
                      title={`${loc.name}: ${cell.quantity} on hand, ${cell.available} available`}
                    >
                      {loc.code} <span className="font-bold">{cell.quantity}</span>
                    </span>
                  )
                })}
              </div>
            </button>
          </Card>
        )
      })}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Bulk operations — action bar, progress, undo, modals
// ─────────────────────────────────────────────────────────────────────
function BulkActionBar({
  count, onClear, onAdjust, onThreshold, onExport,
}: {
  count: number
  onClear: () => void
  onAdjust: () => void
  onThreshold: () => void
  onExport: () => void
}) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-20 bg-slate-900 text-white rounded-lg shadow-2xl px-4 py-2 flex items-center gap-3 text-md">
      <span className="font-semibold tabular-nums">
        {count} <span className="text-slate-300 font-normal">selected</span>
      </span>
      <div className="w-px h-5 bg-slate-700" />
      <button
        onClick={onAdjust}
        className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded hover:bg-slate-800 transition-colors"
      >
        <Plus size={12} /> Adjust
      </button>
      <button
        onClick={onThreshold}
        className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded hover:bg-slate-800 transition-colors"
      >
        <Sliders size={12} /> Threshold
      </button>
      <button
        onClick={onExport}
        className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded hover:bg-slate-800 transition-colors"
      >
        <Download size={12} /> Export CSV
      </button>
      <div className="w-px h-5 bg-slate-700" />
      <button
        onClick={onClear}
        className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-800"
        aria-label="Clear selection"
      >
        <X size={14} />
      </button>
    </div>
  )
}

function BulkProgressToast({ progress }: { progress: { total: number; done: number; failed: number } }) {
  const pct = progress.total === 0 ? 0 : Math.round(((progress.done + progress.failed) / progress.total) * 100)
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 bg-white border border-slate-200 rounded-lg shadow-2xl px-4 py-3 text-base text-slate-700 min-w-[280px]">
      <div className="flex items-center gap-2 mb-1.5">
        <RefreshCw size={12} className="animate-spin text-blue-600" />
        <span className="font-semibold">Processing…</span>
        <span className="ml-auto tabular-nums text-slate-500">
          {progress.done + progress.failed}/{progress.total}
        </span>
      </div>
      <div className="h-1 bg-slate-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      {progress.failed > 0 && (
        <div className="text-sm text-rose-600 mt-1">
          {progress.failed} failed
        </div>
      )}
    </div>
  )
}

function UndoToast({
  count, expiresAt, onUndo, onDismiss,
}: {
  count: number
  expiresAt: number
  onUndo: () => void
  onDismiss: () => void
}) {
  const [secondsLeft, setSecondsLeft] = useState(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)))
  useEffect(() => {
    const id = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)))
    }, 200)
    return () => clearInterval(id)
  }, [expiresAt])

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-20 bg-emerald-600 text-white rounded-lg shadow-2xl px-4 py-2.5 flex items-center gap-3 text-md">
      <CheckCircle2 size={14} />
      <span>Adjusted {count} row{count === 1 ? '' : 's'}</span>
      <button
        onClick={onUndo}
        className="h-7 px-2.5 inline-flex items-center gap-1.5 rounded bg-emerald-700 hover:bg-emerald-800 transition-colors font-semibold"
      >
        <Undo2 size={12} /> Undo ({secondsLeft}s)
      </button>
      <button
        onClick={onDismiss}
        className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-emerald-700"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  )
}

function BulkAdjustModal({
  selectedItems, onCancel, onConfirm,
}: {
  selectedItems: StockRow[]
  onCancel: () => void
  onConfirm: (change: number, notes: string | null) => void
}) {
  const [change, setChange] = useState('')
  const [notes, setNotes] = useState('')
  const n = Number(change)
  const valid = Number.isFinite(n) && n !== 0
  const wouldGoNegative = valid && selectedItems.some((it) => it.quantity + n < 0)

  return (
    <Modal title="Bulk adjust quantity" onClose={onCancel}>
      <div className="space-y-3">
        <div>
          <label className="text-sm uppercase tracking-wider text-slate-500 font-semibold block mb-1">Change (signed)</label>
          <input
            type="number"
            value={change}
            onChange={(e) => setChange(e.target.value)}
            placeholder="±n  (e.g. +5 or -3)"
            autoFocus
            className="w-full h-9 px-2 text-md border border-slate-200 rounded font-mono tabular-nums"
          />
          <div className="text-sm text-slate-500 mt-1">
            Same delta applied to every selected row. Use negative numbers to remove stock.
          </div>
        </div>
        <div>
          <label className="text-sm uppercase tracking-wider text-slate-500 font-semibold block mb-1">Reason (optional)</label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. cycle count adjustment 2026-05-06"
            className="w-full h-9 px-2 text-base border border-slate-200 rounded"
          />
        </div>

        <div className="border border-slate-200 rounded p-2 bg-slate-50/50">
          <div className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
            Affected rows ({selectedItems.length})
          </div>
          <ul className="space-y-0.5 max-h-[160px] overflow-y-auto">
            {selectedItems.slice(0, 50).map((it) => {
              const after = valid ? it.quantity + n : it.quantity
              const negativeBound = after < 0
              return (
                <li key={it.id} className="text-sm flex items-center justify-between gap-2 py-0.5">
                  <span className="truncate">
                    <span className="font-mono text-slate-600">{it.product.sku}</span>
                    <span className="text-slate-400"> · {it.location.code}</span>
                  </span>
                  <span className="tabular-nums flex-shrink-0">
                    <span className="text-slate-500">{it.quantity}</span>
                    {valid && (
                      <>
                        <span className="text-slate-400 mx-1">→</span>
                        <span className={negativeBound ? 'text-rose-600 font-semibold' : 'text-slate-700 font-semibold'}>
                          {after}
                        </span>
                      </>
                    )}
                  </span>
                </li>
              )
            })}
            {selectedItems.length > 50 && (
              <li className="text-sm text-slate-400 italic">+{selectedItems.length - 50} more</li>
            )}
          </ul>
        </div>

        {wouldGoNegative && (
          <div className="text-base text-rose-700 bg-rose-50 border border-rose-200 rounded p-2 inline-flex items-start gap-2">
            <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
            <span>One or more rows would be driven negative. The server will reject those; others will succeed.</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
          <button onClick={onCancel} className="h-8 px-3 text-base text-slate-500 hover:text-slate-900">Cancel</button>
          <button
            onClick={() => valid && onConfirm(n, notes || null)}
            disabled={!valid}
            className="h-8 px-3 text-base bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Check size={12} /> Apply to {selectedItems.length}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function BulkThresholdModal({
  selectedItems, onCancel, onConfirm,
}: {
  selectedItems: StockRow[]
  onCancel: () => void
  onConfirm: (threshold: number | null) => void
}) {
  const [threshold, setThreshold] = useState('')
  const [clearMode, setClearMode] = useState(false)
  const n = Number(threshold)
  const valid = clearMode || (Number.isFinite(n) && n >= 0)

  return (
    <Modal title="Bulk update reorder threshold" onClose={onCancel}>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            value={threshold}
            disabled={clearMode}
            onChange={(e) => setThreshold(e.target.value)}
            placeholder="threshold (≥ 0)"
            autoFocus
            className="flex-1 h-9 px-2 text-md border border-slate-200 rounded font-mono tabular-nums disabled:bg-slate-100 disabled:text-slate-400"
          />
          <label className="text-base text-slate-600 inline-flex items-center gap-1.5">
            <input type="checkbox" checked={clearMode} onChange={(e) => setClearMode(e.target.checked)} />
            Clear (use master)
          </label>
        </div>
        <div className="text-sm text-slate-500">
          The reorder threshold per StockLevel overrides Product.lowStockThreshold for that location only.
          Clearing reverts to the product master.
        </div>
        <div className="text-base text-slate-700 border border-slate-200 rounded p-2 bg-slate-50/50">
          Will update <span className="font-semibold tabular-nums">{selectedItems.length}</span> row{selectedItems.length === 1 ? '' : 's'}.
        </div>
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
          <button onClick={onCancel} className="h-8 px-3 text-base text-slate-500 hover:text-slate-900">Cancel</button>
          <button
            onClick={() => valid && onConfirm(clearMode ? null : Math.floor(n))}
            disabled={!valid}
            className="h-8 px-3 text-base bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Check size={12} /> Apply
          </button>
        </div>
      </div>
    </Modal>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" />
      <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-lg shadow-2xl max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto">
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <div className="text-lg font-semibold text-slate-900">{title}</div>
          <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100">
            <X size={16} />
          </button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────
function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}
