'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarClock, Loader2, Play, RefreshCw, Pause, PlayCircle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface MailerState {
  isPaused: boolean
  pausedReason: string | null
  pausedAt: string | null
  pausedBy: string | null
}

export function RequestsActionsClient({ mailer }: { mailer?: MailerState }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [pauseBusy, setPauseBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  async function trigger() {
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/reviews/cron/review-request-mailer/trigger`,
        { method: 'POST' },
      )
      const json = (await res.json()) as {
        ok: boolean
        result: {
          scheduled: number
          retried?: number
          due: number
          sent: number
          failed: number
          skipped: number
          paused?: boolean
          durationMs: number
        }
      }
      if (json.ok) {
        const r = json.result
        if (r.paused) {
          setResult(`Mailer is paused — tick skipped (${r.durationMs}ms)`)
        } else {
          setResult(
            `Scheduled ${r.scheduled} · retried ${r.retried ?? 0} · ${r.due} due · ${r.sent} sent · ${r.failed} failed · ${r.skipped} skipped · ${r.durationMs}ms`,
          )
        }
      } else {
        setResult('Execution failed')
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function togglePause() {
    if (!mailer) return
    setPauseBusy(true)
    try {
      if (mailer.isPaused) {
        await fetch(`${getBackendUrl()}/api/reviews/mailer/resume`, { method: 'POST' })
      } else {
        const reason = window.prompt(
          'Why pause the review mailer? (Optional reason — shown on the dashboard)',
          '',
        )
        if (reason === null) { setPauseBusy(false); return } // operator cancelled
        await fetch(`${getBackendUrl()}/api/reviews/mailer/pause`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason || null }),
        })
      }
      router.refresh()
    } finally {
      setPauseBusy(false)
    }
  }

  return (
    <div className="mb-4 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={trigger}
          disabled={busy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded ring-1 ring-inset ring-blue-300 dark:ring-blue-700 bg-white dark:bg-slate-900 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Run mailer now
        </button>
        {mailer && (
          <button
            type="button"
            onClick={togglePause}
            disabled={pauseBusy}
            title={mailer.isPaused
              ? `Resume the mailer (paused ${mailer.pausedAt ? new Date(mailer.pausedAt).toLocaleString() : ''}${mailer.pausedReason ? ` — "${mailer.pausedReason}"` : ''})`
              : 'Pause all automated sending. The cron will still tick but skip sends.'}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded ring-1 ring-inset disabled:opacity-40 ${
              mailer.isPaused
                ? 'ring-emerald-300 dark:ring-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-950/60'
                : 'ring-amber-300 dark:ring-amber-700 bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40'
            }`}
          >
            {pauseBusy
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : mailer.isPaused ? <PlayCircle className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            {mailer.isPaused ? 'Resume mailer' : 'Pause mailer'}
          </button>
        )}
        <span className="text-[11px] text-tertiary dark:text-slate-500 flex items-center gap-1">
          <CalendarClock className="h-3 w-3" />
          Schedules new deliveries + sends due requests
        </span>
        <button
          type="button"
          onClick={() => router.refresh()}
          disabled={busy}
          className="ml-auto inline-flex items-center gap-1.5 px-2 py-1.5 text-xs rounded text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-40"
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      {mailer?.isPaused && (
        <div className="rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 px-3 py-2 text-xs text-amber-900 dark:text-amber-100 flex items-start gap-2">
          <Pause className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <div>
            <strong>Mailer paused.</strong> Cron ticks are no-ops until you resume.
            {mailer.pausedReason && <> Reason: <em>{mailer.pausedReason}</em>.</>}
            {mailer.pausedAt && (
              <> Paused {new Date(mailer.pausedAt).toLocaleString()}
                {mailer.pausedBy ? ` by ${mailer.pausedBy}` : ''}.</>
            )}
          </div>
        </div>
      )}
      {result && (
        <div className="text-xs text-slate-600 dark:text-slate-400">{result}</div>
      )}
    </div>
  )
}
