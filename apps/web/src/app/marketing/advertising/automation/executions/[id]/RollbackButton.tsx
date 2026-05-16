'use client'

/**
 * AD.4 — Rollback button for an execution. Confirmation dialog
 * prevents accidental clicks. Calls
 * POST /api/advertising/actions/:executionId/rollback and renders the
 * per-action outcome.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, RotateCcw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface RollbackResponse {
  ok: boolean
  reversed: number
  skipped: number
  failed: number
  details: Array<{
    actionLogId: string
    actionType: string
    entityType: string
    entityId: string
    outcome: 'REVERSED' | 'SKIPPED' | 'FAILED'
    reason?: string
  }>
}

export function RollbackButton({ executionId, count }: { executionId: string; count: number }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')
  const [result, setResult] = useState<RollbackResponse | null>(null)

  async function commit() {
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/advertising/actions/${executionId}/rollback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason.trim() || undefined }),
        },
      )
      const json = (await res.json()) as RollbackResponse
      setResult(json)
      setConfirming(false)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-3">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100 mb-1">
          Rollback complete
        </div>
        <div className="text-xs text-slate-600 dark:text-slate-400 mb-2">
          {result.reversed} reversed · {result.skipped} skipped · {result.failed} failed
        </div>
        <ul className="text-[11px] space-y-0.5 max-h-[200px] overflow-auto">
          {result.details.map((d) => (
            <li key={d.actionLogId} className="font-mono flex items-center gap-2">
              <span
                className={
                  d.outcome === 'REVERSED'
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : d.outcome === 'SKIPPED'
                      ? 'text-amber-700 dark:text-amber-300'
                      : 'text-rose-700 dark:text-rose-300'
                }
              >
                {d.outcome}
              </span>
              <span className="text-slate-700 dark:text-slate-300">
                {d.actionType} · {d.entityType} · {d.entityId.slice(0, 8)}
              </span>
              {d.reason && <span className="text-slate-500">— {d.reason}</span>}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  if (confirming) {
    return (
      <div className="bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-md px-3 py-3">
        <div className="text-sm font-medium text-rose-900 dark:text-rose-100 mb-1">
          Confirm rollback of {count} action(s)?
        </div>
        <p className="text-xs text-rose-700 dark:text-rose-300 mb-2 leading-relaxed">
          Each action will invert the corresponding change via the same OutboundSyncQueue
          (5-min grace). RetailEvents will be deactivated (isActive=false). Already
          rolled-back actions are skipped.
        </p>
        <input
          type="text"
          placeholder="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="block w-full text-xs rounded border border-rose-300 dark:border-rose-700 bg-white dark:bg-slate-900 px-2 py-1 mb-2"
        />
        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="px-3 py-1 text-sm rounded text-rose-700 hover:bg-rose-100 dark:text-rose-300 dark:hover:bg-rose-950/60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={commit}
            disabled={busy}
            className="inline-flex items-center gap-1 px-3 py-1 text-sm rounded ring-1 ring-inset ring-rose-300 bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            Execute rollback
          </button>
        </div>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded ring-1 ring-inset ring-rose-300 dark:ring-rose-700 bg-white dark:bg-slate-900 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40"
    >
      <RotateCcw className="h-4 w-4" />
      Rollback {count} action(s)
    </button>
  )
}
