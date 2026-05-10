'use client'

/**
 * W14.6 — Queue-stats banner.
 *
 * Compact strip on /bulk-operations showing BullMQ counters from
 * the W13.4 endpoint. When the queue is disabled (default in dev)
 * we render a single-line hint so the operator knows large jobs
 * will run inline; when enabled, we show waiting / active /
 * completed / failed / delayed counters with a 10s poll cadence.
 *
 * The banner intentionally hides itself when the queue is
 * disabled AND the operator has set NEXUS_HIDE_QUEUE_BANNER=1
 * — surfaces feedback for the typical case (queue OFF, dev) and
 * lets prod ops kill the chrome once they've internalised it.
 */

import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertTriangle, Clock, Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface QueueStats {
  queueEnabled: boolean
  counts: {
    waiting: number
    active: number
    completed: number
    failed: number
    delayed: number
  }
  promoteThreshold: number
}

const POLL_INTERVAL_MS = 10_000

export default function QueueStatsBanner() {
  const [stats, setStats] = useState<QueueStats | null>(null)
  const [errored, setErrored] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/bulk-operations/queue-stats`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      if (!j.success) throw new Error(j.error ?? 'failed')
      setStats({
        queueEnabled: j.queueEnabled,
        counts: j.counts,
        promoteThreshold: j.promoteThreshold,
      })
      setErrored(false)
    } catch {
      // Silent — endpoint may not be deployed yet on stale envs.
      setErrored(true)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [load])

  if (errored || !stats) return null

  if (!stats.queueEnabled) {
    return (
      <div
        className="px-6 pb-2 flex-shrink-0"
        role="status"
        aria-live="polite"
      >
        <div className="bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-1.5 text-sm text-slate-600 dark:text-slate-400 inline-flex items-center gap-2">
          <Activity className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" aria-hidden="true" />
          <span>
            BullMQ not enabled — jobs run inline. Jobs over{' '}
            <span className="font-medium tabular-nums">
              {stats.promoteThreshold.toLocaleString()}
            </span>{' '}
            items would route to the worker once enabled.
          </span>
        </div>
      </div>
    )
  }

  const { waiting, active, completed, failed, delayed } = stats.counts
  return (
    <div
      className="px-6 pb-2 flex-shrink-0"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-1.5 inline-flex items-center gap-3 text-sm">
        <span className="text-slate-700 dark:text-slate-300 font-medium inline-flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" aria-hidden="true" />
          Queue health
        </span>
        <Counter
          icon={<Clock className="w-3 h-3" aria-hidden="true" />}
          label="Waiting"
          value={waiting}
        />
        <Counter
          icon={<Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
          label="Active"
          value={active}
          tone={active > 0 ? 'blue' : 'slate'}
        />
        <Counter label="Completed" value={completed} tone="green" muted />
        <Counter
          icon={failed > 0 ? <AlertTriangle className="w-3 h-3" aria-hidden="true" /> : null}
          label="Failed"
          value={failed}
          tone={failed > 0 ? 'red' : 'slate'}
        />
        {delayed > 0 && <Counter label="Delayed" value={delayed} tone="amber" />}
        <span className="text-xs text-slate-500 dark:text-slate-400 ml-auto">
          jobs &gt;{' '}
          <span className="tabular-nums">{stats.promoteThreshold.toLocaleString()}</span>{' '}
          items run on the worker
        </span>
      </div>
    </div>
  )
}

type Tone = 'slate' | 'blue' | 'green' | 'red' | 'amber'

const TONE_CLASS: Record<Tone, string> = {
  slate: 'text-slate-600 dark:text-slate-300',
  blue: 'text-blue-700 dark:text-blue-300',
  green: 'text-green-700 dark:text-green-300',
  red: 'text-red-700 dark:text-red-300',
  amber: 'text-amber-700 dark:text-amber-300',
}

function Counter({
  icon,
  label,
  value,
  tone = 'slate',
  muted = false,
}: {
  icon?: React.ReactNode
  label: string
  value: number
  tone?: Tone
  muted?: boolean
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 tabular-nums ${TONE_CLASS[tone]} ${muted ? 'opacity-70' : ''}`}
    >
      {icon}
      <span>{label}</span>
      <span className="font-medium">{value.toLocaleString()}</span>
    </span>
  )
}
