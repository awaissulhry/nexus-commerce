'use client'

/**
 * PIM E.2 — In-flight sync progress bar.
 *
 * Mounts at the top of /sync-logs above the listing health grid.
 * Shows real-time activity in OutboundSyncQueue:
 *   - per-channel pending + processing + last-5min completed + failed
 *   - aggregate totals at the top
 *   - progress bar visualises completed-vs-still-active ratio
 *
 * Adaptive polling: 3s when there's activity (operator just clicked
 * Retry all, queue is draining), 15s when idle (passive monitor).
 * Hides itself entirely when nothing has happened in the last 5min —
 * keeps the hub uncluttered during quiet periods.
 */

import { useEffect, useState } from 'react'
import {
  Activity,
  CheckCircle2,
  XCircle,
  Loader2,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface ChannelBucket {
  channel: string
  pending: number
  processing: number
  completedRecent: number
  failedRecent: number
}

interface Snapshot {
  windowMinutes: number
  totals: {
    pending: number
    processing: number
    completedRecent: number
    failedRecent: number
  }
  channels: ChannelBucket[]
  hasActivity: boolean
}

const FAST_POLL_MS = 3_000
const SLOW_POLL_MS = 15_000

interface Props {
  className?: string
}

export default function InFlightSyncBar({ className }: Props) {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async () => {
      try {
        const r = await fetch(`${getBackendUrl()}/api/sync-logs/in-flight`, {
          cache: 'no-store',
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const data = (await r.json()) as Snapshot
        if (cancelled) return
        setSnap(data)
        setError(null)
        const delay = data.hasActivity ? FAST_POLL_MS : SLOW_POLL_MS
        timer = setTimeout(() => void tick(), delay)
      } catch (e: any) {
        if (cancelled) return
        setError(e?.message ?? 'failed')
        // Back off on error so we don't hammer.
        timer = setTimeout(() => void tick(), SLOW_POLL_MS)
      }
    }

    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  // Hide entirely when nothing happened recently — keeps the hub clean
  // during quiet periods. We're not loading-state visible by design;
  // the first non-empty payload is the first thing the operator sees.
  if (!snap || error) return null
  const {
    totals: { pending, processing, completedRecent, failedRecent },
    channels,
    windowMinutes,
  } = snap
  if (pending + processing + completedRecent + failedRecent === 0) return null

  const totalRecent = completedRecent + failedRecent + pending + processing
  const completedPct =
    totalRecent === 0 ? 0 : Math.round((completedRecent / totalRecent) * 100)
  const inFlight = pending + processing

  return (
    <section
      className={cn(
        'rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950',
        className,
      )}
    >
      <header className="px-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity
            className={cn(
              'w-3.5 h-3.5',
              inFlight > 0 ? 'text-blue-600 animate-pulse' : 'text-zinc-400',
            )}
          />
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Sync activity
            </h3>
            <p className="text-[11px] text-zinc-500">
              {inFlight > 0
                ? `${inFlight} in flight · ${completedRecent} done in last ${windowMinutes}m`
                : `${completedRecent} done in last ${windowMinutes}m`}
              {failedRecent > 0 && (
                <span className="text-red-600 dark:text-red-400">
                  {' · '}
                  {failedRecent} failed
                </span>
              )}
            </p>
          </div>
        </div>
      </header>

      {/* Aggregate progress bar */}
      <div className="px-4 pt-3">
        <div className="h-2 flex rounded-full overflow-hidden bg-zinc-100 dark:bg-zinc-800">
          {completedRecent > 0 && (
            <div
              className="h-full bg-emerald-500"
              style={{ width: `${(completedRecent / totalRecent) * 100}%` }}
              title={`Completed: ${completedRecent}`}
            />
          )}
          {processing > 0 && (
            <div
              className="h-full bg-blue-500 animate-pulse"
              style={{ width: `${(processing / totalRecent) * 100}%` }}
              title={`Processing: ${processing}`}
            />
          )}
          {pending > 0 && (
            <div
              className="h-full bg-amber-400"
              style={{ width: `${(pending / totalRecent) * 100}%` }}
              title={`Pending: ${pending}`}
            />
          )}
          {failedRecent > 0 && (
            <div
              className="h-full bg-red-500"
              style={{ width: `${(failedRecent / totalRecent) * 100}%` }}
              title={`Failed: ${failedRecent}`}
            />
          )}
        </div>
        <div className="flex items-center justify-between mt-1 text-[10px] text-zinc-500">
          <span>{completedPct}% complete</span>
          <span>
            {pending + processing + completedRecent + failedRecent} total in window
          </span>
        </div>
      </div>

      {/* Per-channel breakdown */}
      <div className="px-3 pb-3 pt-2 grid gap-1.5 grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
        {channels.map((c) => (
          <ChannelCell key={c.channel} cell={c} />
        ))}
      </div>
    </section>
  )
}

function ChannelCell({ cell }: { cell: ChannelBucket }) {
  const total = cell.pending + cell.processing + cell.completedRecent + cell.failedRecent
  const hasActivity = cell.pending + cell.processing > 0
  return (
    <div
      className={cn(
        'rounded border p-2',
        hasActivity
          ? 'border-blue-200 bg-blue-50/40 dark:border-blue-800 dark:bg-blue-900/10'
          : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950',
      )}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
          {cell.channel}
        </span>
        <span className="text-[10px] text-zinc-500 tabular-nums">{total}</span>
      </div>
      <div className="flex items-center gap-2 text-[10px]">
        {cell.processing > 0 && (
          <Stat
            Icon={Loader2}
            value={cell.processing}
            label="processing"
            tone="text-blue-700 dark:text-blue-300"
            spin
          />
        )}
        {cell.pending > 0 && (
          <Stat
            Icon={Activity}
            value={cell.pending}
            label="pending"
            tone="text-amber-700 dark:text-amber-300"
          />
        )}
        {cell.completedRecent > 0 && (
          <Stat
            Icon={CheckCircle2}
            value={cell.completedRecent}
            label="done"
            tone="text-emerald-700 dark:text-emerald-300"
          />
        )}
        {cell.failedRecent > 0 && (
          <Stat
            Icon={XCircle}
            value={cell.failedRecent}
            label="failed"
            tone="text-red-700 dark:text-red-300"
          />
        )}
      </div>
    </div>
  )
}

function Stat({
  Icon,
  value,
  label,
  tone,
  spin,
}: {
  Icon: typeof Activity
  value: number
  label: string
  tone: string
  spin?: boolean
}) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', tone)} title={`${value} ${label}`}>
      <Icon className={cn('w-2.5 h-2.5', spin && 'animate-spin')} />
      {value}
    </span>
  )
}
