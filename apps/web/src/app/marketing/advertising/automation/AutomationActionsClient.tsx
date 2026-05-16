'use client'

/**
 * AD.3 — Client-side action buttons for the automation workspace:
 *   - Seed templates (idempotent first-time setup)
 *   - Trigger evaluator cron (manual one-shot)
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Download, Loader2, Play, RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

export function AutomationActionsClient({ hasRules }: { hasRules: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState<'seed' | 'trigger' | null>(null)
  const [result, setResult] = useState<string | null>(null)

  async function seed() {
    setBusy('seed')
    setResult(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/advertising/automation-rules/seed-templates`,
        { method: 'POST' },
      )
      const json = (await res.json()) as {
        ok: boolean
        created: string[]
        skippedExisting: string[]
      }
      setResult(
        json.ok
          ? `${json.created.length} create, ${json.skippedExisting.length} esistenti.`
          : 'Seed fallito',
      )
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  async function trigger() {
    setBusy('trigger')
    setResult(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/advertising/cron/advertising-rule-evaluator/trigger`,
        { method: 'POST' },
      )
      const json = (await res.json()) as {
        ok: boolean
        summary: {
          fbaAgeContexts: number
          profitabilityContexts: number
          cacSpikeContexts: number
          underperformContexts: number
          totalEvaluations: number
          totalMatches: number
          durationMs: number
        }
      }
      if (json.ok) {
        const s = json.summary
        setResult(
          `Valutati ${s.totalEvaluations} · Match ${s.totalMatches} · contesti: fba=${s.fbaAgeContexts} prof=${s.profitabilityContexts} acos=${s.cacSpikeContexts} under=${s.underperformContexts} · ${s.durationMs}ms`,
        )
      } else {
        setResult('Esecuzione fallita')
      }
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mb-3 flex items-center gap-2 flex-wrap">
      <button
        type="button"
        onClick={seed}
        disabled={busy != null}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded ring-1 ring-inset ring-blue-300 dark:ring-blue-700 bg-white dark:bg-slate-900 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-40"
      >
        {busy === 'seed' ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        {hasRules ? 'Carica template mancanti' : 'Carica template iniziali'}
      </button>
      <button
        type="button"
        onClick={trigger}
        disabled={busy != null}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded ring-1 ring-inset ring-slate-300 dark:ring-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-950/40 disabled:opacity-40"
      >
        {busy === 'trigger' ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Play className="h-4 w-4" />
        )}
        Esegui evaluator ora
      </button>
      <button
        type="button"
        onClick={() => router.refresh()}
        className="inline-flex items-center gap-1.5 px-2 py-1.5 text-xs rounded text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        title="Refresh"
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </button>
      {result && (
        <span className="ml-auto text-xs text-slate-600 dark:text-slate-400 truncate max-w-[400px]">
          {result}
        </span>
      )}
    </div>
  )
}
