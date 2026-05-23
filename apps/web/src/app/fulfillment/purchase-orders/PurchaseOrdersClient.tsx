'use client'

// PO.3 — /fulfillment/purchase-orders list.
//
// Layout choice (operator-confirmed): density table is the default, an
// expandable card view is preserved behind a toggle. Both lenses share
// the same data, selection, and transition logic.
//
// Grid-lens parity:
//   - DensityToggle (compact / comfortable / spacious)
//   - PreferencesModal — sticky-left + visible-columns + sort
//   - ActionCluster per row (sticky-right column in table view)
//   - Cmd+. opens the focused row's action menu
//
// Helpers + types live in ./_shared/po-lens.tsx — duplicated nowhere.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  Plus,
  Search,
  Settings2,
  ShoppingCart,
  Trash2,
  Upload,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import {
  ActionCluster,
  AutoRefreshSelect,
  DensityToggle as SharedDensityToggle,
  GridToolbar,
  PreferencesModal,
  type Density,
  type PreferencesValue,
} from '@/app/_shared/grid-lens'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { useInboundEvents } from '@/lib/sync/use-inbound-events'
import { usePoEvents } from '@/lib/sync/use-po-events'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'
import {
  ACTIVE_STATUSES,
  STATUS_FILTERS,
  StatusIcon,
  availableTransitions,
  formatCurrency,
  isPoOverdue,
  relativeTime,
  statusVariant,
  type PORow,
  type StatusFilter,
  type WorkflowTransition,
} from './_shared/po-lens'
import { PoLiveSyncChip } from './_shared/PoLiveSyncChip'
import { CreatePoModal } from './_shared/CreatePoModal'
import { SpendSummaryTile } from './_shared/SpendSummaryTile'
import { SupplierScorecardDrawer } from './_shared/SupplierScorecardDrawer'
import {
  AdvancedFiltersButton,
  ActiveFilterPills,
  SavedViewChips,
  advancedFromParams,
  advancedToParams,
  countActiveFilters,
  materializeView,
  type AdvancedFilterState,
  type SavedView,
} from './_shared/AdvancedFilters'
import { CsvImportModal, ExportCsvButton } from './_shared/CsvImportModal'
import { BulkReassignSupplierModal, BulkMergeModal } from './_shared/BulkOpsModals'

// ── Audit-trail panel (still used by the card lens) ────────────────

interface AuditEntry {
  status: string
  at: string
  byUserId: string | null
  reason?: string | null
}

function AuditTrailPanel({ poId }: { poId: string }) {
  const { t } = useTranslations()
  const [trail, setTrail] = useState<AuditEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchTrail = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders/${poId}/audit`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setTrail(data.trail ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [poId])

  useEffect(() => {
    fetchTrail()
  }, [fetchTrail])

  if (loading) {
    return (
      <div className="text-base text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
        <Loader2 className="w-3 h-3 animate-spin" />
        {t('po.audit.loading')}
      </div>
    )
  }
  if (error) {
    return (
      <div className="text-base text-red-700 dark:text-red-300">
        {t('po.audit.unavailable', { error })}
      </div>
    )
  }
  if (!trail || trail.length === 0) {
    return (
      <div className="text-base text-slate-500 dark:text-slate-400">{t('po.audit.empty')}</div>
    )
  }

  return (
    <div className="space-y-1.5">
      {trail.map((entry, idx) => (
        <div
          key={`${entry.status}-${entry.at}-${idx}`}
          className="flex items-center gap-2 text-sm"
        >
          <StatusIcon status={entry.status} className="w-3 h-3" />
          <Badge variant={statusVariant(entry.status)} size="sm">
            {entry.status.replace(/_/g, ' ')}
          </Badge>
          <span
            className="text-slate-500 dark:text-slate-400"
            title={new Date(entry.at).toLocaleString()}
          >
            {relativeTime(entry.at)}
          </span>
          {entry.byUserId && (
            <span className="text-slate-500 dark:text-slate-400">· {entry.byUserId}</span>
          )}
          {entry.reason && (
            <span className="text-slate-500 dark:text-slate-400">· {entry.reason}</span>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Density classes ────────────────────────────────────────────────

const DENSITY_ROW_CLS: Record<Density, string> = {
  compact: 'py-1 text-sm',
  comfortable: 'py-2 text-base',
  spacious: 'py-3 text-base',
}

// ── Column registry ────────────────────────────────────────────────

interface PoColumnSpec {
  key: string
  labelKey: string
  label: string
  width?: number
  locked?: boolean
}

const PO_COLUMNS: ReadonlyArray<PoColumnSpec> = [
  { key: 'select',          labelKey: 'po.col.select',        label: '',                    width: 36,  locked: true },
  { key: 'poNumber',        labelKey: 'po.col.poNumber',      label: 'PO #',                width: 160, locked: true },
  { key: 'status',          labelKey: 'po.col.status',        label: 'Status',              width: 130 },
  { key: 'supplier',        labelKey: 'po.col.supplier',      label: 'Supplier',            width: 200 },
  { key: 'warehouse',       labelKey: 'po.col.warehouse',     label: 'Warehouse',           width: 110 },
  { key: 'total',           labelKey: 'po.col.total',         label: 'Total',               width: 130 },
  { key: 'lines',           labelKey: 'po.col.lines',         label: 'Lines',               width: 130 },
  { key: 'expectedDate',    labelKey: 'po.col.expectedDate',  label: 'Expected',            width: 130 },
  { key: 'confirmedDate',   labelKey: 'po.col.confirmedDate', label: 'Supplier ETA',        width: 150 },
  { key: 'createdAt',       labelKey: 'po.col.createdAt',     label: 'Created',             width: 110 },
  { key: 'updatedAt',       labelKey: 'po.col.updatedAt',     label: 'Updated',             width: 110 },
  { key: 'actions',         labelKey: 'po.col.actions',       label: '',                    width: 120, locked: true },
]

const DEFAULT_VISIBLE = [
  'select',
  'poNumber',
  'status',
  'supplier',
  'warehouse',
  'total',
  'lines',
  'expectedDate',
  'confirmedDate',
  'createdAt',
  'actions',
]

const SORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'createdAt:desc',   label: 'Created (newest)' },
  { value: 'createdAt:asc',    label: 'Created (oldest)' },
  { value: 'expectedDate:asc', label: 'Expected delivery (soonest)' },
  { value: 'expectedDate:desc',label: 'Expected delivery (latest)' },
  { value: 'total:desc',       label: 'Total (highest)' },
  { value: 'total:asc',        label: 'Total (lowest)' },
  { value: 'poNumber:asc',     label: 'PO number (A→Z)' },
  { value: 'poNumber:desc',    label: 'PO number (Z→A)' },
]

function compareRows(a: PORow, b: PORow, sortBy: string, dir: 'asc' | 'desc'): number {
  const sign = dir === 'desc' ? -1 : 1
  switch (sortBy) {
    case 'createdAt':
      return sign * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    case 'updatedAt':
      return sign * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
    case 'expectedDate': {
      const av = a.expectedDeliveryDate ? new Date(a.expectedDeliveryDate).getTime() : Number.POSITIVE_INFINITY
      const bv = b.expectedDeliveryDate ? new Date(b.expectedDeliveryDate).getTime() : Number.POSITIVE_INFINITY
      return sign * (av - bv)
    }
    case 'total':
      return sign * (a.totalCents - b.totalCents)
    case 'poNumber':
      return sign * a.poNumber.localeCompare(b.poNumber)
    default:
      return 0
  }
}

// ── localStorage keys ──────────────────────────────────────────────

const LS = {
  view: 'po.list.view',
  density: 'po.list.density',
  visibleColumns: 'po.list.visibleColumns',
  stickyLeft: 'po.list.stickyLeft',
  stickyRight: 'po.list.stickyRight',
  sort: 'po.list.sort',
  autoRefreshMin: 'po.list.autoRefreshMin',
} as const

type ViewMode = 'table' | 'card'

function readLS<T>(key: string, fallback: T, parse: (v: string) => T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    return raw == null ? fallback : parse(raw)
  } catch {
    return fallback
  }
}

function writeLS(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

// ── Top-level client ───────────────────────────────────────────────

export default function PurchaseOrdersClient() {
  const { t } = useTranslations()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const urlStatus = (searchParams.get('status') ?? 'all') as StatusFilter
  const validStatuses = useMemo(
    () => new Set(STATUS_FILTERS.map((f) => f.key as StatusFilter)),
    [],
  )
  const statusFilter: StatusFilter = validStatuses.has(urlStatus) ? urlStatus : 'all'
  const setStatusFilter = useCallback(
    (next: StatusFilter) => {
      const params = new URLSearchParams(searchParams.toString())
      if (next === 'all') params.delete('status')
      else params.set('status', next)
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname)
    },
    [pathname, router, searchParams],
  )

  // RB.1 — recycle-bin scope via ?deleted=true.
  const showDeleted = searchParams.get('deleted') === 'true'
  const toggleShowDeleted = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString())
    if (showDeleted) params.delete('deleted')
    else params.set('deleted', 'true')
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname)
  }, [pathname, router, searchParams, showDeleted])

  // PO.14 — advanced filters state lives in the URL so links are
  // shareable. The reducer pattern of "write to URL, derive from URL"
  // keeps the source of truth single.
  const advanced: AdvancedFilterState = useMemo(
    () => advancedFromParams(searchParams),
    [searchParams],
  )
  const setAdvanced = useCallback(
    (next: AdvancedFilterState) => {
      const params = new URLSearchParams(searchParams.toString())
      const wire = advancedToParams(next)
      // Clear keys that aren't in wire, write the rest.
      const ALL_KEYS = [
        'supplierIds',
        'warehouseId',
        'currencyCode',
        'expectedFrom',
        'expectedTo',
        'minValueCents',
        'maxValueCents',
        'lateOnly',
      ] as const
      for (const k of ALL_KEYS) {
        const v = wire[k]
        if (v == null) params.delete(k)
        else params.set(k, v)
      }
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname)
    },
    [pathname, router, searchParams],
  )

  // Click a built-in saved view → applies status + advanced atomically.
  const applyView = useCallback(
    (view: SavedView) => {
      const { status, advanced: nextAdv } = materializeView(view)
      const params = new URLSearchParams(searchParams.toString())
      // Status
      if (status) params.set('status', status)
      else params.delete('status')
      // Advanced wire
      const wire = advancedToParams(nextAdv)
      const ALL_KEYS = [
        'supplierIds',
        'warehouseId',
        'currencyCode',
        'expectedFrom',
        'expectedTo',
        'minValueCents',
        'maxValueCents',
        'lateOnly',
      ] as const
      for (const k of ALL_KEYS) {
        const v = wire[k]
        if (v == null) params.delete(k)
        else params.set(k, v)
      }
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname)
    },
    [pathname, router, searchParams],
  )

  // PO.14 — supplier + warehouse caches for the active-pills labels.
  // Loaded lazily; the AdvancedFiltersButton lazy-loads them too but
  // the pills want them earlier (visible before the popover opens).
  const [suppliersCache, setSuppliersCache] = useState<Array<{ id: string; name: string }> | null>(null)
  const [warehousesCache, setWarehousesCache] = useState<Array<{ id: string; code: string; name: string | null }> | null>(null)
  useEffect(() => {
    if (countActiveFilters(advanced) === 0) return
    if (!suppliersCache) {
      fetch(`${getBackendUrl()}/api/fulfillment/suppliers?activeOnly=true`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .then((d) => setSuppliersCache(d.items ?? []))
        .catch(() => setSuppliersCache([]))
    }
    if (!warehousesCache) {
      fetch(`${getBackendUrl()}/api/fulfillment/warehouses`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .then((d) => setWarehousesCache(d.items ?? []))
        .catch(() => setWarehousesCache([]))
    }
  }, [advanced, suppliersCache, warehousesCache])

  const [pos, setPos] = useState<PORow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // PO.18 — palette deep-link: `?create=1` from CommandPalette pops the
  // Create-PO modal on first render. Strip the param after so a URL
  // refresh doesn't re-trigger.
  useEffect(() => {
    if (searchParams.get('create') === '1') {
      setCreateOpen(true)
      const params = new URLSearchParams(searchParams.toString())
      params.delete('create')
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // PO.13 / PO-Plus.4 — scorecard drawer state. Opened from the spend
  // tile's Top Suppliers list, from supplier-name cells in PO rows,
  // and from `?scorecardSupplierId=` deep links (palette / Slack /
  // any shared link). URL is authoritative so back/forward closes
  // the drawer.
  const scorecardSupplierId = searchParams.get('scorecardSupplierId') || null
  const setScorecardSupplierId = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(searchParams.toString())
      if (next) params.set('scorecardSupplierId', next)
      else params.delete('scorecardSupplierId')
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams],
  )
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)

  // ── View / density / preferences state (LS-persisted) ────────────

  const [view, setView] = useState<ViewMode>(() =>
    readLS<ViewMode>(LS.view, 'table', (v) => (v === 'card' ? 'card' : 'table')),
  )
  useEffect(() => writeLS(LS.view, view), [view])

  const [density, setDensity] = useState<Density>(() =>
    readLS<Density>(LS.density, 'comfortable', (v) =>
      v === 'compact' || v === 'spacious' ? v : 'comfortable',
    ),
  )
  useEffect(() => writeLS(LS.density, density), [density])

  const [autoRefreshMin, setAutoRefreshMin] = useState<0 | 5 | 15>(() =>
    readLS<0 | 5 | 15>(LS.autoRefreshMin, 0, (v) => {
      const n = Number(v)
      return n === 5 || n === 15 ? (n as 5 | 15) : 0
    }),
  )
  useEffect(() => writeLS(LS.autoRefreshMin, String(autoRefreshMin)), [autoRefreshMin])

  const [stickyLeft, setStickyLeft] = useState<boolean>(() =>
    readLS<boolean>(LS.stickyLeft, true, (v) => v !== 'false'),
  )
  const [stickyRight, setStickyRight] = useState<boolean>(() =>
    readLS<boolean>(LS.stickyRight, true, (v) => v !== 'false'),
  )
  useEffect(() => writeLS(LS.stickyLeft, String(stickyLeft)), [stickyLeft])
  useEffect(() => writeLS(LS.stickyRight, String(stickyRight)), [stickyRight])

  const [visibleColumns, setVisibleColumns] = useState<string[]>(() =>
    readLS<string[]>(LS.visibleColumns, DEFAULT_VISIBLE, (v) => {
      try {
        const parsed = JSON.parse(v) as string[]
        return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_VISIBLE
      } catch {
        return DEFAULT_VISIBLE
      }
    }),
  )
  useEffect(
    () => writeLS(LS.visibleColumns, JSON.stringify(visibleColumns)),
    [visibleColumns],
  )

  const [sortKey, setSortKey] = useState<{ by: string; dir: 'asc' | 'desc' }>(() =>
    readLS<{ by: string; dir: 'asc' | 'desc' }>(
      LS.sort,
      { by: 'createdAt', dir: 'desc' },
      (v) => {
        try {
          const parsed = JSON.parse(v)
          if (parsed && typeof parsed.by === 'string' && (parsed.dir === 'asc' || parsed.dir === 'desc')) {
            return parsed
          }
          return { by: 'createdAt', dir: 'desc' }
        } catch {
          return { by: 'createdAt', dir: 'desc' }
        }
      },
    ),
  )
  useEffect(() => writeLS(LS.sort, JSON.stringify(sortKey)), [sortKey])

  const [preferencesOpen, setPreferencesOpen] = useState(false)

  // ── Selection + bulk delete ──────────────────────────────────────

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  // PO-Plus.5 — bulk reassign + merge modal state. Mirror selected
  // rows into a snapshot so the modal pre-validates without
  // re-fetching.
  const [bulkReassignOpen, setBulkReassignOpen] = useState(false)
  const [bulkMergeOpen, setBulkMergeOpen] = useState(false)
  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const clearSelection = useCallback(() => setSelected(new Set()), [])

  // ── Fetch ────────────────────────────────────────────────────────

  const fetchPos = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = new URL(`${getBackendUrl()}/api/fulfillment/purchase-orders`)
      if (statusFilter !== 'all' && statusFilter !== 'active') {
        url.searchParams.set('status', statusFilter)
      } else if (statusFilter === 'active') {
        url.searchParams.set('status', Array.from(ACTIVE_STATUSES).join(','))
      }
      if (showDeleted) url.searchParams.set('deleted', 'true')
      // PO.14 — thread advanced filters into the wire.
      const wire = advancedToParams(advanced)
      for (const [k, v] of Object.entries(wire)) {
        if (v != null) url.searchParams.set(k, v)
      }
      const res = await fetch(url.toString(), { cache: 'no-store' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setPos(data.items ?? [])
      setLastFetchedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [statusFilter, showDeleted, advanced])

  useEffect(() => {
    fetchPos()
  }, [fetchPos])

  // PO.4 — PO SSE pipe is now the primary trigger; the inbound pipe
  // still bleeds in for receive-driven status flips so we keep both.
  useInboundEvents()
  const { connected: poStreamConnected, lastEventAt: poStreamLastEventAt } = usePoEvents()
  useInvalidationChannel(
    [
      'inbound.received',
      'inbound.discrepancy',
      'inbound.updated',
      'inbound.created',
      'po.created',
      'po.updated',
      'po.transitioned',
      'po.deleted',
      'po.restored',
      'po.received',
    ],
    useCallback(() => {
      fetchPos()
    }, [fetchPos]),
  )

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    setBulkDeleting(true)
    setActionError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/purchase-orders/bulk-soft-delete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setSelected(new Set())
      setConfirmBulkDelete(false)
      await fetchPos()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBulkDeleting(false)
    }
  }, [selected, fetchPos])

  // PO.16 — bulk transition state + handler. The summary modal renders
  // the per-id result so the operator sees what succeeded vs got
  // skipped (e.g. "approve" on a PO that's already APPROVED).
  const [bulkTxBusy, setBulkTxBusy] = useState<WorkflowTransition | null>(null)
  const [bulkTxResult, setBulkTxResult] = useState<{
    transition: string
    succeeded: Array<{ poId: string; poNumber: string; fromStatus: string; toStatus: string; ackUrl?: string }>
    skipped: Array<{ poId: string; reason: string }>
    failed: Array<{ poId: string; error: string }>
    total: number
  } | null>(null)

  const handleBulkTransition = useCallback(
    async (transition: WorkflowTransition) => {
      const ids = Array.from(selected)
      if (ids.length === 0) return
      setBulkTxBusy(transition)
      setActionError(null)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/fulfillment/purchase-orders/bulk-transition`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, transition }),
          },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error ?? `HTTP ${res.status}`)
        }
        const data = await res.json()
        setBulkTxResult(data)
        setSelected(new Set())
        await fetchPos()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      } finally {
        setBulkTxBusy(null)
      }
    },
    [selected, fetchPos],
  )

  const handleTransition = useCallback(
    async (poId: string, transition: WorkflowTransition, reason?: string) => {
      setActionError(null)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/fulfillment/purchase-orders/${poId}/transition`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transition, reason }),
          },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        await fetchPos()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    },
    [fetchPos],
  )

  // ── Filtered + sorted list ───────────────────────────────────────

  const counts = useMemo(() => {
    const c: Record<string, number> = { active: 0 }
    if (pos) {
      for (const p of pos) {
        c[p.status] = (c[p.status] ?? 0) + 1
        if (ACTIVE_STATUSES.has(p.status)) c.active++
      }
    }
    return c
  }, [pos])

  const filteredPos = useMemo(() => {
    if (!pos) return null
    const q = search.trim().toLowerCase()
    const filtered = !q
      ? pos
      : pos.filter((p) => {
          if (p.poNumber.toLowerCase().includes(q)) return true
          if (p.supplier?.name?.toLowerCase().includes(q)) return true
          if (p.items.some((it) => it.sku.toLowerCase().includes(q))) return true
          return false
        })
    return [...filtered].sort((a, b) => compareRows(a, b, sortKey.by, sortKey.dir))
  }, [pos, search, sortKey])

  // Preferences modal commit handler — atomic update of every field.
  const preferencesValue: PreferencesValue = useMemo(
    () => ({
      pageSize: 200, // fixed; server-capped at 200
      visibleColumns,
      stickyFirstColumn: stickyLeft,
      stickyLastColumn: stickyRight,
      sortBy: sortKey.by,
      sortDir: sortKey.dir,
    }),
    [visibleColumns, stickyLeft, stickyRight, sortKey],
  )

  const onPreferencesConfirm = useCallback(
    (next: PreferencesValue) => {
      setVisibleColumns(next.visibleColumns)
      setStickyLeft(next.stickyFirstColumn)
      setStickyRight(next.stickyLastColumn)
      setSortKey({ by: next.sortBy, dir: next.sortDir })
      setPreferencesOpen(false)
    },
    [],
  )

  return (
    <div className="space-y-3">
      {/* PO.13 — Spend summary tile above the toolbar. Click-to-drill
          tiles + aging strip + top suppliers (opens scorecard drawer). */}
      <SpendSummaryTile
        onPickSupplier={(id) => setScorecardSupplierId(id)}
      />

      {/* Toolbar — search, filters, density, view, prefs, auto-refresh */}
      <GridToolbar
        searchSlot={
          <div className="relative">
            <Search
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('po.search.placeholder')}
              className="h-8 pl-7 pr-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 w-56"
            />
          </div>
        }
        quickFilterSlot={
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1 flex-wrap">
              {STATUS_FILTERS.map((f) => {
                const count = f.key === 'all' ? pos?.length ?? 0 : counts[f.key] ?? 0
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setStatusFilter(f.key)}
                    className={cn(
                      'px-3 py-1 text-sm font-medium rounded border transition-colors',
                      statusFilter === f.key
                        ? 'bg-slate-900 dark:bg-slate-100 text-white border-slate-900'
                        : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
                    )}
                  >
                    {t(f.labelKey as any)}
                    {pos && count > 0 && <span className="ml-1 opacity-70">{count}</span>}
                  </button>
                )
              })}
            </div>
            {/* PO.14 — saved view chips as a separator-divided group
                next to the status chips. Click to apply a preset
                (Late / Awaiting approval / This week / Drafts /
                Received) — atomic write to URL state. */}
            <div className="h-5 w-px bg-slate-200 dark:bg-slate-700" />
            <SavedViewChips onApply={applyView} />
            <AdvancedFiltersButton value={advanced} onChange={setAdvanced} />
          </div>
        }
        density={
          /* PO.3 — view-mode toggle + density toggle live in the
             toolbar's density slot. View toggle first (table default),
             then density (only when in table view). */
          <div className="inline-flex items-center gap-2">
            <ViewToggle value={view} onChange={setView} />
            {view === 'table' && (
              <SharedDensityToggle density={density} onChange={setDensity} />
            )}
            <button
              type="button"
              onClick={() => setPreferencesOpen(true)}
              className="h-8 px-2 inline-flex items-center gap-1 text-sm border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
              title="Preferences"
              aria-label="Preferences"
            >
              <Settings2 className="w-3.5 h-3.5" />
            </button>
          </div>
        }
        autoRefresh={
          <AutoRefreshSelect
            value={autoRefreshMin}
            onChange={setAutoRefreshMin}
            onTick={fetchPos}
          />
        }
        freshness={
          <div className="inline-flex items-center gap-2">
            <PoLiveSyncChip
              connected={poStreamConnected}
              lastEventAt={poStreamLastEventAt}
            />
            <FreshnessIndicator
              lastFetchedAt={lastFetchedAt}
              onRefresh={fetchPos}
              loading={loading}
            />
          </div>
        }
        trailingSlot={
          <div className="inline-flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="w-3.5 h-3.5" />
              {t('po.newPo')}
            </Button>
            {/* PO.15 — CSV round-trip. Export honors the active filter
                query so a "share this filtered view" URL becomes a
                "download this filtered view" by swapping path. Import
                opens a modal with paste/upload + preview + confirm. */}
            <ExportCsvButton filterQuery={searchParams.toString()} />
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded-md inline-flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-800"
              title="Import POs from CSV"
            >
              <Upload className="w-3 h-3" />
              Import CSV
            </button>
            <button
              type="button"
              onClick={toggleShowDeleted}
              title={
                showDeleted
                  ? t('purchaseOrders.recycleBin.exit')
                  : t('purchaseOrders.recycleBin.enter')
              }
              aria-pressed={showDeleted}
              aria-label={
                showDeleted
                  ? t('purchaseOrders.recycleBin.exit')
                  : t('purchaseOrders.recycleBin.label')
              }
              className={cn(
                'h-8 px-3 text-base border rounded-md inline-flex items-center gap-1.5 transition-colors',
                showDeleted
                  ? 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800 dark:hover:bg-rose-900/40'
                  : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800',
              )}
            >
              {showDeleted ? <ArrowLeft className="w-3 h-3" /> : <Trash2 className="w-3 h-3" />}
              {showDeleted
                ? t('purchaseOrders.recycleBin.exit')
                : t('purchaseOrders.recycleBin.label')}
            </button>
          </div>
        }
      />

      {/* Error toasts */}
      {error && (
        <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {t('po.failedToLoad', { error })}
        </div>
      )}
      {actionError && (
        <div className="text-md text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {actionError}
        </div>
      )}

      {/* PO.14 — Active-filter pills strip. Click X on any pill to
          clear that specific filter. Auto-hides when no advanced
          filters are active. */}
      {countActiveFilters(advanced) > 0 && (
        <ActiveFilterPills
          state={advanced}
          suppliers={suppliersCache}
          warehouses={warehousesCache}
          onClear={(key) => {
            const next: AdvancedFilterState = { ...advanced }
            switch (key) {
              case 'supplierIds':
                next.supplierIds = []
                break
              case 'warehouseId':
                next.warehouseId = null
                break
              case 'currencyCode':
                next.currencyCode = null
                break
              case 'expectedFrom':
                next.expectedFrom = null
                next.expectedTo = null
                break
              case 'minValueCents':
                next.minValueCents = null
                next.maxValueCents = null
                break
              case 'lateOnly':
                next.lateOnly = false
                break
            }
            setAdvanced(next)
          }}
        />
      )}

      {/* Loading skeleton */}
      {loading && !pos && (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-16 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {pos && pos.length === 0 && !loading && (
        <EmptyState
          icon={ShoppingCart}
          title={
            statusFilter === 'all' ? t('po.empty.title') : t('po.empty.titleFiltered')
          }
          description={
            statusFilter === 'all'
              ? t('po.empty.description')
              : t('po.empty.descriptionFiltered')
          }
          action={
            statusFilter === 'all'
              ? {
                  label: t('po.empty.openReplenishment'),
                  href: '/fulfillment/replenishment',
                }
              : undefined
          }
        />
      )}

      {pos && pos.length > 0 && filteredPos && filteredPos.length === 0 && (
        <div className="text-md text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded p-6 text-center">
          {t('po.search.noMatches', { q: search })}
        </div>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="sticky top-0 z-20 -mx-2 px-3 py-2 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-lg flex items-center gap-3 shadow-sm">
          <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
            {selected.size} selected
          </span>
          <div className="flex-1" />
          {confirmBulkDelete ? (
            <>
              <span className="text-xs text-slate-600 dark:text-slate-400">
                Delete {selected.size} purchase order{selected.size === 1 ? '' : 's'}?
              </span>
              <button
                type="button"
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
                className="h-7 px-3 text-xs rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {bulkDeleting && <Loader2 size={12} className="animate-spin" />}
                Yes, delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmBulkDelete(false)}
                disabled={bulkDeleting}
                className="h-7 px-3 text-xs rounded border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              {/* PO.16 — bulk transitions. Each action runs against
                  every selected PO and skips rows where the
                  transition doesn't apply (e.g. "approve" on a
                  SUBMITTED PO). Skipped/failed counts surface in
                  the summary modal. */}
              <button
                type="button"
                onClick={() => handleBulkTransition('approve')}
                disabled={bulkTxBusy !== null}
                className="h-7 px-3 text-xs rounded border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 disabled:opacity-50"
                title="Approve all selected DRAFT/REVIEW POs"
              >
                {bulkTxBusy === 'approve' ? <Loader2 size={12} className="animate-spin" /> : null}
                Approve
              </button>
              <button
                type="button"
                onClick={() => handleBulkTransition('send')}
                disabled={bulkTxBusy !== null}
                className="h-7 px-3 text-xs rounded border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 disabled:opacity-50"
                title="Send all selected APPROVED POs to their suppliers"
              >
                {bulkTxBusy === 'send' ? <Loader2 size={12} className="animate-spin" /> : null}
                Send to supplier
              </button>
              <a
                href={`${getBackendUrl()}/api/fulfillment/purchase-orders/export.csv?ids=${Array.from(selected).join(',')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="h-7 px-3 text-xs rounded border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
                title="Download a CSV of just the selected rows"
              >
                Export selected
              </a>
              {/* PO-Plus.5 — bulk re-assign + merge. Modals do their
                  own constraint checks (DRAFT/REVIEW for reassign;
                  DRAFT + same supplier/currency/warehouse for merge),
                  so the buttons stay live and the modal explains why
                  if the selection isn't eligible. */}
              <button
                type="button"
                onClick={() => setBulkReassignOpen(true)}
                disabled={bulkTxBusy !== null}
                className="h-7 px-3 text-xs rounded border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 disabled:opacity-50"
                title="Re-assign supplier on selected DRAFT/REVIEW POs"
              >
                Re-assign
              </button>
              <button
                type="button"
                onClick={() => setBulkMergeOpen(true)}
                disabled={bulkTxBusy !== null || selected.size < 2}
                className="h-7 px-3 text-xs rounded border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 disabled:opacity-50"
                title={selected.size < 2 ? 'Select ≥2 POs to merge' : 'Merge selected POs into one DRAFT'}
              >
                Merge
              </button>
              <button
                type="button"
                onClick={() => setConfirmBulkDelete(true)}
                disabled={bulkTxBusy !== null}
                className="h-7 px-3 text-xs rounded border border-red-200 dark:border-red-900 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <Trash2 size={12} /> Delete
              </button>
              <button
                type="button"
                onClick={clearSelection}
                disabled={bulkTxBusy !== null}
                className="h-7 px-3 text-xs rounded border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}

      {/* PO.16 — bulk transition result summary. Renders after a
          bulk action completes; click to dismiss. */}
      {bulkTxResult && (
        <BulkTransitionSummary
          result={bulkTxResult}
          onClose={() => setBulkTxResult(null)}
        />
      )}

      {/* List body — table or cards */}
      {filteredPos && filteredPos.length > 0 && (
        view === 'table' ? (
          <PoTable
            rows={filteredPos}
            density={density}
            visibleColumns={visibleColumns}
            stickyLeft={stickyLeft}
            stickyRight={stickyRight}
            sortKey={sortKey}
            onSort={(by) =>
              setSortKey((prev) =>
                prev.by === by
                  ? { by, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
                  : { by, dir: 'desc' },
              )
            }
            selected={selected}
            onToggleSelect={toggleSelected}
            onTransition={handleTransition}
            onPickSupplier={setScorecardSupplierId}
            router={router}
          />
        ) : (
          <div className="space-y-2">
            {filteredPos.map((po) => (
              <PoCard
                key={po.id}
                po={po}
                onTransition={handleTransition}
                isSelected={selected.has(po.id)}
                onToggleSelect={toggleSelected}
                onPickSupplier={setScorecardSupplierId}
              />
            ))}
          </div>
        )
      )}

      {/* Preferences modal */}
      <PreferencesModal
        open={preferencesOpen}
        onClose={() => setPreferencesOpen(false)}
        value={preferencesValue}
        onConfirm={onPreferencesConfirm}
        allColumns={PO_COLUMNS}
        defaultVisible={DEFAULT_VISIBLE}
        sortFieldOptions={SORT_OPTIONS.map((o) => {
          const [by, dir] = o.value.split(':')
          return { value: by, label: o.label, dir }
        }).reduce<Array<{ value: string; label: string }>>((acc, x) => {
          // Modal expects { value, label } pairs — collapse asc/desc to a
          // single "field" entry; direction is implied by the label.
          if (!acc.find((y) => y.value === x.value)) {
            acc.push({ value: x.value, label: x.label.replace(/\s*\(.*\)$/, '') })
          }
          return acc
        }, [])}
        pageSizeChoices={[]}
        title={t('po.preferences.title')}
      />

      {createOpen && (
        <CreatePoModal
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false)
            await fetchPos()
          }}
        />
      )}

      {/* PO.15 — CSV import modal. Bulk-create POs from a pasted or
          uploaded CSV file. */}
      {importOpen && (
        <CsvImportModal
          onClose={() => setImportOpen(false)}
          onImported={fetchPos}
        />
      )}

      {/* PO-Plus.5 — bulk reassign + merge modals. Each takes the
          current selection snapshot so it can pre-validate without
          a network round-trip on cancel. */}
      {bulkReassignOpen && (
        <BulkReassignSupplierModal
          selectedRows={(filteredPos ?? []).filter((p) => selected.has(p.id))}
          onClose={() => setBulkReassignOpen(false)}
          onDone={async () => {
            setSelected(new Set())
            await fetchPos()
          }}
        />
      )}
      {bulkMergeOpen && (
        <BulkMergeModal
          selectedRows={(filteredPos ?? []).filter((p) => selected.has(p.id))}
          onClose={() => setBulkMergeOpen(false)}
          onDone={async () => {
            setSelected(new Set())
            await fetchPos()
          }}
        />
      )}

      {/* PO.13 — supplier scorecard drawer. Opened from the spend
          tile's top-suppliers list. */}
      {scorecardSupplierId && (
        <SupplierScorecardDrawer
          supplierId={scorecardSupplierId}
          onClose={() => setScorecardSupplierId(null)}
        />
      )}
    </div>
  )
}

// ── Bulk-transition result summary ─────────────────────────────────

function BulkTransitionSummary({
  result,
  onClose,
}: {
  result: {
    transition: string
    succeeded: Array<{ poId: string; poNumber: string; fromStatus: string; toStatus: string; ackUrl?: string }>
    skipped: Array<{ poId: string; reason: string }>
    failed: Array<{ poId: string; error: string }>
    total: number
  }
  onClose: () => void
}) {
  const hasAckUrls = result.succeeded.some((r) => r.ackUrl)
  const titleByTransition: Record<string, string> = {
    'submit-for-review': 'Bulk submit-for-review',
    approve: 'Bulk approve',
    send: 'Bulk send to supplier',
    acknowledge: 'Bulk acknowledge',
    cancel: 'Bulk cancel',
  }
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-sm">
      <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
          {titleByTransition[result.transition] ?? `Bulk ${result.transition}`}
        </span>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {result.succeeded.length} of {result.total} succeeded
          {result.skipped.length > 0 && ` · ${result.skipped.length} skipped`}
          {result.failed.length > 0 && ` · ${result.failed.length} failed`}
        </span>
      </div>
      <div className="p-3 space-y-3 max-h-72 overflow-y-auto text-base">
        {result.succeeded.length > 0 && (
          <div>
            <div className="text-sm font-semibold text-green-700 dark:text-green-300 mb-1 inline-flex items-center gap-1">
              <Check className="w-3 h-3" />
              Succeeded
            </div>
            <ul className="space-y-0.5 ml-4 list-disc text-slate-700 dark:text-slate-300">
              {result.succeeded.map((r) => (
                <li key={r.poId} className="font-mono">
                  {r.poNumber}{' '}
                  <span className="text-slate-500 dark:text-slate-400 font-sans">
                    {r.fromStatus} → {r.toStatus}
                  </span>
                  {r.ackUrl && (
                    <a
                      href={r.ackUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-2 text-sm text-blue-600 dark:text-blue-400 hover:underline font-sans"
                    >
                      ack URL
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {result.skipped.length > 0 && (
          <div>
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Skipped (not applicable)
            </div>
            <ul className="space-y-0.5 ml-4 list-disc text-slate-700 dark:text-slate-300">
              {result.skipped.map((s) => (
                <li key={s.poId}>
                  <span className="font-mono text-sm">{s.poId.slice(0, 10)}</span>
                  <span className="text-slate-500 dark:text-slate-400"> — {s.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {result.failed.length > 0 && (
          <div>
            <div className="text-sm font-semibold text-red-700 dark:text-red-300 mb-1 inline-flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              Failed
            </div>
            <ul className="space-y-0.5 ml-4 list-disc text-red-700 dark:text-red-300">
              {result.failed.map((f) => (
                <li key={f.poId}>
                  <span className="font-mono text-sm">{f.poId.slice(0, 10)}</span>
                  <span> — {f.error}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {hasAckUrls && (
          <div className="text-sm text-slate-500 dark:text-slate-400">
            Ack URLs above let you share the supplier-confirmation link
            out-of-band if email delivery hasn't arrived yet.
          </div>
        )}
      </div>
      <div className="border-t border-slate-200 dark:border-slate-700 px-3 py-2 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="h-7 px-3 text-xs rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}

// ── View toggle ────────────────────────────────────────────────────

function ViewToggle({
  value,
  onChange,
}: {
  value: ViewMode
  onChange: (v: ViewMode) => void
}) {
  return (
    <div
      className="inline-flex items-center border border-slate-200 dark:border-slate-700 rounded-md overflow-hidden h-8 text-sm"
      role="group"
      aria-label="View mode"
    >
      <button
        type="button"
        onClick={() => onChange('table')}
        title="Table view"
        aria-pressed={value === 'table'}
        className={cn(
          'px-3 h-full inline-flex items-center',
          value === 'table'
            ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
            : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800',
        )}
      >
        Table
      </button>
      <button
        type="button"
        onClick={() => onChange('card')}
        title="Card view"
        aria-pressed={value === 'card'}
        className={cn(
          'px-3 h-full inline-flex items-center border-l border-slate-200 dark:border-slate-700',
          value === 'card'
            ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
            : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800',
        )}
      >
        Cards
      </button>
    </div>
  )
}

// ── Table lens ─────────────────────────────────────────────────────

function PoTable({
  rows,
  density,
  visibleColumns,
  stickyLeft,
  stickyRight,
  sortKey,
  onSort,
  selected,
  onToggleSelect,
  onTransition,
  onPickSupplier,
  router,
}: {
  rows: PORow[]
  density: Density
  visibleColumns: string[]
  stickyLeft: boolean
  stickyRight: boolean
  sortKey: { by: string; dir: 'asc' | 'desc' }
  onSort: (by: string) => void
  selected: Set<string>
  onToggleSelect: (id: string) => void
  onTransition: (poId: string, transition: WorkflowTransition, reason?: string) => Promise<void>
  onPickSupplier: (id: string) => void
  router: ReturnType<typeof useRouter>
}) {
  const cols = useMemo(
    () => PO_COLUMNS.filter((c) => visibleColumns.includes(c.key) || c.locked),
    [visibleColumns],
  )

  // Sticky left = poNumber column. Sticky right = actions column.
  // We compute offsets dynamically — the select column is always sticky
  // left:0 when stickyLeft is on (otherwise it scrolls with the rest).
  const sortableKeys: ReadonlySet<string> = new Set([
    'poNumber',
    'total',
    'expectedDate',
    'createdAt',
    'updatedAt',
  ])

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg overflow-x-auto">
      <table className="w-full border-collapse">
        <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
          <tr>
            {cols.map((c) => {
              const sortable = sortableKeys.has(c.key)
              const stickyStyle: CSSProperties = {}
              const stickyCls: string[] = []
              if (stickyLeft && c.key === 'select') {
                stickyCls.push('sticky left-0 z-10 bg-slate-50 dark:bg-slate-800')
                stickyStyle.left = 0
              } else if (stickyLeft && c.key === 'poNumber') {
                stickyCls.push('sticky z-10 bg-slate-50 dark:bg-slate-800')
                stickyStyle.left = 36 // width of the select column
              } else if (stickyRight && c.key === 'actions') {
                stickyCls.push('sticky right-0 z-10 bg-slate-50 dark:bg-slate-800')
                stickyStyle.right = 0
              }
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={cn(
                    'text-left font-medium px-3 py-2 whitespace-nowrap',
                    c.key === 'total' || c.key === 'lines' || c.key === 'select'
                      ? 'text-right'
                      : '',
                    ...stickyCls,
                  )}
                  style={{ ...stickyStyle, width: c.width, minWidth: c.width }}
                >
                  {c.key === 'select' ? (
                    <span className="sr-only">Select</span>
                  ) : sortable ? (
                    <button
                      type="button"
                      onClick={() => onSort(c.key)}
                      className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-100"
                    >
                      {c.label}
                      {sortKey.by === c.key && (
                        <span className="text-slate-400 dark:text-slate-500">
                          {sortKey.dir === 'asc' ? '↑' : '↓'}
                        </span>
                      )}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((po) => (
            <PoTableRow
              key={po.id}
              po={po}
              cols={cols}
              density={density}
              stickyLeft={stickyLeft}
              stickyRight={stickyRight}
              isSelected={selected.has(po.id)}
              onToggleSelect={() => onToggleSelect(po.id)}
              onRowClick={() => router.push(`/fulfillment/purchase-orders/${po.id}`)}
              onTransition={onTransition}
              onPickSupplier={onPickSupplier}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PoTableRow({
  po,
  cols,
  density,
  stickyLeft,
  stickyRight,
  isSelected,
  onToggleSelect,
  onRowClick,
  onTransition,
  onPickSupplier,
}: {
  po: PORow
  cols: ReadonlyArray<PoColumnSpec>
  density: Density
  stickyLeft: boolean
  stickyRight: boolean
  isSelected: boolean
  onToggleSelect: () => void
  onRowClick: () => void
  onTransition: (poId: string, transition: WorkflowTransition, reason?: string) => Promise<void>
  onPickSupplier: (id: string) => void
}) {
  const overdue = isPoOverdue(po.expectedDeliveryDate, po.status)
  const totalUnits = po.items.reduce((s, i) => s + i.quantityOrdered, 0)
  const totalReceived = po.items.reduce((s, i) => s + i.quantityReceived, 0)
  const transitions = availableTransitions(po.status)

  const inlineActions = transitions
    .filter((tr) => !tr.destructive)
    .slice(0, 1)
    .map((tr) => ({
      id: tr.key,
      icon: tr.icon,
      label: tr.labelKey, // already a translation key consumers can resolve later
      onClick: () => onTransition(po.id, tr.key),
    }))

  const dropdownItems = [
    {
      id: 'open',
      label: 'Open detail',
      icon: ChevronRight,
      href: `/fulfillment/purchase-orders/${po.id}`,
    },
    ...transitions
      .filter((tr) => tr.destructive)
      .map((tr) => ({
        id: tr.key,
        label: tr.labelKey === 'po.transition.cancel' ? 'Cancel PO' : tr.labelKey,
        icon: tr.icon,
        destructive: true,
        confirm: {
          question: 'Cancel this PO?',
          confirmLabel: 'Cancel PO',
        },
        onClick: () => onTransition(po.id, tr.key, 'cancelled from row action'),
      })),
  ]

  const rowCls = cn(
    'border-b border-slate-100 dark:border-slate-800 transition-colors group cursor-pointer',
    isSelected
      ? 'bg-blue-50/40 dark:bg-blue-950/20'
      : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
  )

  return (
    <tr className={rowCls} onClick={onRowClick}>
      {cols.map((c) => {
        const stickyStyle: CSSProperties = {}
        const stickyCls: string[] = []
        const cellBg = isSelected
          ? 'bg-blue-50/40 dark:bg-blue-950/20'
          : 'bg-white dark:bg-slate-900 group-hover:bg-slate-50 dark:group-hover:bg-slate-800/50'
        if (stickyLeft && c.key === 'select') {
          stickyCls.push('sticky left-0 z-[5]', cellBg)
          stickyStyle.left = 0
        } else if (stickyLeft && c.key === 'poNumber') {
          stickyCls.push('sticky z-[5]', cellBg)
          stickyStyle.left = 36
        } else if (stickyRight && c.key === 'actions') {
          stickyCls.push('sticky right-0 z-[5]', cellBg)
          stickyStyle.right = 0
        }
        const baseCls = cn(
          'px-3 align-middle whitespace-nowrap',
          DENSITY_ROW_CLS[density],
          ...stickyCls,
        )
        return (
          <td key={c.key} className={baseCls} style={stickyStyle}>
            <PoTableCell
              col={c.key}
              po={po}
              isSelected={isSelected}
              onToggleSelect={onToggleSelect}
              overdue={overdue}
              totalUnits={totalUnits}
              totalReceived={totalReceived}
              inlineActions={inlineActions}
              dropdownItems={dropdownItems}
              onPickSupplier={onPickSupplier}
            />
          </td>
        )
      })}
    </tr>
  )
}

function PoTableCell({
  col,
  po,
  isSelected,
  onToggleSelect,
  overdue,
  totalUnits,
  totalReceived,
  inlineActions,
  dropdownItems,
  onPickSupplier,
}: {
  col: string
  po: PORow
  isSelected: boolean
  onToggleSelect: () => void
  overdue: boolean
  totalUnits: number
  totalReceived: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inlineActions: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dropdownItems: any[]
  onPickSupplier: (id: string) => void
}) {
  switch (col) {
    case 'select':
      return (
        <span
          role="checkbox"
          aria-checked={isSelected}
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelect()
          }}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              onToggleSelect()
            }
          }}
          className={cn(
            'w-4 h-4 rounded border-2 inline-flex items-center justify-center cursor-pointer transition-colors',
            isSelected
              ? 'bg-blue-600 border-blue-600 text-white'
              : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 hover:border-slate-400',
          )}
          aria-label={isSelected ? 'Deselect' : 'Select'}
        >
          {isSelected && <Check className="w-3 h-3" strokeWidth={3} />}
        </span>
      )
    case 'poNumber':
      return (
        <span className="inline-flex items-center gap-2 font-mono font-medium text-slate-900 dark:text-slate-100">
          <StatusIcon status={po.status} />
          {po.poNumber}
        </span>
      )
    case 'status':
      return (
        <Badge variant={statusVariant(po.status)} size="sm">
          {po.status.replace(/_/g, ' ')}
        </Badge>
      )
    case 'supplier':
      return po.supplier ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onPickSupplier(po.supplier!.id)
          }}
          className="text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:underline text-left"
          title={`View ${po.supplier.name} scorecard`}
        >
          {po.supplier.name}
        </button>
      ) : (
        <span className="text-amber-700 dark:text-amber-300">No supplier</span>
      )
    case 'warehouse':
      return po.warehouse?.code ? (
        <span className="text-slate-700 dark:text-slate-300 font-mono text-sm">
          {po.warehouse.code}
        </span>
      ) : (
        <span className="text-slate-400 dark:text-slate-500">—</span>
      )
    case 'total':
      return (
        <span className="tabular-nums font-medium text-slate-900 dark:text-slate-100 block text-right">
          {formatCurrency(po.totalCents, po.currencyCode)}
        </span>
      )
    case 'lines':
      return (
        <span className="tabular-nums text-slate-700 dark:text-slate-300 block text-right">
          {po.items.length}
          <span className="text-slate-400 dark:text-slate-500 ml-1">
            / {totalReceived}/{totalUnits} u
          </span>
        </span>
      )
    case 'expectedDate':
      return po.expectedDeliveryDate ? (
        <span
          className={cn(
            'tabular-nums',
            overdue ? 'text-red-700 dark:text-red-300 font-medium' : 'text-slate-700 dark:text-slate-300',
          )}
          title={overdue ? 'Overdue' : undefined}
        >
          {new Date(po.expectedDeliveryDate).toISOString().slice(0, 10)}
        </span>
      ) : (
        <span className="text-slate-400 dark:text-slate-500">—</span>
      )
    case 'confirmedDate':
      return po.supplierConfirmedDeliveryDate ? (
        <span className="tabular-nums text-green-700 dark:text-green-300 inline-flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3" />
          {new Date(po.supplierConfirmedDeliveryDate).toISOString().slice(0, 10)}
        </span>
      ) : po.status === 'SUBMITTED' || po.status === 'APPROVED' ? (
        <span className="text-amber-700 dark:text-amber-300 text-sm">Awaiting</span>
      ) : (
        <span className="text-slate-400 dark:text-slate-500">—</span>
      )
    case 'createdAt':
      return (
        <span
          className="text-slate-500 dark:text-slate-400"
          title={new Date(po.createdAt).toLocaleString()}
        >
          {relativeTime(po.createdAt)}
        </span>
      )
    case 'updatedAt':
      return (
        <span
          className="text-slate-500 dark:text-slate-400"
          title={new Date(po.updatedAt).toLocaleString()}
        >
          {relativeTime(po.updatedAt)}
        </span>
      )
    case 'actions':
      return (
        <span onClick={(e) => e.stopPropagation()}>
          <ActionCluster
            rowId={po.id}
            inlineActions={inlineActions}
            dropdownItems={dropdownItems}
            variant="cluster"
          />
        </span>
      )
    default:
      return null
  }
}

// ── Card lens (preserved verbatim from pre-PO.3 behavior) ──────────

function PoCard({
  po,
  onTransition,
  isSelected,
  onToggleSelect,
  onPickSupplier,
}: {
  po: PORow
  onTransition: (poId: string, transition: WorkflowTransition, reason?: string) => Promise<void>
  isSelected?: boolean
  onToggleSelect?: (id: string) => void
  onPickSupplier?: (id: string) => void
}) {
  const { t } = useTranslations()
  const [expanded, setExpanded] = useState(false)
  const [transitioning, setTransitioning] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

  const transitions = availableTransitions(po.status)
  const itemCount = po.items.length
  const totalUnits = po.items.reduce((s, i) => s + i.quantityOrdered, 0)

  const handleTransition = async (transitionKey: WorkflowTransition, requireReason = false) => {
    if (requireReason && !cancelReason.trim()) {
      setShowCancelConfirm(true)
      return
    }
    setTransitioning(transitionKey)
    try {
      await onTransition(po.id, transitionKey, cancelReason.trim() || undefined)
      setShowCancelConfirm(false)
      setCancelReason('')
    } finally {
      setTransitioning(null)
    }
  }

  return (
    <div
      className={cn(
        'bg-white dark:bg-slate-900 border rounded-lg overflow-hidden transition-colors',
        isSelected
          ? 'border-blue-400 dark:border-blue-500 bg-blue-50/30 dark:bg-blue-950/20'
          : 'border-slate-200 dark:border-slate-700',
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-5 py-3 flex items-center gap-4 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors text-left"
      >
        {onToggleSelect ? (
          <span
            role="checkbox"
            aria-checked={!!isSelected}
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onToggleSelect(po.id)
            }}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                onToggleSelect(po.id)
              }
            }}
            className={cn(
              'w-4 h-4 rounded border-2 flex-shrink-0 inline-flex items-center justify-center cursor-pointer transition-colors',
              isSelected
                ? 'bg-blue-600 border-blue-600 text-white'
                : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 hover:border-slate-400',
            )}
            aria-label={isSelected ? 'Deselect purchase order' : 'Select purchase order'}
          >
            {isSelected && <Check className="w-3 h-3" strokeWidth={3} />}
          </span>
        ) : (
          <div className="w-4 h-4 flex-shrink-0" />
        )}
        <div className="flex-shrink-0">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-slate-400 dark:text-slate-500" />
          ) : (
            <ChevronRight className="w-4 h-4 text-slate-400 dark:text-slate-500" />
          )}
        </div>
        <StatusIcon status={po.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-mono font-medium text-slate-900 dark:text-slate-100 text-md">
              {po.poNumber}
            </h3>
            <Badge variant={statusVariant(po.status)} size="sm">
              {po.status.replace(/_/g, ' ')}
            </Badge>
            {po.supplier ? (
              onPickSupplier ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onPickSupplier(po.supplier!.id)
                  }}
                  className="text-base text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:underline text-left"
                  title={`View ${po.supplier.name} scorecard`}
                >
                  {po.supplier.name}
                </button>
              ) : (
                <span className="text-base text-slate-700 dark:text-slate-300">
                  {po.supplier.name}
                </span>
              )
            ) : (
              <span className="text-base text-amber-700 dark:text-amber-300">
                {t('po.noSupplier')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-sm text-slate-500 dark:text-slate-400 flex-wrap">
            <span className="font-medium tabular-nums">
              {formatCurrency(po.totalCents, po.currencyCode)}
            </span>
            <span>
              {t(itemCount === 1 ? 'po.summary.line' : 'po.summary.lines', {
                count: itemCount,
                units: totalUnits,
              })}
            </span>
            <span title={new Date(po.createdAt).toLocaleString()}>
              · {relativeTime(po.createdAt)}
            </span>
            {po.warehouse?.code && <span>· {po.warehouse.code}</span>}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="bg-slate-50 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700 px-5 py-4 space-y-4">
          {transitions.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              {transitions.map((tr) => {
                const requireReason = tr.key === 'cancel'
                const Icon = tr.icon
                if (showCancelConfirm && tr.key === 'cancel') {
                  return null
                }
                return (
                  <button
                    key={tr.key}
                    type="button"
                    onClick={() => handleTransition(tr.key, requireReason)}
                    disabled={transitioning !== null}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-3 py-1.5 text-base font-medium rounded border transition-colors disabled:opacity-50',
                      tr.variant === 'primary' &&
                        'bg-slate-900 dark:bg-slate-100 text-white border-slate-900 hover:bg-slate-800',
                      tr.variant === 'secondary' &&
                        'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800',
                      tr.variant === 'danger' &&
                        'bg-white dark:bg-slate-900 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900 hover:bg-red-50 dark:hover:bg-red-950/40',
                    )}
                  >
                    <Icon
                      className={cn(
                        'w-3.5 h-3.5',
                        transitioning === tr.key && 'animate-spin',
                      )}
                    />
                    {transitioning === tr.key ? t('po.working') : t(tr.labelKey as any)}
                  </button>
                )
              })}
            </div>
          )}
          {showCancelConfirm && (
            <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded p-3 space-y-2">
              <div className="text-base text-red-900 dark:text-red-100 font-medium">
                {t('po.cancel.title')}
              </div>
              <input
                type="text"
                placeholder={t('po.cancel.reasonPlaceholder')}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="w-full px-2 py-1 text-base border border-red-200 dark:border-red-900 rounded bg-white dark:bg-slate-900 focus:outline-none focus:ring-1 focus:ring-red-300"
                autoFocus
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleTransition('cancel', true)}
                  disabled={!cancelReason.trim() || transitioning !== null}
                  className="px-3 py-1 text-base font-medium text-white bg-red-600 dark:bg-red-700 border border-red-600 dark:border-red-500 rounded hover:bg-red-700 dark:hover:bg-red-600 disabled:opacity-50"
                >
                  {t('po.cancel.confirm')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowCancelConfirm(false)
                    setCancelReason('')
                  }}
                  className="px-3 py-1 text-base font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  {t('po.cancel.keep')}
                </button>
              </div>
            </div>
          )}

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded overflow-hidden">
            <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
              {t('po.lineItems')}
            </div>
            <table className="w-full text-base">
              <thead className="bg-slate-50 dark:bg-slate-800 text-sm text-slate-600 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
                <tr>
                  <th className="text-left font-medium px-3 py-1.5">{t('po.col.sku')}</th>
                  <th className="text-right font-medium px-3 py-1.5">{t('po.col.ordered')}</th>
                  <th className="text-right font-medium px-3 py-1.5">{t('po.col.received')}</th>
                  <th className="text-right font-medium px-3 py-1.5">{t('po.col.unitCost')}</th>
                  <th className="text-right font-medium px-3 py-1.5">{t('po.col.subtotal')}</th>
                </tr>
              </thead>
              <tbody>
                {po.items.map((it) => (
                  <tr
                    key={it.id}
                    className="border-b border-slate-100 dark:border-slate-800 last:border-0"
                  >
                    <td className="px-3 py-1.5 font-mono text-sm">{it.sku}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{it.quantityOrdered}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      <span
                        className={cn(
                          it.quantityReceived === 0
                            ? 'text-slate-400 dark:text-slate-500'
                            : it.quantityReceived < it.quantityOrdered
                              ? 'text-amber-700 dark:text-amber-300'
                              : 'text-green-700 dark:text-green-300',
                        )}
                      >
                        {it.quantityReceived}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {formatCurrency(it.unitCostCents, po.currencyCode)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-medium">
                      {formatCurrency(it.unitCostCents * it.quantityOrdered, po.currencyCode)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded p-3">
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide mb-2">
              {t('po.auditTrail')}
            </div>
            <AuditTrailPanel poId={po.id} />
          </div>

          <div className="flex items-center gap-2 text-sm">
            <Link
              href={`/fulfillment/purchase-orders/${po.id}`}
              className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
            >
              <ChevronRight className="w-3 h-3" />
              {t('po.openDetail')}
            </Link>
            <a
              href={`${getBackendUrl()}/api/fulfillment/purchase-orders/${po.id}/factory.pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
            >
              <FileText className="w-3 h-3" />
              {t('po.factoryPdf')}
            </a>
            {po.supplier && po.supplierId && (
              <a
                href={`/products?supplierId=${po.supplierId}`}
                className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
              >
                <ShoppingCart className="w-3 h-3" />
                {t('po.supplierProducts')}
              </a>
            )}
            {po.notes && (
              <span className="text-slate-500 dark:text-slate-400 italic truncate flex-1">
                · {po.notes}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// PO.5 — Smart Create-PO flow lives in its own module. See
// _shared/CreatePoModal.tsx for the supplier-aware draft builder
// with product autocomplete, MOQ/case-pack enforcement, currency
// picker + FX preview, and lead-time-driven expected-date default.
