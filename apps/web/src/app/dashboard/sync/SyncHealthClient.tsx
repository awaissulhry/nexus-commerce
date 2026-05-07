'use client'

/**
 * H.13 — sync health dashboard client.
 *
 * Five sections, top to bottom:
 *
 * 1. Headline strip: 24h success / fail / error rate. Tone shifts
 *    from emerald → amber → rose as the error rate climbs past
 *    1% / 5%. The number that matters most when triaging.
 *
 * 2. Queue card: pending / in-flight / failed counts plus the
 *    oldest pending row's age. When OutboundSyncQueue rows pile up
 *    older than ~10 min, something is stuck.
 *
 * 3. Channels grid: one card per ChannelConnection with status
 *    pill (ok / warn / fail / inactive), last sync, 24h error
 *    count, last error message (truncated).
 *
 * 4. Recent errors table: merged stream of SyncError +
 *    SyncLog(FAILED), newest 20. Click-through on the productId
 *    when present opens the product drawer.
 *
 * 5. Refresh + auto-polling: 30s tick keeps the page live during a
 *    triage session without burning the API. Server caches the
 *    response for 30s so polling is sub-cent.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Clock,
  Boxes,
  ExternalLink,
  Loader2,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface QueueStats {
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

interface Logs24h {
  successful: number
  failed: number
  total: number
  errorRate: number
}

interface ChannelStatus {
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
}

interface RecentError {
  id: string
  kind: 'sync-error' | 'sync-log'
  when: string
  channel: string
  type: string
  message: string
  productId: string | null
  context: unknown
}

interface HealthRollup {
  generatedAt: string
  queue: QueueStats
  logs24h: Logs24h
  channels: ChannelStatus[]
  recentErrors: RecentError[]
}

const POLL_MS = 30_000

function fmtMs(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

function fmtRelative(iso: string): string {
  return fmtMs(Date.now() - new Date(iso).getTime()) + ' ago'
}

const STATUS_TONE: Record<
  ChannelStatus['status'],
  { dot: string; bg: string; text: string }
> = {
  ok: {
    dot: 'bg-emerald-500',
    bg: 'bg-emerald-50 border-emerald-200',
    text: 'text-emerald-700',
  },
  warn: {
    dot: 'bg-amber-500',
    bg: 'bg-amber-50 border-amber-200',
    text: 'text-amber-700',
  },
  fail: {
    dot: 'bg-rose-500',
    bg: 'bg-rose-50 border-rose-200',
    text: 'text-rose-700',
  },
  inactive: {
    dot: 'bg-slate-300',
    bg: 'bg-slate-50 border-slate-200',
    text: 'text-slate-500',
  },
}

export default function SyncHealthClient({
  initial,
}: {
  initial: HealthRollup | null
}) {
  const [data, setData] = useState<HealthRollup | null>(initial)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/dashboard/health`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
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

  if (!data) {
    return (
      <div className="px-6 py-12 text-center text-base text-slate-400 italic">
        <Loader2 className="w-4 h-4 animate-spin inline mr-1.5" />
        Loading sync health…
      </div>
    )
  }

  const errorRatePct = data.logs24h.errorRate * 100
  const headlineTone =
    errorRatePct >= 5
      ? 'border-rose-200 bg-rose-50/40'
      : errorRatePct >= 1
        ? 'border-amber-200 bg-amber-50/40'
        : 'border-emerald-200 bg-emerald-50/40'

  const stuckThresholdMs = 10 * 60 * 1000
  const queueStuck =
    data.queue.oldestPending != null &&
    data.queue.oldestPending.ageMs > stuckThresholdMs

  return (
    <div className="space-y-5 max-w-[1200px] mx-auto">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 inline-flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-600" />
            Sync health
          </h1>
          <p className="text-base text-slate-500 mt-1 max-w-2xl">
            Single screen for &ldquo;what&apos;s broken right now.&rdquo;
            Queue depth, per-channel status, and recent errors. Polls
            every 30 seconds.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="h-8 px-3 text-base border border-slate-200 rounded hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          Refresh
        </button>
      </header>

      {error && (
        <div className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800">
          {error}
        </div>
      )}

      {/* Headline 24h roll-up */}
      <section
        className={`border rounded-md px-4 py-3 grid grid-cols-1 md:grid-cols-4 gap-3 ${headlineTone}`}
      >
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wider">
            24h sync calls
          </div>
          <div className="text-[20px] font-semibold tabular-nums text-slate-900">
            {data.logs24h.total.toLocaleString()}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wider">
            Successful
          </div>
          <div className="text-[20px] font-semibold tabular-nums text-emerald-700">
            {data.logs24h.successful.toLocaleString()}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wider">
            Failed
          </div>
          <div className="text-[20px] font-semibold tabular-nums text-rose-700">
            {data.logs24h.failed.toLocaleString()}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wider">
            Error rate
          </div>
          <div className="text-[20px] font-semibold tabular-nums text-slate-900">
            {errorRatePct.toFixed(1)}%
          </div>
        </div>
      </section>

      {/* Queue + channels: side by side on wide */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Queue card */}
        <div
          className={`border rounded-md p-3 ${
            queueStuck
              ? 'border-rose-200 bg-rose-50/40'
              : data.queue.failed > 0
                ? 'border-amber-200 bg-amber-50/40'
                : 'border-slate-200 bg-white'
          }`}
        >
          <div className="text-sm font-semibold text-slate-700 uppercase tracking-wider inline-flex items-center gap-1.5 mb-2">
            <Boxes className="w-3 h-3" /> Outbound queue
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-xs text-slate-500 uppercase tracking-wider">
                Pending
              </div>
              <div className="text-2xl font-semibold tabular-nums text-slate-900">
                {data.queue.pending}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 uppercase tracking-wider">
                In flight
              </div>
              <div className="text-2xl font-semibold tabular-nums text-slate-900">
                {data.queue.inFlight}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500 uppercase tracking-wider">
                Failed
              </div>
              <div className="text-2xl font-semibold tabular-nums text-rose-700">
                {data.queue.failed}
              </div>
            </div>
          </div>
          {data.queue.oldestPending && (
            <div
              className={`mt-2 pt-2 border-t border-slate-100 text-sm flex items-center gap-1.5 ${
                queueStuck ? 'text-rose-700' : 'text-slate-500'
              }`}
            >
              <Clock className="w-3 h-3" />
              Oldest pending: {fmtMs(data.queue.oldestPending.ageMs)}
              {queueStuck && (
                <span className="font-medium ml-auto">— stuck</span>
              )}
            </div>
          )}
        </div>

        {/* Channels card */}
        <div className="lg:col-span-2 border border-slate-200 rounded-md bg-white">
          <div className="px-3 py-2 border-b border-slate-100 text-sm font-semibold text-slate-700 uppercase tracking-wider">
            Channels
          </div>
          {data.channels.length === 0 ? (
            <div className="p-4 text-base text-slate-400 italic text-center">
              No channel connections configured.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {data.channels.map((c) => {
                const tone = STATUS_TONE[c.status]
                return (
                  <div
                    key={c.id}
                    className="px-3 py-2 flex items-center gap-3"
                  >
                    <span
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${tone.dot}`}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-base font-medium text-slate-900">
                        {c.channel}
                        {c.marketplace ? ` · ${c.marketplace}` : ''}
                        {c.displayName && (
                          <span className="ml-2 text-xs text-slate-500 font-normal">
                            {c.displayName}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
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
                            <span className="text-rose-700">
                              {c.errors24h} error
                              {c.errors24h === 1 ? '' : 's'} 24h
                            </span>
                          </>
                        )}
                      </div>
                      {c.lastSyncError && (
                        <div className="text-xs text-rose-700 mt-0.5 truncate">
                          {c.lastSyncError}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Recent errors */}
      <section className="border border-slate-200 rounded-md bg-white">
        <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-700 uppercase tracking-wider inline-flex items-center gap-1.5">
            <AlertCircle className="w-3 h-3" /> Recent errors
          </div>
          <span className="text-xs text-slate-500">last 20</span>
        </div>
        {data.recentErrors.length === 0 ? (
          <div className="p-6 text-center text-base text-slate-500">
            <CheckCircle2 className="w-5 h-5 mx-auto text-emerald-500 mb-1.5" />
            No errors in the recent window.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wider w-20">
                  When
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wider w-24">
                  Channel
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wider w-32">
                  Type
                </th>
                <th className="px-3 py-1.5 text-left font-semibold text-slate-700 uppercase tracking-wider">
                  Message
                </th>
                <th className="px-3 py-1.5 text-right font-semibold text-slate-700 uppercase tracking-wider w-12">
                  {''}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.recentErrors.map((e) => (
                <tr
                  key={e.id}
                  className="border-b border-slate-100 hover:bg-slate-50"
                >
                  <td className="px-3 py-1.5 text-slate-600">
                    {fmtRelative(e.when)}
                  </td>
                  <td className="px-3 py-1.5 text-slate-700 font-medium">
                    {e.channel}
                  </td>
                  <td className="px-3 py-1.5 text-slate-500 font-mono">
                    {e.type}
                  </td>
                  <td className="px-3 py-1.5 text-slate-700 truncate max-w-md">
                    {e.message}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {e.productId && (
                      <a
                        href={`/products?drawer=${e.productId}`}
                        className="text-slate-400 hover:text-slate-700 inline-flex"
                        title="Open product"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="text-xs text-slate-500 text-center pt-2">
        Generated {new Date(data.generatedAt).toLocaleTimeString()} · polls
        every 30 seconds
      </div>
    </div>
  )
}
