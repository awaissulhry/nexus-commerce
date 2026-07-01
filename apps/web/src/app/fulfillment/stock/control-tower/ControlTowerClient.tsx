'use client'

/**
 * Phase 6 T3 — Sync Control Tower read-only grid.
 *
 * Displays one row per SKU with:
 *   - worstStatus at row level
 *   - negativeAvailable warning marker
 *   - per-channel×marketplace status chips with qty + lastSyncedAt
 *
 * Status colour mapping:
 *   DEAD / FAILED  → red    (destructive)
 *   CLAMPED        → amber  (warning)
 *   PENDING        → blue   (info)
 *   IN_SYNC        → green  (success)
 *   UNKNOWN        → gray   (neutral)
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Eye,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  XCircle,
} from 'lucide-react'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import {
  AutoRefreshSelect,
  DensityToggle,
  GridToolbar,
  type AutoRefreshInterval,
  type Density,
} from '@/app/_shared/grid-lens'
import { Button } from '@/components/ui/Button'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { DeltaPreviewModal, type DeltaPreviewTarget } from './DeltaPreviewModal'
import ControlTowerBanner from './ControlTowerBanner'

// ── Types ──────────────────────────────────────────────────────────────────

type SyncStatus = 'DEAD' | 'FAILED' | 'CLAMPED' | 'PENDING' | 'IN_SYNC' | 'UNKNOWN'

interface ChannelEntry {
  channelListingId: string
  channel: string
  marketplace: string | null
  status: SyncStatus
  lastSyncedAt: string | null
  quantity: number | null
  offerActive: boolean
}

interface ControlTowerRow {
  sku: string
  productId: string
  negativeAvailable: boolean
  channels: ChannelEntry[]
  worstStatus: SyncStatus
  /** True when this row represents a parent product (has child variations). */
  isParent?: boolean
  /** Non-null when this row is a child variation; value is the parent's productId. */
  parentId?: string | null
  /** The parent product's SKU — populated on child rows for display. */
  parentSku?: string | null
}

interface ApiResponse {
  rows: ControlTowerRow[]
  total: number
  summary: Record<string, number>
  page: number
  pageSize: number
}

// ── Status chip colour mapping ─────────────────────────────────────────────

const STATUS_CLASSES: Record<SyncStatus, string> = {
  DEAD:    'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  FAILED:  'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  CLAMPED: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
  PENDING: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800',
  IN_SYNC: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  UNKNOWN: 'bg-slate-100 text-slate-500 border-default dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
}

function getStatusIcon(status: SyncStatus, cls: string) {
  switch (status) {
    case 'DEAD':
    case 'FAILED':
      return <XCircle className={cls} />
    case 'CLAMPED':
      return <AlertTriangle className={cls} />
    case 'PENDING':
      return <Clock className={cls} />
    case 'IN_SYNC':
      return <CheckCircle2 className={cls} />
    default:
      return <ShieldAlert className={cls} />
  }
}

function StatusChip({ status, size = 'sm' }: { status: SyncStatus; size?: 'sm' | 'xs' }) {
  const sizeClass = size === 'sm'
    ? 'px-1.5 py-0.5 text-[10px]'
    : 'px-1 py-0 text-[9px]'
  const iconClass = size === 'sm' ? 'w-2.5 h-2.5' : 'w-2 h-2'
  return (
    <span className={cn(
      'inline-flex items-center gap-0.5 border rounded font-semibold',
      sizeClass,
      STATUS_CLASSES[status],
    )}>
      {getStatusIcon(status, iconClass)}
      {status.replace(/_/g, ' ')}
    </span>
  )
}

// ── Channel colour mapping ─────────────────────────────────────────────────

const CHANNEL_COLORS: Record<string, string> = {
  AMAZON:  'text-orange-700 bg-orange-50 border-orange-200 dark:text-orange-300 dark:bg-orange-950/40 dark:border-orange-800',
  EBAY:    'text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-950/40 dark:border-blue-800',
  SHOPIFY: 'text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-800',
}

// ── Summary stat specs ─────────────────────────────────────────────────────

const SUMMARY_SPECS = [
  {
    key: 'DEAD' as SyncStatus,
    label: 'Dead',
    cardClass: 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/20',
    iconClass: 'text-red-600 dark:text-red-400',
  },
  {
    key: 'FAILED' as SyncStatus,
    label: 'Failed',
    cardClass: 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/20',
    iconClass: 'text-red-600 dark:text-red-400',
  },
  {
    key: 'CLAMPED' as SyncStatus,
    label: 'Clamped',
    cardClass: 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20',
    iconClass: 'text-amber-600 dark:text-amber-400',
  },
  {
    key: 'PENDING' as SyncStatus,
    label: 'Pending',
    cardClass: 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/20',
    iconClass: 'text-blue-600 dark:text-blue-400',
  },
  {
    key: 'IN_SYNC' as SyncStatus,
    label: 'In Sync',
    cardClass: 'border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/20',
    iconClass: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    key: 'UNKNOWN' as SyncStatus,
    label: 'Unknown',
    cardClass: 'border-default bg-white dark:border-slate-700 dark:bg-slate-900',
    iconClass: 'text-tertiary',
  },
] as const

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtRelative(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

// ── Status precedence rank (lower = worse) ─────────────────────────────────

const STATUS_RANK: Record<SyncStatus, number> = {
  DEAD: 0, FAILED: 1, CLAMPED: 2, PENDING: 3, IN_SYNC: 4, UNKNOWN: 5,
}

function worstOfStatuses(statuses: SyncStatus[]): SyncStatus {
  if (!statuses.length) return 'UNKNOWN'
  return statuses.reduce<SyncStatus>(
    (w, s) => (STATUS_RANK[s] < STATUS_RANK[w] ? s : w),
    'UNKNOWN',
  )
}

// ── Client-side grouping ───────────────────────────────────────────────────
//
// NOTE: The endpoint paginates rows (PAGE_SIZE=50). A parent and its children
// can theoretically span page boundaries — in that case a partial group header
// is shown for the rows present on the current page. Acceptable for now.

interface RowGroup {
  key: string                        // parentId (children) or productId (parent rows)
  label: string                      // parentSku or own sku
  parentRow: ControlTowerRow | null  // the parent's own listing row, if present on this page
  childRows: ControlTowerRow[]       // child variation rows on this page
}

type TopLevelItem =
  | { type: 'group'; group: RowGroup }
  | { type: 'standalone'; row: ControlTowerRow }

function buildGroups(rows: ControlTowerRow[]): TopLevelItem[] {
  const groupMap = new Map<string, RowGroup>()
  const seenGroups = new Set<string>()
  const items: TopLevelItem[] = []

  // First pass: populate the group map so every group has all its members
  for (const row of rows) {
    if (row.isParent) {
      const existing = groupMap.get(row.productId)
      if (existing) {
        existing.parentRow = row
        existing.label = row.sku
      } else {
        groupMap.set(row.productId, {
          key: row.productId,
          label: row.sku,
          parentRow: row,
          childRows: [],
        })
      }
    } else if (row.parentId) {
      const existing = groupMap.get(row.parentId)
      if (existing) {
        existing.childRows.push(row)
      } else {
        groupMap.set(row.parentId, {
          key: row.parentId,
          label: row.parentSku ?? row.parentId,
          parentRow: null,
          childRows: [row],
        })
      }
    }
  }

  // Second pass: emit top-level items preserving the original row order
  for (const row of rows) {
    if (row.isParent) {
      if (!seenGroups.has(row.productId)) {
        seenGroups.add(row.productId)
        items.push({ type: 'group', group: groupMap.get(row.productId)! })
      }
    } else if (row.parentId) {
      if (!seenGroups.has(row.parentId)) {
        seenGroups.add(row.parentId)
        items.push({ type: 'group', group: groupMap.get(row.parentId)! })
      }
    } else {
      items.push({ type: 'standalone', row })
    }
  }

  return items
}

/** Compute the worst status per channel across all rows in the group. */
function groupChannelRollup(group: RowGroup): Map<string, SyncStatus> {
  const allRows = ([group.parentRow, ...group.childRows]).filter((r): r is ControlTowerRow => r !== null)
  const byChannel = new Map<string, SyncStatus[]>()
  for (const row of allRows) {
    for (const ch of row.channels) {
      const arr = byChannel.get(ch.channel) ?? []
      arr.push(ch.status)
      byChannel.set(ch.channel, arr)
    }
  }
  const result = new Map<string, SyncStatus>()
  for (const [ch, statuses] of byChannel) {
    result.set(ch, worstOfStatuses(statuses))
  }
  return result
}

// ── Row pad ────────────────────────────────────────────────────────────────

const ROW_PAD: Record<Density, string> = {
  compact:     'px-2 py-1',
  comfortable: 'px-3 py-2',
  spacious:    'px-4 py-3',
}

const ALL_STATUSES: SyncStatus[] = ['DEAD', 'FAILED', 'CLAMPED', 'PENDING', 'IN_SYNC', 'UNKNOWN']
const CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY'] as const
const STORAGE_KEY = 'inventory-control-tower'
const PAGE_SIZE = 50

// ── DataRow — shared row renderer (standalone + group members) ────────────

interface DataRowProps {
  row: ControlTowerRow
  cellPad: string
  indent?: boolean
  setDeltaTarget: (t: DeltaPreviewTarget) => void
  resyncCell: (id: string, label: string) => void
  suppressCell: (
    productId: string,
    channel: string,
    marketplace: string | null,
    channelListingId: string,
    newOfferActive: boolean,
  ) => void
  resyncingCell: string | null
  suppressingCell: string | null
}

function DataRow({
  row,
  cellPad,
  indent = false,
  setDeltaTarget,
  resyncCell,
  suppressCell,
  resyncingCell,
  suppressingCell,
}: DataRowProps) {
  return (
    <tr
      className={cn(
        'transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50',
        (row.worstStatus === 'DEAD' || row.worstStatus === 'FAILED') && 'bg-red-50/30 dark:bg-red-950/10',
        row.worstStatus === 'CLAMPED' && 'bg-amber-50/30 dark:bg-amber-950/10',
        indent && 'border-l-2 border-l-slate-200 dark:border-l-slate-700',
      )}
    >
      {/* SKU + negative-available warning */}
      <td className={cn(cellPad, indent && 'pl-8')}>
        <div className="font-mono text-xs font-semibold text-slate-800 dark:text-slate-200">
          {row.sku}
        </div>
        {row.negativeAvailable && (
          <div className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] text-red-600 dark:text-red-400">
            <AlertTriangle className="w-2.5 h-2.5" />
            Negative qty
          </div>
        )}
      </td>

      {/* Worst status at row level */}
      <td className={cellPad}>
        <StatusChip status={row.worstStatus} />
      </td>

      {/* Per-channel×marketplace chips */}
      <td className={cellPad}>
        <div className="flex flex-wrap gap-1.5">
          {row.channels.map((ch) => (
            <div
              key={`${ch.channel}-${ch.marketplace}`}
              className={cn(
                'inline-flex flex-col gap-0.5 border rounded-md px-2 py-1 min-w-[92px]',
                ch.offerActive
                  ? 'border-default dark:border-slate-700'
                  : 'border-amber-300 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-950/20 opacity-70',
              )}
            >
              {/* Channel badge + marketplace + delta preview */}
              <div className="flex items-center gap-1">
                <span
                  className={cn(
                    'text-[9px] font-bold uppercase px-1 rounded border',
                    CHANNEL_COLORS[ch.channel] ??
                      'text-slate-600 bg-slate-50 border-default dark:text-slate-400 dark:bg-slate-800',
                  )}
                >
                  {ch.channel}
                </span>
                <span
                  className="text-[9px] text-slate-500 dark:text-slate-400 font-mono truncate max-w-[64px]"
                  title={ch.marketplace ?? undefined}
                >
                  {ch.marketplace ?? '—'}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setDeltaTarget({
                      sku: row.sku,
                      channel: ch.channel,
                      marketplace: ch.marketplace,
                    })
                  }
                  className="ml-auto p-0.5 rounded text-tertiary hover:text-blue-600 hover:bg-blue-50 dark:text-slate-500 dark:hover:text-blue-400 dark:hover:bg-blue-950/30 transition-colors"
                  title={`Preview sync delta · ${ch.channel}${ch.marketplace ? ` · ${ch.marketplace}` : ''}`}
                  aria-label={`Preview sync delta for ${row.sku} on ${ch.channel}`}
                >
                  <Eye className="w-2.5 h-2.5" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void resyncCell(
                      ch.channelListingId,
                      `${ch.channel}${ch.marketplace ? ` · ${ch.marketplace}` : ''}`,
                    )
                  }
                  disabled={resyncingCell === ch.channelListingId}
                  className="p-0.5 rounded text-tertiary hover:text-orange-600 hover:bg-orange-50 dark:text-slate-500 dark:hover:text-orange-400 dark:hover:bg-orange-950/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title={`Resync · ${ch.channel}${ch.marketplace ? ` · ${ch.marketplace}` : ''}`}
                  aria-label={`Resync ${row.sku} on ${ch.channel}`}
                >
                  {resyncingCell === ch.channelListingId
                    ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    : <RotateCcw className="w-2.5 h-2.5" />
                  }
                </button>
                {/* P7 B2 — suppress/activate toggle */}
                <button
                  type="button"
                  onClick={() =>
                    void suppressCell(
                      row.productId,
                      ch.channel,
                      ch.marketplace,
                      ch.channelListingId,
                      !ch.offerActive,
                    )
                  }
                  disabled={suppressingCell === ch.channelListingId}
                  className={cn(
                    'p-0.5 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                    ch.offerActive
                      ? 'text-tertiary hover:text-amber-600 hover:bg-amber-50 dark:text-slate-500 dark:hover:text-amber-400 dark:hover:bg-amber-950/30'
                      : 'text-amber-600 hover:text-emerald-600 hover:bg-emerald-50 dark:text-amber-400 dark:hover:text-emerald-400 dark:hover:bg-emerald-950/30',
                  )}
                  title={ch.offerActive
                    ? `Suppress pushes · ${ch.channel}${ch.marketplace ? ` · ${ch.marketplace}` : ''}`
                    : `Activate pushes · ${ch.channel}${ch.marketplace ? ` · ${ch.marketplace}` : ''}`
                  }
                  aria-label={ch.offerActive
                    ? `Suppress ${row.sku} on ${ch.channel}`
                    : `Activate ${row.sku} on ${ch.channel}`
                  }
                >
                  {suppressingCell === ch.channelListingId
                    ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    : ch.offerActive
                      ? <Pause className="w-2.5 h-2.5" />
                      : <Play className="w-2.5 h-2.5" />
                  }
                </button>
              </div>
              {/* Status chip + quantity; suppressed badge when offerActive=false */}
              <div className="flex items-center gap-1">
                <StatusChip status={ch.status} size="xs" />
                {!ch.offerActive && (
                  <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded border border-amber-300 bg-amber-50 text-amber-700 text-[9px] font-semibold dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                    <Pause className="w-2 h-2" />
                    suppressed
                  </span>
                )}
                <span className="tabular-nums text-[9px] text-slate-600 dark:text-slate-400 font-medium">
                  {ch.quantity ?? '—'}
                </span>
              </div>
              {/* Last synced */}
              <div className="text-[9px] text-tertiary dark:text-slate-500 tabular-nums">
                {fmtRelative(ch.lastSyncedAt)}
              </div>
            </div>
          ))}
        </div>
      </td>
    </tr>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export default function ControlTowerClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const confirm = useConfirm()

  const filterStatus = searchParams.get('status') ?? ''
  const filterChannel = searchParams.get('channel') ?? ''
  const rawPage = Number(searchParams.get('page') ?? '1')
  const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage

  const [rows, setRows] = useState<ControlTowerRow[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)

  // Delta-preview modal target (per channel×marketplace cell).
  const [deltaTarget, setDeltaTarget] = useState<DeltaPreviewTarget | null>(null)
  // Bulk-retry action state + transient toast.
  const [retrying, setRetrying] = useState(false)
  const [toast, setToast] = useState<{ msg: string; tone: 'success' | 'error' } | null>(null)
  // Per-cell resync state: stores channelListingId of the cell currently resyncing.
  const [resyncingCell, setResyncingCell] = useState<string | null>(null)
  // Per-cell suppress state: stores channelListingId of the cell being toggled.
  const [suppressingCell, setSuppressingCell] = useState<string | null>(null)
  // Collapsible group expand state — groups start collapsed by default.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  // Phase 6 T5 — DLQ badge (fetched with each grid load)
  const [dlqCount, setDlqCount] = useState<number | null>(null)

  const [density, setDensity] = useState<Density>(() => {
    if (typeof window === 'undefined') return 'comfortable'
    const v = window.localStorage.getItem(`${STORAGE_KEY}.density`) as Density | null
    return v === 'compact' || v === 'comfortable' || v === 'spacious' ? v : 'comfortable'
  })
  const [autoRefreshMin, setAutoRefreshMin] = useState<AutoRefreshInterval>(() => {
    if (typeof window === 'undefined') return 0
    const n = Number(window.localStorage.getItem(`${STORAGE_KEY}.autoRefreshMin`))
    return (n === 5 || n === 15) ? n : 0
  })

  useEffect(() => {
    try { window.localStorage.setItem(`${STORAGE_KEY}.density`, density) } catch {}
  }, [density])
  useEffect(() => {
    try { window.localStorage.setItem(`${STORAGE_KEY}.autoRefreshMin`, String(autoRefreshMin)) } catch {}
  }, [autoRefreshMin])

  // Build grouped items from the flat rows (pure derivation — no network calls).
  const groupedItems = useMemo(() => buildGroups(rows), [rows])

  // When a filter is active, auto-expand all groups (all rows on the page already
  // match the filter, so hiding them inside a collapsed header would obscure results).
  // When filters are cleared, collapse everything back to the default collapsed state.
  useEffect(() => {
    if (filterStatus || filterChannel) {
      const keys = groupedItems
        .filter((i): i is { type: 'group'; group: RowGroup } => i.type === 'group')
        .map((i) => i.group.key)
      setExpandedGroups(new Set(keys))
    } else {
      setExpandedGroups(new Set())
    }
  }, [rows, filterStatus, filterChannel]) // eslint-disable-line react-hooks/exhaustive-deps

  const allGroupKeys = useMemo(
    () => groupedItems.filter((i): i is { type: 'group'; group: RowGroup } => i.type === 'group').map((i) => i.group.key),
    [groupedItems],
  )
  const allExpanded = allGroupKeys.length > 0 && allGroupKeys.every((k) => expandedGroups.has(k))

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleAll() {
    setExpandedGroups(allExpanded ? new Set() : new Set(allGroupKeys))
  }

  function updateUrl(patch: Record<string, string | undefined>) {
    const p = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') p.delete(k)
      else p.set(k, v)
    }
    router.replace(`?${p.toString()}`, { scroll: false })
  }

  const BACKEND = getBackendUrl()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const p = new URLSearchParams()
      p.set('page', String(page))
      p.set('pageSize', String(PAGE_SIZE))
      if (filterStatus) p.set('status', filterStatus)
      if (filterChannel) p.set('channel', filterChannel)
      const res = await fetch(`${BACKEND}/api/inventory-sync/control-tower?${p}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: ApiResponse = await res.json()
      setRows(data.rows ?? [])
      setTotal(data.total ?? 0)
      setSummary(data.summary ?? {})
      setLastFetchedAt(Date.now())
      // Phase 6 T5 — fetch DLQ count alongside every grid refresh
      try {
        const dlqRes = await fetch(`${BACKEND}/api/outbound-queue?tab=dead&limit=1`)
        if (dlqRes.ok) {
          const dlqData = (await dlqRes.json()) as { stats?: { dead?: number } }
          setDlqCount(dlqData.stats?.dead ?? 0)
        }
      } catch {
        /* DLQ badge is non-critical; don't surface its failures */
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [BACKEND, page, filterStatus, filterChannel])

  // Initial load + on filter/page change
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, filterStatus, filterChannel])

  function showToast(msg: string, tone: 'success' | 'error') {
    setToast({ msg, tone })
    setTimeout(() => setToast(null), 3500)
  }

  // Per-cell resync: mark a single ChannelListing as PENDING + re-queue.
  async function resyncCell(channelListingId: string, label: string) {
    const ok = await confirm({
      title: `Resync ${label}?`,
      description: `This marks the listing as PENDING and re-queues it for channel sync. The published quantity will be recalculated on the next sync run.`,
      confirmLabel: 'Resync',
      tone: 'warning',
    })
    if (!ok) return
    setResyncingCell(channelListingId)
    try {
      const res = await fetch(`${BACKEND}/api/listings/bulk-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resync', listingIds: [channelListingId] }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { jobId: string; status: string; total: number }
      showToast(`Resync queued · ${label} · job ${body.jobId.slice(-6)}`, 'success')
      void load()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Resync failed', 'error')
    } finally {
      setResyncingCell(null)
    }
  }

  // Per-cell suppress/activate toggle: flips offerActive on the ChannelListing via
  // PATCH /api/products/:id/offer-availability. When suppressed, NEXUS_RESPECT_OFFER_ACTIVE
  // gate will skip pushing that cell. Behind a confirm.
  async function suppressCell(
    productId: string,
    channel: string,
    marketplace: string | null,
    channelListingId: string,
    newOfferActive: boolean,
  ) {
    const action = newOfferActive ? 'Activate' : 'Suppress'
    const label = `${channel}${marketplace ? ` · ${marketplace}` : ''}`
    const ok = await confirm({
      title: `${action} ${label}?`,
      description: newOfferActive
        ? `This re-enables outbound pushes for ${label}. The next sync run will push the current quantity.`
        : `This suppresses outbound pushes for ${label}. No quantity updates will be sent until re-activated.`,
      confirmLabel: action,
      tone: 'warning',
    })
    if (!ok) return
    setSuppressingCell(channelListingId)
    try {
      const res = await fetch(`${BACKEND}/api/products/${productId}/offer-availability`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markets: [{ channel, marketplace: marketplace ?? '', offerActive: newOfferActive }],
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      showToast(`${action} · ${label}`, 'success')
      void load()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : `${action} failed`, 'error')
    } finally {
      setSuppressingCell(null)
    }
  }

  // Bulk-retry: re-enqueue ALL failed + dead outbound-sync rows, optionally
  // scoped to the active channel filter. Behind a confirm. Refreshes on done.
  async function bulkRetry() {
    const scope = filterChannel || null
    const ok = await confirm({
      title: 'Retry failed syncs?',
      description: scope
        ? `This re-enqueues every failed and dead-lettered ${scope} sync job. It is not limited to the SKUs on this page.`
        : 'This re-enqueues every failed and dead-lettered sync job across all channels. It is not limited to the SKUs on this page.',
      confirmLabel: 'Retry failed',
      tone: 'warning',
    })
    if (!ok) return
    setRetrying(true)
    try {
      const res = await fetch(`${BACKEND}/api/outbound-queue/bulk-retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: scope ?? undefined }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { ok: boolean; count: number }
      showToast(
        `Re-enqueued ${body.count} sync job${body.count !== 1 ? 's' : ''}${scope ? ` · ${scope}` : ''}`,
        'success',
      )
      void load()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Retry failed', 'error')
    } finally {
      setRetrying(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const cellPad = ROW_PAD[density] ?? ROW_PAD.comfortable

  return (
    <div className="p-3 sm:p-6 space-y-4">

      {/* Phase 6 T5 — live sync-event banner (SSE, subscribe-only, dismiss per item) */}
      <ControlTowerBanner />

      {/* Transient action toast */}
      {toast && (
        <div className={cn(
          'fixed bottom-4 right-4 z-50 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium flex items-center gap-2',
          toast.tone === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white',
        )}>
          {toast.tone === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {toast.msg}
        </div>
      )}

      {/* Summary stat cards — click to toggle status filter */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        {SUMMARY_SPECS.map(({ key, label, cardClass, iconClass }) => {
          const count = summary[key] ?? 0
          const active = filterStatus === key
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              aria-pressed={active}
              onClick={() => updateUrl({ status: active ? '' : key, page: '1' })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  updateUrl({ status: active ? '' : key, page: '1' })
                }
              }}
              className={cn(
                'rounded-xl border px-3 py-2.5 flex items-center gap-2.5 cursor-pointer transition-opacity hover:opacity-80',
                cardClass,
                active && 'ring-2 ring-offset-1 ring-blue-500',
              )}
            >
              {getStatusIcon(key, cn('w-4 h-4 flex-shrink-0', iconClass))}
              <div>
                <div className="text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100">{count}</div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400 font-medium">{label}</div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Toolbar */}
      <GridToolbar
        quickFilterSlot={
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Status quick-filter chips */}
            {ALL_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => updateUrl({ status: filterStatus === s ? '' : s, page: '1' })}
                className={cn(
                  'px-2 py-0.5 rounded-md border text-xs font-medium transition-colors',
                  filterStatus === s
                    ? STATUS_CLASSES[s]
                    : 'border-default text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800',
                )}
              >
                {s.replace(/_/g, ' ')}
              </button>
            ))}

            {/* Channel quick-filter chips */}
            {CHANNELS.map((ch) => (
              <button
                key={ch}
                type="button"
                onClick={() => updateUrl({ channel: filterChannel === ch ? '' : ch, page: '1' })}
                className={cn(
                  'px-2 py-0.5 rounded-md border text-xs font-medium transition-colors',
                  filterChannel === ch
                    ? CHANNEL_COLORS[ch]
                    : 'border-default text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800',
                )}
              >
                {ch}
              </button>
            ))}

            {(filterStatus || filterChannel) && (
              <button
                type="button"
                onClick={() => updateUrl({ status: '', channel: '', page: '1' })}
                className="px-2 py-0.5 rounded-md text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 underline-offset-2 hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>
        }
        density={<DensityToggle density={density} onChange={setDensity} />}
        autoRefresh={
          <AutoRefreshSelect
            value={autoRefreshMin}
            onChange={setAutoRefreshMin}
            onTick={() => void load()}
          />
        }
        freshness={
          <FreshnessIndicator
            lastFetchedAt={lastFetchedAt}
            onRefresh={() => void load()}
            loading={loading}
          />
        }
        trailingSlot={
          <div className="flex items-center gap-2">
            {/* Expand all / Collapse all groups */}
            {allGroupKeys.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={toggleAll}
                icon={allExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                title={allExpanded ? 'Collapse all groups' : 'Expand all groups'}
              >
                {allExpanded ? 'Collapse all' : 'Expand all'}
              </Button>
            )}
            {/* Phase 6 T5 — DLQ badge: links to /sync-logs/outbound-queue when > 0 */}
            {dlqCount !== null && dlqCount > 0 && (
              <Link
                href="/sync-logs/outbound-queue"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-amber-300 bg-amber-50 text-amber-700 text-xs font-semibold hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60 transition-colors"
                title="View dead-lettered sync jobs"
              >
                <AlertTriangle className="w-3 h-3" />
                DLQ: {dlqCount}
              </Link>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void bulkRetry()}
              loading={retrying}
              icon={<RotateCcw className="w-3.5 h-3.5" />}
              title={
                filterChannel
                  ? `Re-enqueue all failed + dead ${filterChannel} sync jobs`
                  : 'Re-enqueue all failed + dead sync jobs (all channels)'
              }
            >
              {filterChannel ? `Retry failed · ${filterChannel}` : 'Retry failed'}
            </Button>
          </div>
        }
      />

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-tertiary" />
        </div>
      ) : error ? (
        <div className="text-sm text-red-600 dark:text-red-400 py-8 text-center">{error}</div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          {filterStatus || filterChannel ? (
            <>
              <ShieldAlert className="w-8 h-8 text-tertiary dark:text-slate-500" />
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">No SKUs match the current filters</p>
              <p className="text-xs text-tertiary dark:text-slate-500">Try clearing the status or channel filter.</p>
            </>
          ) : (
            <>
              <CheckCircle2 className="w-8 h-8 text-emerald-500 dark:text-emerald-400" />
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">All channels in sync</p>
              <p className="text-xs text-tertiary dark:text-slate-500">No active listings have sync issues.</p>
            </>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-default dark:border-slate-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800 border-b border-default dark:border-slate-700">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide w-44">
                  SKU
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide w-32">
                  Worst Status
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  Channel Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {groupedItems.map((item) => {
                if (item.type === 'standalone') {
                  return (
                    <DataRow
                      key={item.row.sku}
                      row={item.row}
                      cellPad={cellPad}
                      setDeltaTarget={setDeltaTarget}
                      resyncCell={resyncCell}
                      suppressCell={suppressCell}
                      resyncingCell={resyncingCell}
                      suppressingCell={suppressingCell}
                    />
                  )
                }

                // Group header + optional expanded member rows
                const { group } = item
                const isExpanded = expandedGroups.has(group.key)
                const rollup = groupChannelRollup(group)
                const memberCount = (group.parentRow ? 1 : 0) + group.childRows.length
                // Member rows: parent row first (if present), then children
                const memberRows: ControlTowerRow[] = [
                  ...(group.parentRow ? [group.parentRow] : []),
                  ...group.childRows,
                ]

                return (
                  <Fragment key={`group-${group.key}`}>
                    {/* Group header row */}
                    <tr
                      onClick={() => toggleGroup(group.key)}
                      className="cursor-pointer bg-slate-50/80 hover:bg-slate-100/80 dark:bg-slate-800/60 dark:hover:bg-slate-800/90 transition-colors select-none"
                      aria-expanded={isExpanded}
                    >
                      <td colSpan={3} className={cn(cellPad, 'border-l-2 border-l-slate-300 dark:border-l-slate-600')}>
                        <div className="flex items-center gap-2 flex-wrap">
                          {/* Chevron */}
                          <span className="text-tertiary flex-shrink-0">
                            {isExpanded
                              ? <ChevronDown className="w-3.5 h-3.5" />
                              : <ChevronRight className="w-3.5 h-3.5" />}
                          </span>
                          {/* Parent SKU */}
                          <span className="font-mono text-xs font-bold text-secondary dark:text-slate-200 flex-shrink-0">
                            {group.label}
                          </span>
                          {/* Member count badge */}
                          <span className="inline-flex items-center px-1.5 py-0 rounded-full border border-default bg-white dark:bg-slate-900 dark:border-slate-700 text-[10px] font-semibold text-tertiary tabular-nums flex-shrink-0">
                            {memberCount} {memberCount === 1 ? 'variant' : 'variants'}
                          </span>
                          {/* Per-channel rollup status chips */}
                          <div className="flex items-center gap-1 flex-wrap">
                            {Array.from(rollup.entries()).map(([ch, status]) => (
                              <div key={ch} className="inline-flex items-center gap-1">
                                <span className={cn(
                                  'text-[9px] font-bold uppercase px-1 rounded border',
                                  CHANNEL_COLORS[ch] ?? 'text-secondary bg-white border-default dark:text-slate-400 dark:bg-slate-800',
                                )}>
                                  {ch}
                                </span>
                                <StatusChip status={status} size="xs" />
                              </div>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>

                    {/* Member rows — visible only when group is expanded */}
                    {isExpanded && memberRows.map((row) => (
                      <DataRow
                        key={row.sku}
                        row={row}
                        cellPad={cellPad}
                        indent
                        setDeltaTarget={setDeltaTarget}
                        resyncCell={resyncCell}
                        suppressCell={suppressCell}
                        resyncingCell={resyncingCell}
                        suppressingCell={suppressingCell}
                      />
                    ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-4 py-3 border-t border-subtle dark:border-slate-800 flex items-center justify-between">
              <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total} SKUs
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => updateUrl({ page: String(page - 1) })}
                  disabled={page <= 1}
                  className="h-7 px-2.5 rounded border border-default dark:border-slate-700 text-xs font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Prev
                </button>
                <span className="tabular-nums text-xs text-slate-500 dark:text-slate-400 px-2">
                  {page} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => updateUrl({ page: String(page + 1) })}
                  disabled={page >= totalPages}
                  className="h-7 px-2.5 rounded border border-default dark:border-slate-700 text-xs font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Delta-preview modal (per channel×marketplace cell) */}
      {deltaTarget && (
        <DeltaPreviewModal target={deltaTarget} onClose={() => setDeltaTarget(null)} />
      )}
    </div>
  )
}
