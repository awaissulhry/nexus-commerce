'use client'

/**
 * AU.7 — Inline rule card with live toggle + dry-run toggle.
 * No deep-clicking required: enable a rule and flip dry-run directly from the list.
 */

import { useState } from 'react'
import Link from 'next/link'
import { ChevronRight, Play, Pause, FlaskConical } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Rule {
  id: string; name: string; description: string | null; trigger: string
  enabled: boolean; dryRun: boolean; scopeMarketplace: string | null
  maxExecutionsPerDay: number | null; executionCount: number
  lastExecutedAt: string | null
}

export function RuleCardClient({ rule: initial, triggerLabel }: { rule: Rule; triggerLabel: string }) {
  const [rule, setRule] = useState(initial)
  const [busy, setBusy] = useState(false)

  const patch = async (data: Partial<Pick<Rule, 'enabled' | 'dryRun'>>) => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${rule.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      })
      if (res.ok) {
        const json = await res.json() as { item?: Rule } & Partial<Rule>
        setRule((r) => ({ ...r, ...(json.item ?? json), ...data }))
      }
    } finally { setBusy(false) }
  }

  const status = !rule.enabled ? 'disabled' : rule.dryRun ? 'dryrun' : 'live'
  const statusChip: Record<string, string> = {
    live: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
    dryrun: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
    disabled: 'bg-slate-50 text-slate-500 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700',
  }
  const statusLabel: Record<string, string> = { live: 'Live', dryrun: 'Dry-run', disabled: 'Disabled' }

  return (
    <div className={`flex items-start gap-3 px-4 py-3 bg-white dark:bg-slate-900 hover:bg-slate-50/60 dark:hover:bg-slate-950/40 transition-colors ${busy ? 'opacity-60' : ''}`}>
      {/* Inline controls */}
      <div className="flex flex-col gap-1.5 pt-0.5 shrink-0">
        {/* Enable/disable toggle */}
        <button
          onClick={() => void patch({ enabled: !rule.enabled })}
          disabled={busy}
          aria-label={rule.enabled ? 'Disable rule' : 'Enable rule'}
          title={rule.enabled ? 'Disable' : 'Enable'}
          className={`h-7 w-7 rounded-md border flex items-center justify-center transition disabled:opacity-40 ${rule.enabled ? 'border-emerald-300 bg-emerald-50 text-emerald-600 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400' : 'border-default bg-slate-50 text-tertiary hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-500'}`}
        >
          {rule.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        {/* Dry-run toggle (only when enabled) */}
        {rule.enabled && (
          <button
            onClick={() => void patch({ dryRun: !rule.dryRun })}
            disabled={busy}
            aria-label={rule.dryRun ? 'Turn off dry-run (go live)' : 'Switch to dry-run'}
            title={rule.dryRun ? 'Go live (turn off dry-run)' : 'Switch to dry-run'}
            className={`h-7 w-7 rounded-md border flex items-center justify-center transition disabled:opacity-40 ${rule.dryRun ? 'border-amber-300 bg-amber-50 text-amber-600 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400' : 'border-default bg-slate-50 text-tertiary hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-500'}`}
          >
            <FlaskConical className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Rule info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-0.5">
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate max-w-[280px]">{rule.name}</span>
          <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ring-inset ${statusChip[status]}`}>{statusLabel[status]}</span>
          <span className="text-[10px] text-tertiary px-1.5 py-0.5 rounded bg-slate-50 dark:bg-slate-800 ring-1 ring-inset ring-slate-200 dark:ring-slate-700">{triggerLabel}</span>
          {rule.scopeMarketplace && <span className="text-[10px] font-mono text-blue-600 dark:text-blue-400">{rule.scopeMarketplace}</span>}
        </div>
        {rule.description && <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 mb-0.5">{rule.description}</p>}
        <div className="text-[11px] text-tertiary flex items-center gap-3 flex-wrap">
          <span>{rule.executionCount} runs</span>
          {rule.maxExecutionsPerDay && <span>max {rule.maxExecutionsPerDay}×/day</span>}
          {rule.lastExecutedAt && (
            <span>last {new Date(rule.lastExecutedAt).toLocaleString('en-GB', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
          )}
          {status === 'dryrun' && (
            <span className="text-amber-600 dark:text-amber-400 font-medium">click 🧪 to go live</span>
          )}
        </div>
      </div>

      {/* Navigate to detail */}
      <Link href={`/marketing/advertising/automation/${rule.id}`} className="shrink-0 text-tertiary hover:text-slate-600 dark:hover:text-slate-200 pt-1" aria-label="View rule details">
        <ChevronRight className="h-4 w-4" />
      </Link>
    </div>
  )
}
