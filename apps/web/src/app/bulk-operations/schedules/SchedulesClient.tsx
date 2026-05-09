'use client'

/**
 * W6.4 — Schedule management page.
 *
 * Browse / pause / resume / cancel surface for ScheduledBulkAction.
 * Pulls /api/scheduled-bulk-actions, lets the operator flip enabled
 * (pause / resume), delete (DELETE), and manually trigger the cron
 * tick (POST /scheduled-bulk-actions/tick). Each row drills back to
 * the most recent BulkActionJob via lastJobId.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ArrowRight,
  CalendarClock,
  Loader2,
  Pause,
  Play,
  PlayCircle,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface Schedule {
  id: string
  name: string
  description: string | null
  actionType: string
  channel: string | null
  scheduledFor: string | null
  cronExpression: string | null
  timezone: string
  nextRunAt: string | null
  enabled: boolean
  lastRunAt: string | null
  lastJobId: string | null
  lastStatus: string | null
  lastError: string | null
  runCount: number
  templateId: string | null
  createdAt: string
  updatedAt: string
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

function relative(iso: string | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diff = t - Date.now()
  const abs = Math.abs(diff)
  const min = Math.round(abs / 60_000)
  if (min < 60) return diff > 0 ? `in ${min}m` : `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 48) return diff > 0 ? `in ${hr}h` : `${hr}h ago`
  const d = Math.round(hr / 24)
  return diff > 0 ? `in ${d}d` : `${d}d ago`
}

function statusBadge(s: Schedule) {
  if (!s.enabled) {
    return <Badge variant="default" size="sm">Paused</Badge>
  }
  if (!s.nextRunAt) {
    return <Badge variant="default" size="sm">Exhausted</Badge>
  }
  if (s.cronExpression) {
    return <Badge variant="info" size="sm">Recurring</Badge>
  }
  return <Badge variant="info" size="sm">One-time</Badge>
}

export default function SchedulesClient() {
  const confirm = useConfirm()
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [tickRunning, setTickRunning] = useState(false)

  const fetchSchedules = useCallback(async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/scheduled-bulk-actions?limit=200`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setSchedules(Array.isArray(data.schedules) ? data.schedules : [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSchedules()
    // Refresh every 30s so an out-of-band tick (the W6.2 worker)
    // updates lastRunAt + nextRunAt without the operator
    // re-loading the page.
    const id = setInterval(fetchSchedules, 30_000)
    return () => clearInterval(id)
  }, [fetchSchedules])

  const setEnabled = async (id: string, enabled: boolean) => {
    setBusyId(id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/scheduled-bulk-actions/${id}/enabled`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      await fetchSchedules()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const deleteSchedule = async (s: Schedule) => {
    const ok = await confirm({
      title: `Delete schedule "${s.name}"?`,
      description:
        'The schedule will stop firing immediately. Past runs (BulkActionJob rows) are kept for audit.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    setBusyId(s.id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/scheduled-bulk-actions/${s.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      await fetchSchedules()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const fireTickNow = async () => {
    setTickRunning(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/scheduled-bulk-actions/tick`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      await fetchSchedules()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setTickRunning(false)
    }
  }

  const grouped = useMemo(() => {
    const due: Schedule[] = []
    const upcoming: Schedule[] = []
    const paused: Schedule[] = []
    const exhausted: Schedule[] = []
    const now = Date.now()
    for (const s of schedules) {
      if (!s.enabled) paused.push(s)
      else if (!s.nextRunAt) exhausted.push(s)
      else if (new Date(s.nextRunAt).getTime() <= now) due.push(s)
      else upcoming.push(s)
    }
    return { due, upcoming, paused, exhausted }
  }, [schedules])

  return (
    <div className="px-3 md:px-6 space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm text-slate-600 dark:text-slate-300 inline-flex items-center gap-1.5">
          <CalendarClock className="w-3.5 h-3.5 text-purple-500" />
          {schedules.length === 0
            ? 'No schedules yet — operators create them from the bulk-apply modal.'
            : `${schedules.length} schedule${schedules.length === 1 ? '' : 's'} · ` +
              `${grouped.due.length} due · ${grouped.upcoming.length} upcoming · ` +
              `${grouped.paused.length} paused · ${grouped.exhausted.length} exhausted`}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="secondary" size="sm" onClick={fetchSchedules} disabled={loading}>
            <RefreshCw className="w-3 h-3 mr-1" />
            Reload
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={fireTickNow}
            disabled={tickRunning || grouped.due.length === 0}
            loading={tickRunning}
            title={
              grouped.due.length > 0
                ? `Fire ${grouped.due.length} due schedule${grouped.due.length === 1 ? '' : 's'} now`
                : 'No schedules currently due'
            }
          >
            <PlayCircle className="w-3 h-3 mr-1" />
            Run tick now
          </Button>
        </div>
      </div>

      {error && (
        <div className="text-base text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2">
          {error}
        </div>
      )}

      {loading && schedules.length === 0 ? (
        <div className="text-sm text-slate-500 inline-flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading schedules…
        </div>
      ) : schedules.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-dashed border-slate-200 dark:border-slate-800 rounded p-6 text-center text-sm text-slate-500">
          No schedules yet. Open a bulk operation in the modal and toggle
          <strong className="mx-1">Schedule…</strong>
          to create your first.
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Name</th>
                <th className="text-left px-3 py-2 font-medium">Action</th>
                <th className="text-left px-3 py-2 font-medium">Cadence</th>
                <th className="text-left px-3 py-2 font-medium">Next run</th>
                <th className="text-left px-3 py-2 font-medium">Last run</th>
                <th className="text-right px-3 py-2 font-medium">Runs</th>
                <th className="text-right px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {schedules.map((s) => (
                <tr
                  key={s.id}
                  className={cn(
                    'hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors',
                    !s.enabled && 'opacity-60',
                  )}
                >
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-800 dark:text-slate-100 truncate max-w-[260px]">
                      {s.name}
                    </div>
                    {s.description && (
                      <div className="text-xs text-slate-500 truncate max-w-[260px]">
                        {s.description}
                      </div>
                    )}
                    <div className="mt-0.5">{statusBadge(s)}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-600 dark:text-slate-300">
                    {s.actionType.replace(/_/g, ' ')}
                    {s.channel && (
                      <span className="ml-1 text-slate-400">@ {s.channel}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {s.cronExpression ? (
                      <span className="font-mono text-slate-700 dark:text-slate-300">
                        {s.cronExpression}
                      </span>
                    ) : s.scheduledFor ? (
                      <span className="text-slate-600 dark:text-slate-300">
                        once @ {formatDateTime(s.scheduledFor)}
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                    <div className="text-[10px] text-slate-400">
                      tz: {s.timezone}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div className="text-slate-700 dark:text-slate-200 tabular-nums">
                      {formatDateTime(s.nextRunAt)}
                    </div>
                    {s.nextRunAt && (
                      <div className="text-[10px] text-slate-500">
                        {relative(s.nextRunAt)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div className="text-slate-600 dark:text-slate-300 tabular-nums">
                      {formatDateTime(s.lastRunAt)}
                    </div>
                    {s.lastStatus && (
                      <div className="text-[10px]">
                        <span
                          className={cn(
                            'font-medium',
                            s.lastStatus === 'SUCCESS' &&
                              'text-emerald-600 dark:text-emerald-400',
                            s.lastStatus === 'FAILED' &&
                              'text-red-600 dark:text-red-400',
                            s.lastStatus === 'SKIPPED' &&
                              'text-slate-500',
                          )}
                        >
                          {s.lastStatus}
                        </span>
                        {s.lastJobId && (
                          <Link
                            href={`/bulk-operations/history?jobId=${s.lastJobId}`}
                            className="ml-1 text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center"
                          >
                            view <ArrowRight className="w-2.5 h-2.5 ml-0.5" />
                          </Link>
                        )}
                      </div>
                    )}
                    {s.lastError && (
                      <div className="text-[10px] text-red-600 dark:text-red-400 truncate max-w-[200px]" title={s.lastError}>
                        {s.lastError}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
                    {s.runCount}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setEnabled(s.id, !s.enabled)}
                        disabled={busyId === s.id}
                        title={s.enabled ? 'Pause' : 'Resume'}
                        className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 rounded disabled:opacity-40"
                      >
                        {s.enabled ? (
                          <Pause className="w-3 h-3" />
                        ) : (
                          <Play className="w-3 h-3" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteSchedule(s)}
                        disabled={busyId === s.id}
                        title="Delete schedule"
                        className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded disabled:opacity-40"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
