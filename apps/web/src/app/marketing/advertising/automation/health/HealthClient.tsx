'use client'

/** AX3.13 — Automation Health: fleet status, execution volume, success rate,
 *  time saved, and the risks worth acting on. */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, ShieldCheck, AlertTriangle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Health {
  rules: { total: number; live: number; dryRun: number; disabled: number }
  executions30d: { total: number; success: number; partial: number; failed: number; dryRun: number; noMatch: number }
  matches30d: number; successRatePct: number | null; estTimeSavedHours: number
  risks: { stuckInDryRun: number; disabled: number; recentFailures: number; noManaging: boolean }
  recent: Array<{ id: string; ruleName: string; status: string; startedAt: string; error: string | null }>
}
const STATUS_CHIP: Record<string, string> = {
  SUCCESS: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  PARTIAL: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  FAILED: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
  DRY_RUN: 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
  NO_MATCH: 'bg-slate-100 text-slate-500 dark:bg-slate-800',
  CAP_EXCEEDED: 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300',
}

function Tile({ label, value, sub, tone = 'slate' }: { label: string; value: string | number; sub?: string; tone?: string }) {
  const c = tone === 'emerald' ? 'text-emerald-600' : tone === 'amber' ? 'text-amber-600' : tone === 'rose' ? 'text-rose-600' : 'text-slate-900 dark:text-slate-100'
  return <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2"><div className="text-xs text-slate-500">{label}</div><div className={`text-lg font-semibold ${c}`}>{value}</div>{sub && <div className="text-[11px] text-slate-400">{sub}</div>}</div>
}

export function HealthClient() {
  const [h, setH] = useState<Health | null>(null)
  const load = useCallback(() => { fetch(`${getBackendUrl()}/api/advertising/automation-health`, { cache: 'no-store' }).then((x) => x.json()).then(setH).catch(() => {}) }, [])
  useEffect(() => { load() }, [load])

  const risks: Array<{ label: string; n: number; tone: string }> = h ? [
    { label: 'Rules stuck in dry-run', n: h.risks.stuckInDryRun, tone: 'amber' },
    { label: 'Disabled rules', n: h.risks.disabled, tone: 'slate' },
    { label: 'Failures (7d)', n: h.risks.recentFailures, tone: 'rose' },
  ] : []

  return (
    <div className="max-w-[1000px]">
      <Link href="/marketing/advertising/automation" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"><ChevronLeft size={14} /> Automation</Link>
      <div className="flex items-center gap-2 mb-1"><ShieldCheck size={20} className="text-emerald-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Automation health</h1></div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">How hard your automation is working, how reliably, and what needs attention.</p>

      {h && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            <Tile label="Live rules" value={h.rules.live} sub={`${h.rules.dryRun} dry-run · ${h.rules.disabled} off`} tone="emerald" />
            <Tile label="Executions (30d)" value={h.executions30d.total} sub={`${h.matches30d} acted`} />
            <Tile label="Success rate" value={h.successRatePct == null ? '—' : `${h.successRatePct}%`} tone="emerald" />
            <Tile label="Est. time saved" value={`${h.estTimeSavedHours}h`} sub="≈5 min / action" />
          </div>

          {(h.risks.noManaging || risks.some((r) => r.n > 0)) && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50/50 dark:bg-amber-950/20 px-4 py-3 mb-4">
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 mb-2"><AlertTriangle size={13} /> Risks</div>
              {h.risks.noManaging && <div className="text-sm text-slate-700 dark:text-slate-200 mb-1">No rules are live — automation isn&apos;t managing anything yet. <Link href="/marketing/advertising/automation/library" className="text-blue-600 hover:underline">Start from the library →</Link></div>}
              <div className="flex flex-wrap gap-2">
                {risks.filter((r) => r.n > 0).map((r) => <span key={r.label} className={`text-xs px-2 py-1 rounded ${r.tone === 'rose' ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300' : r.tone === 'amber' ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-800'}`}>{r.n} {r.label}</span>)}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
            <div className="px-3 py-2 bg-slate-50 dark:bg-slate-900/60 text-xs font-medium text-slate-600 dark:text-slate-300">Recent executions</div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {h.recent.length === 0 ? <tr><td className="px-3 py-6 text-center text-slate-400 text-xs">No executions yet — enable a rule to start.</td></tr> : h.recent.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                    <td className="px-3 py-1.5">{e.ruleName}</td>
                    <td className="px-3 py-1.5"><span className={`px-1.5 py-0.5 rounded text-[11px] ${STATUS_CHIP[e.status] ?? STATUS_CHIP.NO_MATCH}`}>{e.status.toLowerCase().replace('_', ' ')}</span>{e.error ? <span className="text-xs text-rose-500 ml-2">{e.error}</span> : null}</td>
                    <td className="px-3 py-1.5 text-right text-xs text-slate-400">{new Date(e.startedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
