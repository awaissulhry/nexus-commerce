'use client'

/**
 * L.2.0 — /sync-logs hub client.
 *
 * Five sections, top to bottom:
 *
 *   1. KPI strip — 24h sync success rate, 24h errors, queue depth,
 *      audit-log volume, healthy-cron count. Tone-coded so a glance
 *      shows "is anything red right now?".
 *
 *   2. Channel matrix — per ChannelConnection status pill (ok/warn/
 *      fail/inactive), last sync timestamp, 24h error count. Sourced
 *      from /api/dashboard/health.
 *
 *   3. Cron status panel — most-recent run per cron job (status,
 *      duration, summary, age). Stale-RUNNING jobs flagged in red.
 *      Sourced from /api/dashboard/cron-runs.
 *
 *   4. Recent activity — last 15 AuditLog entries (entity type +
 *      action + ID + relative time). Sourced from /api/audit-log/search.
 *
 *   5. Deep-link rail — buttons to /audit-log, /outbound,
 *      /dashboard/sync, /dashboard/health for the dedicated surfaces.
 *
 * Polling: every 30s, mirroring /dashboard/sync's H.13 cadence. Cache
 * headers on the backend keep this sub-cent.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Activity,
  AlertCircle,
  Boxes,
  CheckCircle2,
  Clock,
  ExternalLink,
  History,
  Loader2,
  RefreshCw,
  Timer,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'

const POLL_MS = 30_000

// ── Types mirroring backend payloads ─────────────────────────────────

export interface HealthRollup {
  generatedAt: string
  queue: {
    pending: number
    inFlight: number
    failed: number
    total: number
    oldestPending: {
      id: string
      createdAt: string
      targetChannel: string
      ageMs: number
    } | null
  }
  logs24h: {
    successful: number
    failed: number
    total: number
    errorRate: number
  }
  channels: Array<{
    id: string
    channel: string
    marketplace: string | null
    managedBy: string
    isActive: boolean
    displayName: string | null
    lastSyncStatus: string | null
    lastSyncAt: string | null
    lastSyncError: string | null
    errors24h: number
    status: 'ok' | 'warn' | 'fail' | 'inactive'
  }>
  recentErrors: Array<{
    id: string
    kind: 'sync-error' | 'sync-log'
    when: string
    channel: string
    type: string
    message: string
    productId: string | null
    context: unknown
  }>
}

export interface CronRunsRollup {
  generatedAt: string
  latest: Array<{
    jobName: string
    startedAt: string
    finishedAt: string | null
    status: string
    errorMessage: string | null
    outputSummary: string | null
    triggeredBy: string
    durationMs: number | null
  }>
  staleRunning: Array<{
    id: string
    jobName: string
    startedAt: string
    triggeredBy: string
  }>
  recentFailures: Array<{
    id: string
    jobName: string
    startedAt: string
    finishedAt: string | null
    errorMessage: string | null
    triggeredBy: string
  }>
}

export interface AuditRollup {
  success: boolean
  items: Array<{
    id: string
    userId: string | null
    ip: string | null
    entityType: string
    entityId: string
    action: string
    createdAt: string
  }>
  nextCursor: string | null
  facets: {
    entityType: Array<{ value: string; count: number }>
    action: Array<{ value: string; count: number }>
  }
}

export interface ApiCallsRollup {
  generatedAt: string
  window: { since: string; until: string }
  stats: {
    total: number
    successful: number
    failed: number
    errorRate: number
    latencyP50Ms: number | null
    latencyP95Ms: number | null
    latencyP99Ms: number | null
  }
  byChannel: Array<{ channel: string; count: number }>
  byOperation: Array<{ operation: string; count: number }>
  errorsByType: Array<{ errorType: string; count: number }>
  statusCodes: Array<{ statusCode: number | null; count: number }>
  recent: Array<{
    id: string
    channel: string
    marketplace: string | null
    operation: string
    statusCode: number | null
    success: boolean
    latencyMs: number
    errorType: string | null
    errorMessage: string | null
    createdAt: string
    triggeredBy: string
  }>
}

interface InitialPayload {
  health: HealthRollup | null
  crons: CronRunsRollup | null
  audit: AuditRollup | null
  apiCalls: ApiCallsRollup | null
}

// ── Helpers ──────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

function fmtRelative(iso: string): string {
  return fmtMs(Date.now() - new Date(iso).getTime()) + ' ago'
}

const STATUS_TONE: Record<
  HealthRollup['channels'][number]['status'],
  { dot: string; text: string }
> = {
  ok: { dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400' },
  warn: { dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400' },
  fail: { dot: 'bg-rose-500', text: 'text-rose-700 dark:text-rose-400' },
  inactive: { dot: 'bg-slate-300', text: 'text-slate-500 dark:text-slate-500' },
}

const ACTION_VARIANT: Record<
  string,
  'success' | 'warning' | 'danger' | 'info' | 'default'
> = {
  create: 'success',
  update: 'info',
  delete: 'danger',
  submit: 'warning',
  replicate: 'info',
}

// ── Client ───────────────────────────────────────────────────────────

export default function SyncLogsHubClient({
  initial,
}: {
  initial: InitialPayload
}) {
  const [health, setHealth] = useState<HealthRollup | null>(initial.health)
  const [crons, setCrons] = useState<CronRunsRollup | null>(initial.crons)
  const [audit, setAudit] = useState<AuditRollup | null>(initial.audit)
  const [apiCalls, setApiCalls] = useState<ApiCallsRollup | null>(
    initial.apiCalls,
  )
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const backend = getBackendUrl()
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const [hRes, cRes, aRes, apiRes] = await Promise.all([
        fetch(`${backend}/api/dashboard/health`, { cache: 'no-store' }),
        fetch(`${backend}/api/dashboard/cron-runs`, { cache: 'no-store' }),
        fetch(
          `${backend}/api/audit-log/search?limit=15&since=${encodeURIComponent(since)}`,
          { cache: 'no-store' },
        ),
        fetch(
          `${backend}/api/sync-logs/api-calls?since=${encodeURIComponent(since)}`,
          { cache: 'no-store' },
        ),
      ])
      if (hRes.ok) setHealth(await hRes.json())
      if (cRes.ok) setCrons(await cRes.json())
      if (aRes.ok) setAudit(await aRes.json())
      if (apiRes.ok) setApiCalls(await apiRes.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    const id = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  const errorRatePct = health ? health.logs24h.errorRate * 100 : 0
  const cronJobs = crons?.latest ?? []
  const cronHealthy = cronJobs.filter((j) => j.status === 'SUCCESS').length
  const cronUnhealthy = cronJobs.filter((j) => j.status === 'FAILED').length
  const cronRunning = cronJobs.filter((j) => j.status === 'RUNNING').length
  const cronStale = crons?.staleRunning.length ?? 0

  const apiStats = apiCalls?.stats
  const apiErrorRatePct = apiStats ? apiStats.errorRate * 100 : 0

  const hasNoData = !health && !crons && !audit && !apiCalls

  return (
    <div className="space-y-5">
      {/* Header bar with refresh + deep-links */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/audit-log">
            <Button variant="secondary" size="sm">
              <History className="w-3.5 h-3.5" />
              Audit log
            </Button>
          </Link>
          <Link href="/outbound">
            <Button variant="secondary" size="sm">
              <Boxes className="w-3.5 h-3.5" />
              Outbound queue
            </Button>
          </Link>
          <Link href="/sync-logs/errors">
            <Button variant="secondary" size="sm">
              <AlertCircle className="w-3.5 h-3.5" />
              Error groups
            </Button>
          </Link>
          <Link href="/sync-logs/webhooks">
            <Button variant="secondary" size="sm">
              <History className="w-3.5 h-3.5" />
              Webhooks
            </Button>
          </Link>
          <Link href="/dashboard/health">
            <Button variant="secondary" size="sm">
              <Activity className="w-3.5 h-3.5" />
              Sync health detail
            </Button>
          </Link>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          {refreshing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Refresh
        </Button>
      </div>

      {error && (
        <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-800 dark:text-rose-300 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {hasNoData ? (
        <EmptyState
          icon={Activity}
          title="No observability data yet"
          description="The hub aggregates channel sync status, cron runs, and the audit trail. Once any cron ticks or any mutation hits the platform, this view populates."
        />
      ) : (
        <>
          {/* ── KPI strip ───────────────────────────────────────── */}
          {/* Reads OutboundApiCallLog (apiStats) — populated once L.3.2/L.3.3
              instrumentation reaches production. Falls back to SyncLog-based
              health.logs24h until then. */}
          <section
            className={`border rounded-md px-4 py-3 grid grid-cols-2 md:grid-cols-5 gap-3 ${
              apiErrorRatePct >= 5 || errorRatePct >= 5
                ? 'border-rose-200 dark:border-rose-900 bg-rose-50/40 dark:bg-rose-950/40'
                : apiErrorRatePct >= 1 || errorRatePct >= 1
                  ? 'border-amber-200 dark:border-amber-900 bg-amber-50/40 dark:bg-amber-950/40'
                  : 'border-emerald-200 dark:border-emerald-900 bg-emerald-50/40 dark:bg-emerald-950/40'
            }`}
          >
            <Kpi
              label="24h API calls"
              value={apiStats?.total ?? health?.logs24h.total ?? 0}
              tone="default"
            />
            <Kpi
              label="24h errors"
              value={apiStats?.failed ?? health?.logs24h.failed ?? 0}
              tone={
                (apiStats?.failed ?? health?.logs24h.failed ?? 0) === 0
                  ? 'good'
                  : 'bad'
              }
            />
            <Kpi
              label="Latency p95"
              value={
                apiStats?.latencyP95Ms !== null &&
                apiStats?.latencyP95Ms !== undefined
                  ? `${apiStats.latencyP95Ms}ms`
                  : '—'
              }
              hint={
                apiStats?.latencyP99Ms !== null &&
                apiStats?.latencyP99Ms !== undefined
                  ? `p99 ${apiStats.latencyP99Ms}ms`
                  : undefined
              }
              tone={
                apiStats?.latencyP95Ms == null
                  ? 'default'
                  : apiStats.latencyP95Ms > 5000
                    ? 'bad'
                    : apiStats.latencyP95Ms > 2000
                      ? 'warn'
                      : 'good'
              }
            />
            <Kpi
              label="Outbound queue"
              value={health?.queue.total ?? 0}
              hint={
                health?.queue.failed
                  ? `${health.queue.failed} failed`
                  : health?.queue.pending
                    ? `${health.queue.pending} pending`
                    : undefined
              }
              tone={
                (health?.queue.failed ?? 0) > 0
                  ? 'bad'
                  : (health?.queue.pending ?? 0) > 0
                    ? 'warn'
                    : 'good'
              }
            />
            <Kpi
              label="Cron jobs"
              value={cronJobs.length}
              hint={
                cronStale > 0
                  ? `${cronStale} stuck`
                  : cronUnhealthy > 0
                    ? `${cronUnhealthy} failed`
                    : `${cronHealthy} healthy`
              }
              tone={
                cronStale > 0 || cronUnhealthy > 0
                  ? 'bad'
                  : cronRunning > 0
                    ? 'warn'
                    : 'good'
              }
            />
          </section>

          {/* ── Two-column body: channels + crons ────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <section className="border border-slate-200 dark:border-slate-800 rounded-md bg-white dark:bg-slate-900">
              <header className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider inline-flex items-center gap-1.5">
                  <Activity className="w-3 h-3" /> Channels
                </h2>
                <Link
                  href="/dashboard/health"
                  className="text-xs text-slate-500 dark:text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 inline-flex items-center gap-1"
                >
                  Detail <ExternalLink className="w-3 h-3" />
                </Link>
              </header>
              {!health || health.channels.length === 0 ? (
                <div className="p-4 text-base text-slate-400 dark:text-slate-500 italic text-center">
                  No channel connections configured.
                </div>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {health.channels.map((c) => {
                    const tone = STATUS_TONE[c.status]
                    return (
                      <li
                        key={c.id}
                        className="px-3 py-2 flex items-center gap-3"
                      >
                        <span
                          className={`w-2 h-2 rounded-full flex-shrink-0 ${tone.dot}`}
                          aria-hidden
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-base font-medium text-slate-900 dark:text-slate-100 truncate">
                            {c.channel}
                            {c.marketplace ? ` · ${c.marketplace}` : ''}
                            {c.displayName && (
                              <span className="ml-2 text-xs text-slate-500 dark:text-slate-500 font-normal">
                                {c.displayName}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                            <span className={tone.text}>
                              {c.status.toUpperCase()}
                            </span>
                            {c.lastSyncAt && (
                              <>
                                <span className="text-slate-300">·</span>
                                <span>
                                  last sync {fmtRelative(c.lastSyncAt)}
                                </span>
                              </>
                            )}
                            {c.errors24h > 0 && (
                              <>
                                <span className="text-slate-300">·</span>
                                <span className="text-rose-700 dark:text-rose-400">
                                  {c.errors24h} error
                                  {c.errors24h === 1 ? '' : 's'} 24h
                                </span>
                              </>
                            )}
                          </div>
                          {c.lastSyncError && (
                            <div
                              className="text-xs text-rose-700 dark:text-rose-400 mt-0.5 truncate"
                              title={c.lastSyncError}
                            >
                              {c.lastSyncError}
                            </div>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            <section className="border border-slate-200 dark:border-slate-800 rounded-md bg-white dark:bg-slate-900">
              <header className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider inline-flex items-center gap-1.5">
                  <Timer className="w-3 h-3" /> Cron jobs
                </h2>
                <span className="text-xs text-slate-500 dark:text-slate-500">
                  {cronJobs.length} known
                  {cronStale > 0 && (
                    <span className="ml-2 text-rose-700 dark:text-rose-400 font-medium">
                      {cronStale} stuck
                    </span>
                  )}
                </span>
              </header>
              {cronJobs.length === 0 ? (
                <div className="p-4 text-base text-slate-400 dark:text-slate-500 italic text-center">
                  No cron runs recorded yet — wait for the next tick.
                </div>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[420px] overflow-y-auto">
                  {cronJobs.map((j) => (
                    <li
                      key={j.jobName}
                      className="px-3 py-2 flex items-center gap-3"
                    >
                      <span
                        className={`w-2 h-2 rounded-full flex-shrink-0 ${
                          j.status === 'SUCCESS'
                            ? 'bg-emerald-500'
                            : j.status === 'FAILED'
                              ? 'bg-rose-500'
                              : j.status === 'RUNNING'
                                ? 'bg-blue-500 animate-pulse'
                                : 'bg-slate-300'
                        }`}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-base font-mono text-slate-900 dark:text-slate-100 truncate">
                            {j.jobName}
                          </span>
                          {j.triggeredBy === 'manual' && (
                            <Badge variant="info" size="sm">
                              manual
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                          <span>{fmtRelative(j.startedAt)}</span>
                          {j.durationMs !== null && (
                            <>
                              <span className="text-slate-300">·</span>
                              <span>
                                <Clock className="inline w-3 h-3 mr-0.5" />
                                {fmtMs(j.durationMs)}
                              </span>
                            </>
                          )}
                        </div>
                        {j.outputSummary && j.status === 'SUCCESS' && (
                          <div className="text-xs text-slate-500 dark:text-slate-500 mt-0.5 truncate font-mono">
                            {j.outputSummary}
                          </div>
                        )}
                        {j.errorMessage && (
                          <div
                            className="text-xs text-rose-700 dark:text-rose-400 mt-0.5 truncate"
                            title={j.errorMessage}
                          >
                            {j.errorMessage}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* ── API calls ─────────────────────────────────────────── */}
          {apiCalls && apiCalls.stats.total > 0 && (
            <section className="border border-slate-200 dark:border-slate-800 rounded-md bg-white dark:bg-slate-900">
              <header className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2 flex-wrap">
                <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider inline-flex items-center gap-1.5">
                  <Activity className="w-3 h-3" /> Outbound API calls (24h)
                </h2>
                <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-500">
                  <span>
                    {apiCalls.stats.total.toLocaleString()} total ·{' '}
                    {apiCalls.stats.failed.toLocaleString()} failed ·{' '}
                    {(apiCalls.stats.errorRate * 100).toFixed(2)}% error rate
                  </span>
                  <Link
                    href="/sync-logs/api-calls"
                    className="text-slate-500 dark:text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 inline-flex items-center gap-1"
                  >
                    Drill down <ExternalLink className="w-3 h-3" />
                  </Link>
                </div>
              </header>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-0 divide-x divide-slate-100 dark:divide-slate-800 border-b border-slate-100 dark:border-slate-800">
                {/* By channel */}
                <div className="px-3 py-2">
                  <div className="text-xs text-slate-500 dark:text-slate-500 uppercase tracking-wider mb-1.5">
                    By channel
                  </div>
                  {apiCalls.byChannel.length === 0 ? (
                    <div className="text-sm text-slate-400 dark:text-slate-500 italic">none</div>
                  ) : (
                    <ul className="space-y-1">
                      {apiCalls.byChannel.map((c) => (
                        <li
                          key={c.channel}
                          className="text-sm flex justify-between"
                        >
                          <span className="font-medium text-slate-700 dark:text-slate-300">
                            {c.channel}
                          </span>
                          <span className="font-mono text-slate-500 dark:text-slate-500">
                            {c.count.toLocaleString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* By operation (top 5) */}
                <div className="px-3 py-2">
                  <div className="text-xs text-slate-500 dark:text-slate-500 uppercase tracking-wider mb-1.5">
                    Top operations
                  </div>
                  {apiCalls.byOperation.length === 0 ? (
                    <div className="text-sm text-slate-400 dark:text-slate-500 italic">none</div>
                  ) : (
                    <ul className="space-y-1">
                      {apiCalls.byOperation.slice(0, 5).map((o) => (
                        <li
                          key={o.operation}
                          className="text-sm flex justify-between gap-2"
                        >
                          <span className="font-mono text-slate-700 dark:text-slate-300 truncate">
                            {o.operation}
                          </span>
                          <span className="font-mono text-slate-500 dark:text-slate-500 whitespace-nowrap">
                            {o.count.toLocaleString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Errors by type */}
                <div className="px-3 py-2">
                  <div className="text-xs text-slate-500 dark:text-slate-500 uppercase tracking-wider mb-1.5">
                    Errors by type
                  </div>
                  {apiCalls.errorsByType.length === 0 ? (
                    <div className="text-sm text-slate-400 dark:text-slate-500 italic">
                      <CheckCircle2 className="inline w-3 h-3 text-emerald-500 mr-1" />
                      no failures
                    </div>
                  ) : (
                    <ul className="space-y-1">
                      {apiCalls.errorsByType.map((e) => (
                        <li
                          key={e.errorType}
                          className="text-sm flex justify-between"
                        >
                          <Badge
                            variant={
                              e.errorType === 'AUTHENTICATION'
                                ? 'danger'
                                : e.errorType === 'RATE_LIMIT'
                                  ? 'warning'
                                  : e.errorType === 'SERVER'
                                    ? 'danger'
                                    : 'default'
                            }
                            size="sm"
                          >
                            {e.errorType}
                          </Badge>
                          <span className="font-mono text-rose-700 dark:text-rose-400">
                            {e.count.toLocaleString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {/* Recent calls */}
              {apiCalls.recent.length > 0 && (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[360px] overflow-y-auto">
                  {apiCalls.recent.map((c) => (
                    <li
                      key={c.id}
                      className="px-3 py-1.5 flex items-center gap-3 text-sm"
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          c.success ? 'bg-emerald-500' : 'bg-rose-500'
                        }`}
                        aria-hidden
                      />
                      <span className="text-xs text-slate-500 dark:text-slate-500 w-16 flex-shrink-0">
                        {fmtRelative(c.createdAt)}
                      </span>
                      <span className="font-semibold text-slate-700 dark:text-slate-300 w-16 flex-shrink-0">
                        {c.channel}
                      </span>
                      <span className="font-mono text-slate-700 dark:text-slate-300 w-48 flex-shrink-0 truncate">
                        {c.operation}
                      </span>
                      <span className="font-mono text-xs text-slate-500 dark:text-slate-500 w-12 flex-shrink-0">
                        {c.statusCode ?? '—'}
                      </span>
                      <span className="font-mono text-xs text-slate-500 dark:text-slate-500 w-14 flex-shrink-0 text-right">
                        {c.latencyMs}ms
                      </span>
                      {c.errorMessage && (
                        <span
                          className="text-xs text-rose-700 dark:text-rose-400 truncate flex-1"
                          title={c.errorMessage}
                        >
                          {c.errorMessage}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* ── Recent activity ──────────────────────────────────── */}
          <section className="border border-slate-200 dark:border-slate-800 rounded-md bg-white dark:bg-slate-900">
            <header className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider inline-flex items-center gap-1.5">
                <History className="w-3 h-3" /> Recent activity
              </h2>
              <Link
                href="/audit-log"
                className="text-xs text-slate-500 dark:text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 inline-flex items-center gap-1"
              >
                Full audit log <ExternalLink className="w-3 h-3" />
              </Link>
            </header>
            {!audit || audit.items.length === 0 ? (
              <div className="p-6 text-center text-base text-slate-500 dark:text-slate-500">
                <CheckCircle2 className="w-5 h-5 mx-auto text-emerald-500 mb-1.5" />
                No mutations in the last 24 hours.
              </div>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {audit.items.slice(0, 15).map((e) => (
                  <li
                    key={e.id}
                    className="px-3 py-2 flex items-center gap-3"
                  >
                    <Badge
                      variant={ACTION_VARIANT[e.action] ?? 'default'}
                      size="sm"
                    >
                      {e.action}
                    </Badge>
                    <span className="text-base font-medium text-slate-900 dark:text-slate-100">
                      {e.entityType}
                    </span>
                    <span className="font-mono text-sm text-slate-500 dark:text-slate-500 truncate">
                      {e.entityId.slice(0, 16)}
                      {e.entityId.length > 16 && '…'}
                    </span>
                    <span className="ml-auto text-xs text-slate-500 dark:text-slate-500 whitespace-nowrap">
                      {fmtRelative(e.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Recent errors (sync layer) ───────────────────────── */}
          {health && health.recentErrors.length > 0 && (
            <section className="border border-rose-200 dark:border-rose-900 rounded-md bg-white dark:bg-slate-900">
              <header className="px-3 py-2 border-b border-rose-100 dark:border-rose-900 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-rose-700 dark:text-rose-400 uppercase tracking-wider inline-flex items-center gap-1.5">
                  <AlertCircle className="w-3 h-3" /> Recent sync errors
                </h2>
                <span className="text-xs text-slate-500 dark:text-slate-500">
                  {health.recentErrors.length} shown
                </span>
              </header>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {health.recentErrors.slice(0, 10).map((e) => (
                  <li
                    key={e.id}
                    className="px-3 py-2 flex items-center gap-3"
                  >
                    <span className="text-xs text-slate-500 dark:text-slate-500 w-16 flex-shrink-0">
                      {fmtRelative(e.when)}
                    </span>
                    <span className="text-sm font-semibold text-slate-700 dark:text-slate-300 w-20 flex-shrink-0">
                      {e.channel}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-500 font-mono w-32 flex-shrink-0 truncate">
                      {e.type}
                    </span>
                    <span
                      className="text-sm text-slate-700 dark:text-slate-300 truncate flex-1"
                      title={e.message}
                    >
                      {e.message}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="text-xs text-slate-500 dark:text-slate-500 text-center pt-2">
            Generated{' '}
            {health?.generatedAt
              ? new Date(health.generatedAt).toLocaleTimeString()
              : '—'}{' '}
            · polls every 30 seconds
          </div>
        </>
      )}
    </div>
  )
}

// ── Small KPI tile ───────────────────────────────────────────────────

function Kpi({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: string | number
  hint?: string
  tone?: 'good' | 'warn' | 'bad' | 'default'
}) {
  const valueClass =
    tone === 'good'
      ? 'text-emerald-700 dark:text-emerald-400'
      : tone === 'warn'
        ? 'text-amber-700 dark:text-amber-400'
        : tone === 'bad'
          ? 'text-rose-700 dark:text-rose-400'
          : 'text-slate-900 dark:text-slate-100'
  return (
    <div>
      <div className="text-xs text-slate-500 dark:text-slate-500 uppercase tracking-wider">
        {label}
      </div>
      <div className={`text-[20px] font-semibold tabular-nums ${valueClass}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {hint && <div className="text-xs text-slate-500 dark:text-slate-500 mt-0.5">{hint}</div>}
    </div>
  )
}
