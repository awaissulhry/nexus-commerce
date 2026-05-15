'use client'

/**
 * P3.1 + P3.2 — Outbound Sync Queue Monitor client.
 *
 * Three tabs: Active (pending/in-progress/failed), Dead Letters, Recent Successes.
 * Header stat cards per channel. Per-row slide-over with payload + error detail.
 * Bulk retry and bulk cancel actions.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Loader2,
  RefreshCw,
  RotateCcw,
  Skull,
  X,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

// ── Types ─────────────────────────────────────────────────────────────────

interface QueueRow {
  id: string
  productId: string | null
  sku: string | null
  productName: string | null
  channelListingId: string | null
  targetChannel: string
  syncType: string
  syncStatus: string
  isDead: boolean
  diedAt: string | null
  retryCount: number
  maxRetries: number
  errorMessage: string | null
  errorCode: string | null
  payload: unknown
  createdAt: string
  holdUntil: string | null
  syncedAt: string | null
  nextRetryAt: string | null
}

interface ChannelStats {
  pending: number
  inProgress: number
  failed: number
  dead: number
}

interface Stats {
  pending: number
  inProgress: number
  failed: number
  dead: number
  byChannel: Record<string, ChannelStats>
}

interface ApiResponse {
  items: QueueRow[]
  nextCursor: string | null
  stats: Stats
}

// ── Helpers ───────────────────────────────────────────────────────────────

const CHANNEL_COLORS: Record<string, string> = {
  AMAZON: 'text-orange-700 bg-orange-50 border-orange-200 dark:text-orange-300 dark:bg-orange-950/40 dark:border-orange-800',
  EBAY: 'text-blue-700 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-950/40 dark:border-blue-800',
  SHOPIFY: 'text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-800',
}

const SYNC_TYPE_LABELS: Record<string, string> = {
  PRICE_UPDATE: 'Price',
  QUANTITY_UPDATE: 'Qty',
  LISTING_SYNC: 'Listing',
  OFFER_SYNC: 'Offer',
  FULL_SYNC: 'Full',
  VARIATION_SYNC: 'Variation',
  ATTRIBUTE_UPDATE: 'Attrs',
}

function fmtRelative(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function StatusBadge({ status, isDead }: { status: string; isDead: boolean }) {
  if (isDead) return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700 border border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800">
      <Skull className="w-2.5 h-2.5" /> Dead
    </span>
  )
  const map: Record<string, string> = {
    PENDING: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
    IN_PROGRESS: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800',
    FAILED: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
    SUCCESS: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
    CANCELLED: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
    SKIPPED: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
  }
  return (
    <span className={cn('inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold border', map[status] ?? map.FAILED)}>
      {status}
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

const TABS = [
  { key: 'active', label: 'Active', icon: Zap },
  { key: 'dead', label: 'Dead Letters', icon: Skull },
  { key: 'success', label: 'Recent Successes', icon: CheckCircle2 },
] as const

const CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY'] as const

export default function OutboundQueueClient() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const tab = (searchParams.get('tab') ?? 'active') as 'active' | 'dead' | 'success'
  const filterStatus = searchParams.get('status') ?? ''
  const filterChannel = searchParams.get('channel') ?? ''
  const filterType = searchParams.get('syncType') ?? ''
  const stuckOnly = searchParams.get('stuckOnly') === 'true'

  const [items, setItems] = useState<QueueRow[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<QueueRow | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; tone: 'success' | 'error' } | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function updateUrl(patch: Record<string, string | undefined>) {
    const p = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') p.delete(k)
      else p.set(k, v)
    }
    p.delete('cursor') // always reset pagination on filter change
    router.replace(`?${p.toString()}`, { scroll: false })
  }

  const BACKEND = getBackendUrl()

  const buildUrl = useCallback((cursor?: string) => {
    const p = new URLSearchParams()
    p.set('tab', tab)
    if (filterStatus) p.set('status', filterStatus)
    if (filterChannel) p.set('channel', filterChannel)
    if (filterType) p.set('syncType', filterType)
    if (stuckOnly) p.set('stuckOnly', 'true')
    p.set('limit', '50')
    if (cursor) p.set('cursor', cursor)
    return `${BACKEND}/api/outbound-queue?${p}`
  }, [BACKEND, tab, filterStatus, filterChannel, filterType, stuckOnly])

  const load = useCallback(async (reset = true) => {
    reset ? setLoading(true) : setLoadingMore(true)
    setError(null)
    try {
      const res = await fetch(buildUrl(reset ? undefined : nextCursor ?? undefined))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: ApiResponse = await res.json()
      if (reset) {
        setItems(data.items)
        setStats(data.stats)
        setSelected(new Set())
      } else {
        setItems((prev) => [...prev, ...data.items])
      }
      setNextCursor(data.nextCursor)
      if (reset && data.stats) setStats(data.stats)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      reset ? setLoading(false) : setLoadingMore(false)
    }
  }, [buildUrl, nextCursor])

  // Initial load + on filter change
  useEffect(() => {
    void load(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, filterStatus, filterChannel, filterType, stuckOnly])

  // 15s auto-refresh for active tab
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    if (tab === 'active') {
      pollRef.current = setInterval(() => void load(true), 15_000)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [load, tab])

  function showToast(msg: string, tone: 'success' | 'error') {
    setToast({ msg, tone })
    setTimeout(() => setToast(null), 3000)
  }

  async function retryOne(id: string) {
    setActionLoading(id)
    try {
      const res = await fetch(`${BACKEND}/api/outbound-queue/${id}/retry`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      showToast('Job re-enqueued', 'success')
      void load(true)
    } catch (e: any) {
      showToast(e?.message ?? 'Failed', 'error')
    } finally {
      setActionLoading(null)
    }
  }

  async function cancelOne(id: string) {
    setActionLoading(id)
    try {
      const res = await fetch(`${BACKEND}/api/outbound-queue/${id}/cancel`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      showToast('Job cancelled', 'success')
      void load(true)
    } catch (e: any) {
      showToast(e?.message ?? 'Failed', 'error')
    } finally {
      setActionLoading(null)
    }
  }

  async function bulkAction(action: 'retry' | 'cancel') {
    const ids = Array.from(selected)
    if (!ids.length) return
    setActionLoading(`bulk-${action}`)
    try {
      const res = await fetch(`${BACKEND}/api/outbound-queue/bulk-${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      showToast(`${action === 'retry' ? 'Re-enqueued' : 'Cancelled'} ${body.count} job${body.count !== 1 ? 's' : ''}`, 'success')
      setSelected(new Set())
      void load(true)
    } catch (e: any) {
      showToast(e?.message ?? 'Failed', 'error')
    } finally {
      setActionLoading(null)
    }
  }

  async function retryAllFailed() {
    setActionLoading('bulk-retry-all')
    try {
      const res = await fetch(`${BACKEND}/api/outbound-queue/bulk-retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: filterChannel || undefined }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      showToast(`Re-enqueued ${body.count} job${body.count !== 1 ? 's' : ''}`, 'success')
      void load(true)
    } catch (e: any) {
      showToast(e?.message ?? 'Failed', 'error')
    } finally {
      setActionLoading(null)
    }
  }

  const allSelected = items.length > 0 && items.every((r) => selected.has(r.id))
  const someSelected = selected.size > 0

  return (
    <div className="space-y-4">

      {/* Toast */}
      {toast && (
        <div className={cn(
          'fixed bottom-4 right-4 z-50 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium flex items-center gap-2',
          toast.tone === 'success'
            ? 'bg-emerald-600 text-white'
            : 'bg-red-600 text-white',
        )}>
          {toast.tone === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {toast.msg}
        </div>
      )}

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Pending', value: stats.pending, icon: Clock, tone: stats.pending > 0 ? 'amber' : 'neutral' },
            { label: 'In Progress', value: stats.inProgress, icon: Loader2, tone: stats.inProgress > 0 ? 'blue' : 'neutral' },
            { label: 'Failed', value: stats.failed, icon: AlertTriangle, tone: stats.failed > 0 ? 'red' : 'neutral' },
            { label: 'Dead', value: stats.dead, icon: Skull, tone: stats.dead > 0 ? 'red' : 'neutral' },
          ].map(({ label, value, icon: Icon, tone }) => (
            <div key={label} className={cn(
              'rounded-xl border px-4 py-3 flex items-center gap-3',
              tone === 'amber' && 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20',
              tone === 'blue' && 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/20',
              tone === 'red' && 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/20',
              tone === 'neutral' && 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900',
            )}>
              <Icon className={cn(
                'w-4 h-4 flex-shrink-0',
                tone === 'amber' && 'text-amber-600 dark:text-amber-400',
                tone === 'blue' && 'text-blue-600 dark:text-blue-400',
                tone === 'red' && 'text-red-600 dark:text-red-400',
                tone === 'neutral' && 'text-slate-400',
              )} />
              <div>
                <div className="text-2xl font-bold text-slate-900 dark:text-slate-100 tabular-nums">{value}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Per-channel stats */}
      {stats && (
        <div className="flex items-center gap-2 flex-wrap">
          {CHANNELS.map((ch) => {
            const s = stats.byChannel[ch]
            if (!s) return null
            const hasIssues = s.failed + s.dead > 0
            return (
              <button
                key={ch}
                type="button"
                onClick={() => updateUrl({ channel: filterChannel === ch ? '' : ch, tab: 'active' })}
                className={cn(
                  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors',
                  CHANNEL_COLORS[ch] ?? 'border-slate-200 text-slate-600',
                  filterChannel === ch && 'ring-2 ring-offset-1 ring-blue-500',
                )}
              >
                {ch}
                <span className={cn('tabular-nums font-bold', hasIssues && 'text-red-600 dark:text-red-400')}>
                  {s.pending + s.inProgress} pending
                </span>
                {hasIssues && (
                  <span className="text-red-600 dark:text-red-400 font-bold">
                    · {s.failed + s.dead} issues
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* Tabs + filter bar */}
      <div className="flex items-center gap-3 flex-wrap border-b border-slate-200 dark:border-slate-700 pb-0">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => updateUrl({ tab: key, status: '', stuckOnly: '' })}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === key
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300',
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
            {key === 'dead' && (stats?.dead ?? 0) > 0 && (
              <span className="ml-0.5 bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                {stats!.dead}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Filter chips row */}
      <div className="flex items-center gap-2 flex-wrap">
        {tab === 'active' && (
          <>
            {(['PENDING', 'IN_PROGRESS', 'FAILED'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => updateUrl({ status: filterStatus === s ? '' : s })}
                className={cn(
                  'px-2.5 py-1 rounded-md border text-xs font-medium transition-colors',
                  filterStatus === s
                    ? 'bg-slate-800 text-white border-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800',
                )}
              >
                {s.replace('_', ' ')}
              </button>
            ))}
            <button
              type="button"
              onClick={() => updateUrl({ stuckOnly: stuckOnly ? '' : 'true' })}
              className={cn(
                'px-2.5 py-1 rounded-md border text-xs font-medium transition-colors flex items-center gap-1',
                stuckOnly
                  ? 'bg-amber-600 text-white border-amber-600'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800',
              )}
            >
              <AlertTriangle className="w-3 h-3" /> Stuck only
            </button>
          </>
        )}

        {/* Sync type filter */}
        {Object.entries(SYNC_TYPE_LABELS).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => updateUrl({ syncType: filterType === key ? '' : key })}
            className={cn(
              'px-2.5 py-1 rounded-md border text-xs font-medium transition-colors',
              filterType === key
                ? 'bg-slate-800 text-white border-slate-800 dark:bg-slate-100 dark:text-slate-900'
                : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-500 dark:hover:bg-slate-800',
            )}
          >
            {label}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2">
          {tab === 'active' && (stats?.failed ?? 0) > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void retryAllFailed()}
              disabled={actionLoading === 'bulk-retry-all'}
            >
              {actionLoading === 'bulk-retry-all'
                ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                : <RotateCcw className="w-3.5 h-3.5 mr-1" />}
              Retry all failed
            </Button>
          )}
          {tab === 'dead' && (stats?.dead ?? 0) > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void retryAllFailed()}
              disabled={actionLoading === 'bulk-retry-all'}
            >
              {actionLoading === 'bulk-retry-all'
                ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                : <RotateCcw className="w-3.5 h-3.5 mr-1" />}
              Re-enqueue all dead
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => void load(true)} disabled={loading}>
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </Button>
        </div>
      </div>

      {/* Bulk action bar */}
      {someSelected && (
        <div className="flex items-center gap-3 px-3 py-2 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg text-sm">
          <span className="font-medium text-blue-800 dark:text-blue-200">{selected.size} selected</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void bulkAction('retry')}
            disabled={!!actionLoading}
          >
            {actionLoading === 'bulk-retry' ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RotateCcw className="w-3 h-3 mr-1" />}
            Retry selected
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void bulkAction('cancel')}
            disabled={!!actionLoading}
          >
            {actionLoading === 'bulk-cancel' ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <X className="w-3 h-3 mr-1" />}
            Cancel selected
          </Button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            Clear
          </button>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      ) : error ? (
        <div className="text-sm text-red-600 dark:text-red-400 py-8 text-center">{error}</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-slate-400 dark:text-slate-500 py-12 text-center">
          {tab === 'dead' ? 'No dead jobs — all retries are succeeding.' :
           tab === 'success' ? 'No successful syncs in the last 2 hours.' :
           'No active jobs matching the current filters.'}
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) => setSelected(e.target.checked ? new Set(items.map((r) => r.id)) : new Set())}
                    className="w-3.5 h-3.5 accent-blue-600"
                  />
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">SKU</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Channel</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Type</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Status</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Retries</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Age</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide w-48">Error</th>
                <th className="px-3 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {items.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => setDetail(row)}
                  className={cn(
                    'cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50',
                    row.isDead && 'bg-red-50/40 dark:bg-red-950/10',
                    row.syncStatus === 'FAILED' && !row.isDead && 'bg-amber-50/40 dark:bg-amber-950/10',
                    selected.has(row.id) && 'bg-blue-50 dark:bg-blue-950/20',
                  )}
                >
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(row.id)}
                      onChange={(e) => {
                        const n = new Set(selected)
                        e.target.checked ? n.add(row.id) : n.delete(row.id)
                        setSelected(n)
                      }}
                      className="w-3.5 h-3.5 accent-blue-600"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-mono text-xs text-slate-800 dark:text-slate-200 font-semibold">{row.sku ?? '—'}</div>
                    {row.productName && (
                      <div className="text-[10px] text-slate-400 dark:text-slate-500 truncate max-w-[140px]">{row.productName}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={cn('inline-flex px-1.5 py-0.5 rounded border text-[10px] font-semibold', CHANNEL_COLORS[row.targetChannel] ?? '')}>
                      {row.targetChannel}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-xs text-slate-600 dark:text-slate-400">
                      {SYNC_TYPE_LABELS[row.syncType] ?? row.syncType}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={row.syncStatus} isDead={row.isDead} />
                  </td>
                  <td className="px-3 py-2 tabular-nums text-xs text-slate-600 dark:text-slate-400">
                    {row.retryCount}/{row.maxRetries}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
                    {fmtRelative(row.isDead ? row.diedAt : row.createdAt)}
                  </td>
                  <td className="px-3 py-2 max-w-[12rem]">
                    {row.errorMessage && (
                      <span className="text-[10px] text-red-600 dark:text-red-400 truncate block" title={row.errorMessage}>
                        {row.errorMessage.slice(0, 60)}{row.errorMessage.length > 60 ? '…' : ''}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1 justify-end">
                      {(row.syncStatus === 'FAILED' || row.isDead) && (
                        <button
                          type="button"
                          title="Retry this job"
                          onClick={() => void retryOne(row.id)}
                          disabled={actionLoading === row.id}
                          className="p-1 rounded text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/20 disabled:opacity-40"
                        >
                          {actionLoading === row.id
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <RotateCcw className="w-3.5 h-3.5" />}
                        </button>
                      )}
                      {(row.syncStatus === 'PENDING' || row.syncStatus === 'IN_PROGRESS') && (
                        <button
                          type="button"
                          title="Cancel this job"
                          onClick={() => void cancelOne(row.id)}
                          disabled={actionLoading === row.id}
                          className="p-1 rounded text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/20 disabled:opacity-40"
                        >
                          {actionLoading === row.id
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <X className="w-3.5 h-3.5" />}
                        </button>
                      )}
                      <ChevronDown className="w-3 h-3 text-slate-300 dark:text-slate-600" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {nextCursor && (
            <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void load(false)}
                disabled={loadingMore}
              >
                {loadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
                Load more
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Detail slide-over */}
      {detail && (
        <DetailSlideOver
          row={detail}
          onClose={() => setDetail(null)}
          onRetry={() => { void retryOne(detail.id); setDetail(null) }}
          onCancel={() => { void cancelOne(detail.id); setDetail(null) }}
          actionLoading={actionLoading === detail.id}
        />
      )}
    </div>
  )
}

// ── Detail slide-over ──────────────────────────────────────────────────────

function DetailSlideOver({
  row,
  onClose,
  onRetry,
  onCancel,
  actionLoading,
}: {
  row: QueueRow
  onClose: () => void
  onRetry: () => void
  onCancel: () => void
  actionLoading: boolean
}) {
  const [payloadOpen, setPayloadOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      onClick={onClose}
      role="presentation"
    >
      <div className="absolute inset-0 bg-slate-900/30" aria-hidden />
      <aside
        className="relative w-full max-w-lg bg-white dark:bg-slate-900 shadow-2xl border-l border-slate-200 dark:border-slate-800 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Queue job detail"
      >
        {/* Header */}
        <header className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 sticky top-0 bg-white dark:bg-slate-900 flex items-center justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusBadge status={row.syncStatus} isDead={row.isDead} />
              <span className={cn('inline-flex px-1.5 py-0.5 rounded border text-[10px] font-semibold', CHANNEL_COLORS[row.targetChannel] ?? '')}>
                {row.targetChannel}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {SYNC_TYPE_LABELS[row.syncType] ?? row.syncType}
              </span>
            </div>
            <div className="text-sm font-mono font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
              {row.sku ?? '—'}
              {row.productName && <span className="text-slate-400 font-normal ml-2 text-xs">{row.productName}</span>}
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Body */}
        <div className="px-4 py-4 space-y-4 text-sm">
          {/* Metadata grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {([
              ['Retries', `${row.retryCount} / ${row.maxRetries}`],
              ['Created', fmtRelative(row.createdAt)],
              ['Hold until', row.holdUntil ? fmtRelative(row.holdUntil) : '—'],
              ['Synced at', row.syncedAt ? fmtRelative(row.syncedAt) : '—'],
              ['Next retry', row.nextRetryAt ? fmtRelative(row.nextRetryAt) : '—'],
              ['Died at', row.diedAt ? fmtRelative(row.diedAt) : '—'],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label}>
                <div className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">{label}</div>
                <div className="text-xs text-slate-700 dark:text-slate-300 font-mono">{value}</div>
              </div>
            ))}
          </div>

          {row.errorMessage && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/20 px-3 py-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-red-700 dark:text-red-300 mb-1">
                <AlertCircle className="w-3.5 h-3.5" />
                Error {row.errorCode ? `· ${row.errorCode}` : ''}
              </div>
              <pre className="text-[11px] text-red-700 dark:text-red-300 whitespace-pre-wrap break-all font-mono">
                {row.errorMessage}
              </pre>
            </div>
          )}

          {/* Payload */}
          {row.payload != null && (
            <div>
              <button
                type="button"
                onClick={() => setPayloadOpen((o) => !o)}
                className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
              >
                {payloadOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                Job payload
              </button>
              {payloadOpen && (
                <pre className="mt-2 text-[11px] font-mono bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all text-slate-700 dark:text-slate-300 max-h-64 overflow-y-auto">
                  {JSON.stringify(row.payload, null, 2)}
                </pre>
              )}
            </div>
          )}

          {/* IDs */}
          <div className="space-y-1">
            {([
              ['Queue ID', row.id],
              ['Product ID', row.productId],
              ['Listing ID', row.channelListingId],
            ] as [string, string | null][]).filter(([, v]) => v).map(([label, value]) => (
              <div key={label} className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500 w-20 flex-shrink-0">{label}</span>
                <code className="text-[10px] font-mono text-slate-600 dark:text-slate-400 truncate">{value}</code>
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <footer className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center gap-2">
          {(row.syncStatus === 'FAILED' || row.isDead) && (
            <Button variant="primary" size="sm" onClick={onRetry} disabled={actionLoading}>
              {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <RotateCcw className="w-3.5 h-3.5 mr-1" />}
              {row.isDead ? 'Re-enqueue' : 'Retry job'}
            </Button>
          )}
          {(row.syncStatus === 'PENDING' || row.syncStatus === 'IN_PROGRESS') && (
            <Button variant="secondary" size="sm" onClick={onCancel} disabled={actionLoading}>
              {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <X className="w-3.5 h-3.5 mr-1" />}
              Cancel job
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} className="ml-auto">Close</Button>
        </footer>
      </aside>
    </div>
  )
}
