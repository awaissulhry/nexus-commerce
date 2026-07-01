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

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
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
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────────────────

type SyncStatus = 'DEAD' | 'FAILED' | 'CLAMPED' | 'PENDING' | 'IN_SYNC' | 'UNKNOWN'

interface ChannelEntry {
  channel: string
  marketplace: string | null
  status: SyncStatus
  lastSyncedAt: string | null
  quantity: number | null
}

interface ControlTowerRow {
  sku: string
  productId: string
  negativeAvailable: boolean
  channels: ChannelEntry[]
  worstStatus: SyncStatus
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

const ROW_PAD: Record<Density, string> = {
  compact:     'px-2 py-1',
  comfortable: 'px-3 py-2',
  spacious:    'px-4 py-3',
}

const ALL_STATUSES: SyncStatus[] = ['DEAD', 'FAILED', 'CLAMPED', 'PENDING', 'IN_SYNC', 'UNKNOWN']
const CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY'] as const
const STORAGE_KEY = 'inventory-control-tower'
const PAGE_SIZE = 50

// ── Main component ─────────────────────────────────────────────────────────

export default function ControlTowerClient() {
  const router = useRouter()
  const searchParams = useSearchParams()

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

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const cellPad = ROW_PAD[density] ?? ROW_PAD.comfortable

  return (
    <div className="p-3 sm:p-6 space-y-4">

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
              <ShieldAlert className="w-8 h-8 text-slate-400 dark:text-slate-500" />
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
              {rows.map((row) => (
                <tr
                  key={row.sku}
                  className={cn(
                    'transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50',
                    (row.worstStatus === 'DEAD' || row.worstStatus === 'FAILED') &&
                      'bg-red-50/30 dark:bg-red-950/10',
                    row.worstStatus === 'CLAMPED' && 'bg-amber-50/30 dark:bg-amber-950/10',
                  )}
                >
                  {/* SKU + negative-available warning */}
                  <td className={cellPad}>
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
                          className="inline-flex flex-col gap-0.5 border border-slate-200 dark:border-slate-700 rounded-md px-2 py-1 min-w-[92px]"
                        >
                          {/* Channel badge + marketplace */}
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
                          </div>
                          {/* Status chip + quantity */}
                          <div className="flex items-center gap-1">
                            <StatusChip status={ch.status} size="xs" />
                            <span className="tabular-nums text-[9px] text-slate-600 dark:text-slate-400 font-medium">
                              {ch.quantity ?? '—'}
                            </span>
                          </div>
                          {/* Last synced */}
                          <div className="text-[9px] text-slate-400 dark:text-slate-500 tabular-nums">
                            {fmtRelative(ch.lastSyncedAt)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
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
    </div>
  )
}
