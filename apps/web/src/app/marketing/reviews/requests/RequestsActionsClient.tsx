'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarClock, Loader2, Play, RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

export function RequestsActionsClient() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
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
          due: number
          sent: number
          failed: number
          skipped: number
          durationMs: number
        }
      }
      if (json.ok) {
        const r = json.result
        setResult(
          `Scheduled ${r.scheduled} new · ${r.due} due · ${r.sent} sent · ${r.failed} failed · ${r.skipped} skipped · ${r.durationMs}ms`,
        )
      } else {
        setResult('Execution failed')
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-4 flex items-center gap-2 flex-wrap">
      <button
        type="button"
        onClick={trigger}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded ring-1 ring-inset ring-blue-300 dark:ring-blue-700 bg-white dark:bg-slate-900 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-40"
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Play className="h-4 w-4" />
        )}
        Run mailer now
      </button>
      <span className="text-[11px] text-slate-400 dark:text-slate-500 flex items-center gap-1">
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
      {result && (
        <span className="basis-full text-xs text-slate-600 dark:text-slate-400 truncate">
          {result}
        </span>
      )}
    </div>
  )
}
