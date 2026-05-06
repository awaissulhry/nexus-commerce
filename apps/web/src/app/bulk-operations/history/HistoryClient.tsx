'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  History as HistoryIcon,
  Loader2,
  RefreshCw,
  XCircle,
  SkipForward,
  Ban,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

// ── Types (mirror the API response shapes) ─────────────────────────

interface JobRow {
  id: string
  jobName: string
  actionType: string
  channel: string | null
  status: string
  totalItems: number
  processedItems: number
  failedItems: number
  skippedItems: number
  progressPercent: number
  lastError: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

interface ItemRow {
  id: string
  jobId: string
  productId: string | null
  variationId: string | null
  channelListingId: string | null
  status: string
  errorMessage: string | null
  beforeState: Record<string, unknown> | null
  afterState: Record<string, unknown> | null
  createdAt: string
  completedAt: string | null
  sku: string | null
  channelLabel: string | null
}

// ── Filter chips ───────────────────────────────────────────────────

type StatusFilter = 'all' | 'active' | 'terminal' | 'COMPLETED' | 'PARTIALLY_COMPLETED' | 'FAILED' | 'CANCELLED'

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'PARTIALLY_COMPLETED', label: 'Partial' },
  { key: 'FAILED', label: 'Failed' },
  { key: 'CANCELLED', label: 'Cancelled' },
]

// ── Status presentation ────────────────────────────────────────────

function statusVariant(
  status: string,
): 'success' | 'warning' | 'danger' | 'info' | 'default' {
  switch (status) {
    case 'COMPLETED':
    case 'SUCCEEDED':
      return 'success'
    case 'PARTIALLY_COMPLETED':
    case 'SKIPPED':
      return 'warning'
    case 'FAILED':
      return 'danger'
    case 'CANCELLED':
      return 'default'
    case 'PENDING':
    case 'QUEUED':
    case 'IN_PROGRESS':
    case 'PROCESSING':
      return 'info'
    default:
      return 'default'
  }
}

function StatusIcon({ status, className }: { status: string; className?: string }) {
  const cls = cn('w-3.5 h-3.5', className)
  switch (status) {
    case 'COMPLETED':
    case 'SUCCEEDED':
      return <CheckCircle2 className={cn(cls, 'text-green-600')} />
    case 'PARTIALLY_COMPLETED':
      return <AlertCircle className={cn(cls, 'text-amber-600')} />
    case 'FAILED':
      return <XCircle className={cn(cls, 'text-red-600')} />
    case 'CANCELLED':
      return <Ban className={cn(cls, 'text-slate-500')} />
    case 'SKIPPED':
      return <SkipForward className={cn(cls, 'text-amber-600')} />
    case 'PENDING':
    case 'QUEUED':
      return <Clock className={cn(cls, 'text-blue-600')} />
    case 'IN_PROGRESS':
      return <Loader2 className={cn(cls, 'text-blue-600 animate-spin')} />
    default:
      return <Clock className={cn(cls, 'text-slate-400')} />
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(iso).toISOString().slice(0, 10)
}

function durationMs(startIso: string | null, endIso: string | null): string | null {
  if (!startIso || !endIso) return null
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime()
  if (ms < 0) return null
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}

function formatActionType(t: string): string {
  return t
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatStateValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function diffEntries(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Array<{ key: string; before: unknown; after: unknown; changed: boolean }> {
  const keys = new Set<string>()
  if (before) Object.keys(before).forEach((k) => keys.add(k))
  if (after) Object.keys(after).forEach((k) => keys.add(k))
  return Array.from(keys).map((key) => {
    const b = before ? before[key] : undefined
    const a = after ? after[key] : undefined
    return {
      key,
      before: b,
      after: a,
      changed: JSON.stringify(b) !== JSON.stringify(a),
    }
  })
}

// ── Items panel (per-job drill-down) ───────────────────────────────

function ItemsPanel({ jobId }: { jobId: string }) {
  const [items, setItems] = useState<ItemRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const fetchItems = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = new URL(
        `${getBackendUrl()}/api/bulk-operations/${jobId}/items`,
      )
      if (statusFilter !== 'all') url.searchParams.set('status', statusFilter)
      const res = await fetch(url.toString(), { cache: 'no-store' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setItems(data.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [jobId, statusFilter])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  const counts = useMemo(() => {
    const c = { SUCCEEDED: 0, FAILED: 0, SKIPPED: 0, PENDING: 0 } as Record<
      string,
      number
    >
    if (items) {
      for (const it of items) c[it.status] = (c[it.status] ?? 0) + 1
    }
    return c
  }, [items])

  const ITEM_FILTERS: Array<{ key: string; label: string; count?: number }> = [
    { key: 'all', label: 'All' },
    { key: 'SUCCEEDED', label: 'Succeeded', count: counts.SUCCEEDED },
    { key: 'FAILED', label: 'Failed', count: counts.FAILED },
    { key: 'SKIPPED', label: 'Skipped', count: counts.SKIPPED },
  ]

  return (
    <div className="bg-slate-50 border-t border-slate-200 px-5 py-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1">
          {ITEM_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setStatusFilter(f.key)}
              className={cn(
                'px-2.5 py-1 text-[11px] font-medium rounded border transition-colors',
                statusFilter === f.key
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300',
              )}
            >
              {f.label}
              {f.count !== undefined && (
                <span className="ml-1 opacity-70">{f.count}</span>
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={fetchItems}
          disabled={loading}
          className="text-[11px] text-slate-500 hover:text-slate-900 inline-flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 mb-3">
          {error}
        </div>
      )}

      {loading && !items && (
        <div className="space-y-1">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-9 bg-white border border-slate-200 rounded animate-pulse"
            />
          ))}
        </div>
      )}

      {items && items.length === 0 && !loading && (
        <div className="text-center py-6 text-[12px] text-slate-500">
          No items match this filter.
        </div>
      )}

      {items && items.length > 0 && (
        <div className="bg-white border border-slate-200 rounded overflow-hidden">
          <table className="w-full text-[12px]">
            <thead className="bg-slate-50 text-[11px] text-slate-600 border-b border-slate-200">
              <tr>
                <th className="text-left font-medium px-3 py-2 w-32">Status</th>
                <th className="text-left font-medium px-3 py-2">Target</th>
                <th className="text-left font-medium px-3 py-2">Before → After</th>
                <th className="text-left font-medium px-3 py-2 w-32">When</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const diffs = diffEntries(it.beforeState, it.afterState)
                const changed = diffs.filter((d) => d.changed)
                return (
                  <tr key={it.id} className="border-b border-slate-100 last:border-0 align-top">
                    <td className="px-3 py-2">
                      <Badge variant={statusVariant(it.status)} size="sm">
                        <StatusIcon status={it.status} className="w-3 h-3" />
                        {it.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-mono text-[11px] text-slate-900">
                        {it.sku ?? <span className="text-slate-400">(deleted)</span>}
                      </div>
                      {it.channelLabel && (
                        <div className="text-[10px] text-slate-500 mt-0.5">
                          {it.channelLabel}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {it.errorMessage ? (
                        <div className="text-red-700 text-[11px]">
                          {it.errorMessage}
                        </div>
                      ) : changed.length === 0 ? (
                        <span className="text-slate-400 text-[11px]">no change</span>
                      ) : (
                        <div className="space-y-0.5">
                          {changed.map((d) => (
                            <div
                              key={d.key}
                              className="flex items-center gap-1.5 text-[11px]"
                            >
                              <span className="text-slate-500 font-medium">
                                {d.key}:
                              </span>
                              <span className="font-mono text-slate-500 line-through">
                                {formatStateValue(d.before)}
                              </span>
                              <ArrowRight className="w-3 h-3 text-slate-400" />
                              <span className="font-mono text-slate-900 font-medium">
                                {formatStateValue(d.after)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-slate-500">
                      {relativeTime(it.completedAt ?? it.createdAt)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Job card ───────────────────────────────────────────────────────

function JobCard({ job }: { job: JobRow }) {
  const [expanded, setExpanded] = useState(false)
  const duration = durationMs(job.startedAt, job.completedAt)

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-5 py-3 flex items-center gap-4 hover:bg-slate-50 transition-colors text-left"
      >
        <div className="flex-shrink-0">
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-slate-400" />
          )}
        </div>
        <StatusIcon status={job.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-slate-900 text-[13px] truncate">
              {job.jobName}
            </h3>
            <Badge variant="default" size="sm">
              {formatActionType(job.actionType)}
            </Badge>
            {job.channel && (
              <Badge variant="info" size="sm">
                {job.channel}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-500">
            <Badge variant={statusVariant(job.status)} size="sm">
              {job.status.replace(/_/g, ' ')}
            </Badge>
            <span>
              <span className="font-medium text-green-700">
                {job.processedItems}
              </span>
              {' / '}
              <span>{job.totalItems}</span> processed
            </span>
            {job.failedItems > 0 && (
              <span className="text-red-700 font-medium">
                {job.failedItems} failed
              </span>
            )}
            {job.skippedItems > 0 && (
              <span className="text-amber-700">
                {job.skippedItems} skipped
              </span>
            )}
            {duration && <span>· {duration}</span>}
            <span title={new Date(job.createdAt).toLocaleString()}>
              · {relativeTime(job.createdAt)}
            </span>
          </div>
          {job.lastError && job.status !== 'COMPLETED' && (
            <div className="mt-1.5 text-[11px] text-red-700 truncate">
              {job.lastError}
            </div>
          )}
        </div>
      </button>
      {expanded && <ItemsPanel jobId={job.id} />}
    </div>
  )
}

// ── Top-level client ───────────────────────────────────────────────

export default function HistoryClient() {
  // URL-shareable filter state. The status filter lives in `?status=`
  // so a power user can bookmark "Failed jobs" or share a link with a
  // teammate. URL is the source of truth; setStatusFilter pushes a
  // new URL and the param-derived value flows back through.
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlStatus = (searchParams.get('status') ?? 'all') as StatusFilter
  const validStatuses = useMemo(
    () => new Set(STATUS_FILTERS.map((f) => f.key as StatusFilter)),
    [],
  )
  const statusFilter: StatusFilter = validStatuses.has(urlStatus)
    ? urlStatus
    : 'all'
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

  const [jobs, setJobs] = useState<JobRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchJobs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const url = new URL(`${getBackendUrl()}/api/bulk-operations/history`)
      if (statusFilter !== 'all') url.searchParams.set('status', statusFilter)
      url.searchParams.set('limit', '50')
      const res = await fetch(url.toString(), { cache: 'no-store' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setJobs(data.jobs ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    fetchJobs()
  }, [fetchJobs])

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setStatusFilter(f.key)}
              className={cn(
                'px-3 py-1 text-[11px] font-medium rounded border transition-colors',
                statusFilter === f.key
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <Button variant="secondary" size="sm" onClick={fetchJobs} disabled={loading}>
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          Failed to load: {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !jobs && (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-16 bg-white border border-slate-200 rounded-lg animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {jobs && jobs.length === 0 && !loading && (
        <EmptyState
          icon={HistoryIcon}
          title={
            statusFilter === 'all'
              ? 'No bulk operations yet'
              : 'No jobs match this filter'
          }
          description={
            statusFilter === 'all'
              ? 'Run a bulk operation from /bulk-operations and it will show up here for review.'
              : 'Try a different filter or wait for jobs to land in this state.'
          }
          action={
            statusFilter === 'all'
              ? { label: 'Open Bulk Operations', href: '/bulk-operations' }
              : undefined
          }
        />
      )}

      {/* Jobs */}
      {jobs && jobs.length > 0 && (
        <div className="space-y-2">
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </div>
  )
}
