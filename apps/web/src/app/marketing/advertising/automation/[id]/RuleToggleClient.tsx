'use client'

/**
 * AD.3 — Rule enable/dryRun toggle. Defensive UX: live-mode flip
 * requires a confirmation dialog. AD.4 will gate this further behind
 * the per-connection writesEnabledAt + env-flag two-key turn.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Power, ShieldAlert, FlaskConical } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

export function RuleToggleClient({
  ruleId,
  initialEnabled,
  initialDryRun,
}: {
  ruleId: string
  initialEnabled: boolean
  initialDryRun: boolean
}) {
  const router = useRouter()
  const [enabled, setEnabled] = useState(initialEnabled)
  const [dryRun, setDryRun] = useState(initialDryRun)
  const [busy, setBusy] = useState(false)
  const [pendingLive, setPendingLive] = useState(false)

  async function patch(body: Record<string, unknown>) {
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/advertising/automation-rules/${ruleId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        console.error('rule patch failed', await res.text())
        return false
      }
      router.refresh()
      return true
    } finally {
      setBusy(false)
    }
  }

  async function toggleEnabled() {
    const next = !enabled
    if (await patch({ enabled: next })) setEnabled(next)
  }

  async function flipDryRun(next: boolean) {
    if (await patch({ dryRun: next })) {
      setDryRun(next)
      setPendingLive(false)
    }
  }

  return (
    <div className="mb-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-3">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={toggleEnabled}
          disabled={busy}
          className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded ring-1 ring-inset transition-colors ${
            enabled
              ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900'
              : 'bg-slate-50 text-slate-700 ring-slate-300 hover:bg-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700'
          }`}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
          {enabled ? 'Enabled' : 'Disabled'}
        </button>

        <button
          type="button"
          onClick={() => {
            if (dryRun) {
              setPendingLive(true)
            } else {
              flipDryRun(true)
            }
          }}
          disabled={busy || !enabled}
          className={`inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded ring-1 ring-inset transition-colors disabled:opacity-40 ${
            dryRun
              ? 'bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900'
              : 'bg-rose-50 text-rose-700 ring-rose-200 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900'
          }`}
        >
          {dryRun ? <FlaskConical className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
          {dryRun ? 'Dry-run' : 'Live'}
        </button>

        <span className="text-xs text-slate-500 dark:text-slate-400">
          {!enabled
            ? 'Rule is disabled — the cron will not evaluate it.'
            : dryRun
              ? 'Dry-run mode: each execution produces only an audit entry, no writes.'
              : 'Live mode: actions are sent to Amazon Ads via OutboundSyncQueue.'}
        </span>
      </div>

      {pendingLive && (
        <div className="mt-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-md px-3 py-2">
          <div className="text-sm font-medium text-rose-900 dark:text-rose-100 mb-1">
            Confirm switch to live mode?
          </div>
          <p className="text-xs text-rose-700 dark:text-rose-300 mb-2 leading-relaxed">
            In live mode this rule&apos;s actions write to Amazon Ads (bid/budget/status changes +
            promo creation). Writes are still queued with a 5-min undo window. Keep the daily
            cap as a safety net.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => flipDryRun(false)}
              disabled={busy}
              className="inline-flex items-center gap-1 px-3 py-1 text-sm rounded ring-1 ring-inset ring-rose-300 bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40"
            >
              Confirm live
            </button>
            <button
              type="button"
              onClick={() => setPendingLive(false)}
              disabled={busy}
              className="inline-flex items-center gap-1 px-3 py-1 text-sm rounded text-rose-700 hover:bg-rose-100 dark:text-rose-300 dark:hover:bg-rose-950/40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
