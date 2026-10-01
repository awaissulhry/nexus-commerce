'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { usePathname, useRouter } from '@/lib/workspaces/navigation'
import {
  AlertCircle,
  ArrowRight,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  History as HistoryIcon,
  Loader2,
  RefreshCw,
  RotateCw,
  SkipForward,
  XCircle,
} from 'lucide-react'
import { Button, FilterChip, Pill, Skeleton, type Tone } from '@/design-system/primitives'
import { Banner, Drawer, EmptyState, KeyValue, PressableRow, useToast } from '@/design-system/components'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import FreshnessIndicator from '@/components/filters/FreshnessIndicator'
import { AutoRefreshSelect, GridToolbar } from '@/app/_shared/grid-lens'
import Link from '@/lib/workspaces/Link'
import { getBackendUrl } from '@/lib/backend-url'
import s from './history.module.css'
import { ItemMessageBanner, ItemMessageText } from './ItemMessage'

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
  // Rollback eligibility — drives the Rollback button visibility
  isRollbackable: boolean
  rollbackJobId: string | null
  /** Who ran it: a person's display name or a system label (bulk-action-actor.ts); null when unknown. */
  createdByName?: string | null
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
  durationMs: number | null
  sku: string | null
  channelLabel: string | null
}

/** W10.3 — short ms label for the per-item duration column. */
function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60_000)
  const sec = Math.round((ms % 60_000) / 1000)
  return `${min}m ${sec}s`
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

function statusTone(status: string): Tone {
  switch (status) {
    case 'COMPLETED':
    case 'SUCCEEDED':
      return 'success'
    case 'PARTIALLY_COMPLETED':
    case 'SKIPPED':
      return 'warning'
    case 'FAILED':
      return 'danger'
    case 'PENDING':
    case 'QUEUED':
    case 'IN_PROGRESS':
    case 'PROCESSING':
      return 'info'
    default:
      return 'neutral'
  }
}

/** The status glyph beside a job; decorative — the status is also written out in its pill. */
function StatusIcon({ status }: { status: string }) {
  const tone = s[statusTone(status)]
  const props = { size: 14, 'aria-hidden': true as const, className: tone }
  switch (status) {
    case 'COMPLETED':
    case 'SUCCEEDED':
      return <CheckCircle2 {...props} />
    case 'PARTIALLY_COMPLETED':
      return <AlertCircle {...props} />
    case 'FAILED':
      return <XCircle {...props} />
    case 'CANCELLED':
      return <Ban {...props} />
    case 'SKIPPED':
      return <SkipForward {...props} />
    case 'IN_PROGRESS':
      return <Loader2 {...props} className={`${tone} ${s.spin}`} />
    default:
      return <Clock {...props} />
  }
}

const statusLabel = (status: string) => status.replace(/_/g, ' ')

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
  const [retrying, setRetrying] = useState(false)
  const [retryNotice, setRetryNotice] = useState<string | null>(null)
  // W10.3 — selected item for the diff drawer. null = drawer closed.
  const [drawerItem, setDrawerItem] = useState<ItemRow | null>(null)

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

  // POST /:id/retry-failed → creates a new job scoped to FAILED items,
  // then POST /:newId/process to start it. The user sees a toast-style
  // notice with the new job's name; the new job will surface in the
  // Active Jobs strip on /bulk-operations and at the top of /history
  // once it lands a row.
  const retryFailed = useCallback(async () => {
    setRetrying(true)
    setError(null)
    setRetryNotice(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/bulk-operations/${jobId}/retry-failed`,
        { method: 'POST' },
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const newJob = body.job
      // Kick off processing on the new job.
      await fetch(
        `${getBackendUrl()}/api/bulk-operations/${newJob.id}/process`,
        { method: 'POST' },
      )
      setRetryNotice(
        `Retry job started: "${newJob.jobName}" (${newJob.totalItems} items)`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRetrying(false)
    }
  }, [jobId])

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
    <div className={s.panel}>
      <div className={s.panelBar}>
        <div className={s.chips} role="group" aria-label="Show items">
          {ITEM_FILTERS.map((f) => (
            <FilterChip key={f.key} pressed={statusFilter === f.key} count={f.count} onClick={() => setStatusFilter(f.key)}>
              {f.label}
            </FilterChip>
          ))}
        </div>
        <div className={s.panelActions}>
          {counts.FAILED > 0 && (
            <Button
              variant="danger-outline"
              size="sm"
              onClick={retryFailed}
              disabled={retrying}
              title={`Create a new job that re-runs only the ${counts.FAILED} failed items`}
            >
              <RotateCw size={12} aria-hidden className={retrying ? s.spin : undefined} />
              {retrying ? 'Starting retry…' : `Retry ${counts.FAILED} failed`}
            </Button>
          )}
          <Button variant="quiet" size="sm" onClick={fetchItems} disabled={loading}>
            <RefreshCw size={12} aria-hidden className={loading ? s.spin : undefined} />
            Refresh
          </Button>
        </div>
      </div>

      {retryNotice && <Banner tone="success">{retryNotice}</Banner>}
      {error && <Banner tone="danger">{error}</Banner>}

      {loading && !items && (
        <div className={s.items} aria-busy="true" aria-label="Loading history items">
          {[1, 2, 3].map((i) => (
            <div key={i} className={s.item}>
              <Skeleton width="60%" />
            </div>
          ))}
        </div>
      )}

      {items && items.length === 0 && !loading && <p className={s.none}>No items match this filter.</p>}

      {items && items.length > 0 && (
        <>
          <div className={s.itemsHead} aria-hidden>
            <span>Status</span>
            <span>Target</span>
            <span>Before → After</span>
            <span>Duration · When</span>
          </div>
          <ul className={s.items}>
            {items.map((it) => {
              const changed = diffEntries(it.beforeState, it.afterState).filter((d) => d.changed)
              return (
                <li key={it.id} className={s.item}>
                  <div className={s.itemStatus}>
                    <Pill tone={statusTone(it.status)} icon={<StatusIcon status={it.status} />}>{it.status}</Pill>
                  </div>
                  <div className={s.itemTarget}>
                    <span className={s.sku}>{it.sku ?? '(deleted)'}</span>
                    {it.channelLabel && <span className={s.subtle}>{it.channelLabel}</span>}
                  </div>
                  <div className={s.itemChange}>
                    {it.errorMessage ? (
                      <ItemMessageText status={it.status} message={it.errorMessage} />
                    ) : changed.length === 0 ? (
                      <span className={s.subtle}>no change</span>
                    ) : (
                      <dl className={s.diffs}>
                        {changed.map((d) => (
                          <div key={d.key} className={s.diff}>
                            <dt>{d.key}</dt>
                            <dd>
                              <span className={s.before}>{formatStateValue(d.before)}</span>
                              <ArrowRight size={12} aria-hidden className={s.arrow} />
                              <span className="nds-vh"> changed to </span>
                              <span className={s.after}>{formatStateValue(d.after)}</span>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                  <div className={s.itemMeta}>
                    <span>{formatDurationMs(it.durationMs)}</span>
                    <span>{relativeTime(it.completedAt ?? it.createdAt)}</span>
                    <Button variant="link" size="sm" inline onClick={() => setDrawerItem(it)} aria-label={`View full payload for ${it.sku ?? 'deleted item'}`}>
                      View
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}

      <ItemDiffDrawer item={drawerItem} onClose={() => setDrawerItem(null)} />
    </div>
  )
}

// ── Per-item diff drawer ──────────────────────────────────────────
//
// W10.3 — side panel showing the full beforeState / afterState
// JSON for a single BulkActionItem, plus its metadata (target,
// status, durationMs, and its message: the error of a FAILED item,
// the reason of a SKIPPED one — ItemMessage.tsx). The inline table only shows changed
// keys — operators that need to inspect the complete payload (eg.
// to confirm a missing key wasn't touched) open this drawer.

function ItemDiffDrawer({
  item,
  onClose,
}: {
  item: ItemRow | null
  onClose: () => void
}) {
  return (
    <Drawer open={item !== null} onClose={onClose} width={640} title={item ? `Item — ${item.sku ?? '(deleted)'}` : ''}>
      {item && (
        <div className={s.drawerBody}>
          <KeyValue
            columns={2}
            items={[
              { label: 'Status', value: <Pill tone={statusTone(item.status)} icon={<StatusIcon status={item.status} />}>{item.status}</Pill> },
              { label: 'Duration', value: formatDurationMs(item.durationMs) },
              { label: 'Target', value: <span className={s.sku}>{item.sku ?? '(deleted)'}</span>, hint: item.channelLabel ?? undefined },
            ]}
          />
          {item.errorMessage && <ItemMessageBanner status={item.status} message={item.errorMessage} />}
          <div className={s.states}>
            <section>
              <h3 className={s.stateHead}>Before</h3>
              <pre className={s.code}>{item.beforeState ? JSON.stringify(item.beforeState, null, 2) : '(empty)'}</pre>
            </section>
            <section>
              <h3 className={s.stateHead}>After</h3>
              <pre className={s.code}>{item.afterState ? JSON.stringify(item.afterState, null, 2) : '(empty)'}</pre>
            </section>
          </div>
        </div>
      )}
    </Drawer>
  )
}

// ── Job card ───────────────────────────────────────────────────────

// Rollback button visible when:
//   - status is COMPLETED or PARTIALLY_COMPLETED
//   - isRollbackable=true (default for non-rollback jobs)
//   - rollbackJobId is null (not yet rolled back)
//   - actionType is a backend-supported one (M.13: PRICING /
//     INVENTORY / STATUS / ATTRIBUTE — matches the SUPPORTED set
//     in bulk-action.service.rollbackBulkActionJob)
const ROLLBACK_SUPPORTED_TYPES = new Set([
  'PRICING_UPDATE',
  'INVENTORY_UPDATE',
  'STATUS_UPDATE',
  'ATTRIBUTE_UPDATE',
])

function isRollbackEligible(job: JobRow): boolean {
  if (job.status !== 'COMPLETED' && job.status !== 'PARTIALLY_COMPLETED') return false
  if (!job.isRollbackable) return false
  if (job.rollbackJobId) return false
  if (!ROLLBACK_SUPPORTED_TYPES.has(job.actionType)) return false
  return true
}

function JobCard({ job, onChanged }: { job: JobRow; onChanged: () => Promise<void> | void }) {
  const [expanded, setExpanded] = useState(false)
  const [rollingBack, setRollingBack] = useState(false)
  const duration = durationMs(job.startedAt, job.completedAt)
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const eligible = isRollbackEligible(job)

  const handleRollback = async () => {
    const confirmed = await askConfirm({
      title: `Roll back "${job.jobName}"?`,
      description:
        "This applies each item's saved beforeState (basePrice / totalStock / status) back through the master cascade. Creates a new audit job linked to this one.",
      confirmLabel: 'Roll back',
      tone: 'warning',
    })
    if (!confirmed) return
    setRollingBack(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/bulk-operations/${job.id}/rollback`,
        { method: 'POST' },
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      const parts = [`${body.succeeded} reverted`]
      if (body.failed > 0) parts.push(`${body.failed} failed`)
      if (body.skipped > 0) parts.push(`${body.skipped} skipped`)
      toast(`Rollback complete: ${parts.join(' · ')}`, 'success')
      await onChanged()
    } catch (err) {
      toast(`Rollback failed: ${err instanceof Error ? err.message : String(err)}`, 'danger')
    } finally {
      setRollingBack(false)
    }
  }

  const panelId = `bulk-job-items-${job.id}`
  return (
    <li className={s.job}>
      {/* One row per job. The row itself opens the items (a real button, PressableRow); Rollback sits in
          the row's own actions, never inside that button — the old card nested a button in a button. */}
      <PressableRow
        stacked
        expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        leading={
          <span className={s.leading}>
            {expanded ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
            <StatusIcon status={job.status} />
          </span>
        }
        label={<span className={s.jobName}>{job.jobName}</span>}
        actions={
          eligible ? (
            <Button
              variant="warning"
              size="sm"
              onClick={handleRollback}
              disabled={rollingBack}
              title="Apply each item's beforeState (basePrice / totalStock / status) back through the master cascade"
            >
              {rollingBack ? <Loader2 size={14} aria-hidden className={s.spin} /> : <RotateCw size={14} aria-hidden />}
              Rollback
            </Button>
          ) : undefined
        }
      >
        <span className={s.tags}>
          <Pill tone={statusTone(job.status)}>{statusLabel(job.status)}</Pill>
          <Pill tone="neutral">{formatActionType(job.actionType)}</Pill>
          {job.channel && <Pill tone="info">{job.channel}</Pill>}
          {job.rollbackJobId && <Pill tone="warning">Rolled back</Pill>}
        </span>
        <span className={s.meta}>
          <span>
            <strong className={s.processed}>{job.processedItems}</strong> / {job.totalItems} processed
          </span>
          {job.failedItems > 0 && <span className={s.failed}>{job.failedItems} failed</span>}
          {job.skippedItems > 0 && <span className={s.skipped}>{job.skippedItems} skipped</span>}
          {duration && <span>{duration}</span>}
          <span title={new Date(job.createdAt).toLocaleString()}>{relativeTime(job.createdAt)}</span>
          {job.createdByName && <span>by {job.createdByName}</span>}
        </span>
        {job.lastError && job.status !== 'COMPLETED' && <span className={s.jobError}>{job.lastError}</span>}
      </PressableRow>
      {expanded && (
        <div id={panelId}>
          <ItemsPanel jobId={job.id} />
        </div>
      )}
    </li>
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
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const [autoRefreshMin, setAutoRefreshMin] = useState<0 | 5 | 15>(0)

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
      setLastFetchedAt(Date.now())
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
    <div className={s.page}>
      <GridToolbar
        quickFilterSlot={
          <div className={s.chips} role="group" aria-label="Show jobs">
            {STATUS_FILTERS.map((f) => (
              <FilterChip key={f.key} pressed={statusFilter === f.key} onClick={() => setStatusFilter(f.key)}>
                {f.label}
              </FilterChip>
            ))}
          </div>
        }
        autoRefresh={<AutoRefreshSelect value={autoRefreshMin} onChange={setAutoRefreshMin} onTick={fetchJobs} />}
        freshness={<FreshnessIndicator lastFetchedAt={lastFetchedAt} onRefresh={fetchJobs} loading={loading} />}
      />

      {error && <Banner tone="danger" title="Failed to load the job history">{error}</Banner>}

      {loading && !jobs && (
        <div className={s.jobs} aria-busy="true" aria-label="Loading bulk-action jobs">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className={s.skeletonJob}>
              <Skeleton width="45%" />
              <Skeleton width="70%" />
            </div>
          ))}
        </div>
      )}

      {jobs && jobs.length === 0 && !loading && (
        <EmptyState
          icon={<HistoryIcon size={20} aria-hidden />}
          title={statusFilter === 'all' ? 'No bulk operations yet' : 'No jobs match this filter'}
          description={
            statusFilter === 'all'
              ? 'Run a bulk operation from /bulk-operations and it will show up here for review.'
              : 'Try a different filter or wait for jobs to land in this state.'
          }
          action={
            statusFilter === 'all' ? (
              <Button asChild>
                <Link href="/bulk-operations">Open Bulk Operations</Link>
              </Button>
            ) : undefined
          }
        />
      )}

      {jobs && jobs.length > 0 && (
        <ul className={s.jobs}>
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} onChanged={fetchJobs} />
          ))}
        </ul>
      )}
    </div>
  )
}
