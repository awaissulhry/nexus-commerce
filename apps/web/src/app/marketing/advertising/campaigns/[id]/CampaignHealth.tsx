'use client'

/**
 * CD.9 — Campaign health score + attached automation.
 *
 * A 0–100 health ring computed from signals the cockpit already has (ACOS vs
 * sensible bands, profit margin, sync staleness, CTR, budget-constraint), with
 * each contributing factor shown as a chip. Below it, the automation rules that
 * apply to this campaign (advertising-domain rules whose scopeMarketplace is
 * null or matches the campaign marketplace) + their most recent executions,
 * linking back to the rule studio. Read-only.
 */

import { useEffect, useState } from 'react'
import { ShieldCheck, Zap, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { getBackendUrl } from '@/lib/backend-url'

export interface HealthFactor { label: string; status: 'good' | 'warn' | 'bad'; detail: string }

interface Rule { id: string; name: string; trigger: string; enabled: boolean; scopeMarketplace: string | null }
interface Execution { id: string; status: string; startedAt: string; rule?: { id: string; name: string; trigger: string } }

const DOT: Record<string, string> = { good: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-rose-500' }
const TXT: Record<string, string> = { good: 'text-emerald-600 dark:text-emerald-400', warn: 'text-amber-600 dark:text-amber-400', bad: 'text-rose-600 dark:text-rose-400' }

function Ring({ score }: { score: number }) {
  const r = 26, c = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score))
  const color = score >= 75 ? '#10b981' : score >= 50 ? '#f59e0b' : '#ef4444'
  return (
    <svg width={64} height={64} viewBox="0 0 64 64" className="flex-shrink-0">
      <circle cx={32} cy={32} r={r} fill="none" stroke="currentColor" className="text-slate-200 dark:text-slate-700" strokeWidth={6} />
      <circle cx={32} cy={32} r={r} fill="none" stroke={color} strokeWidth={6} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform="rotate(-90 32 32)" />
      <text x={32} y={36} textAnchor="middle" className="fill-slate-800 dark:fill-slate-100" style={{ fontSize: 18, fontWeight: 600 }}>{Math.round(score)}</text>
    </svg>
  )
}

export function CampaignHealth({ score, factors, marketplace, refreshKey }: { score: number; factors: HealthFactor[]; marketplace: string | null; refreshKey?: number }) {
  const [rules, setRules] = useState<Rule[]>([])
  const [execs, setExecs] = useState<Execution[]>([])

  useEffect(() => {
    let alive = true
    void (async () => {
      const rl = await fetch(`${getBackendUrl()}/api/advertising/automation-rules?enabled=true`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ items: [] }))
      const all: Rule[] = rl.items ?? []
      const attached = all.filter((r) => !r.scopeMarketplace || r.scopeMarketplace === marketplace)
      if (!alive) return
      setRules(attached)
      if (attached.length > 0) {
        const ex = await fetch(`${getBackendUrl()}/api/advertising/automation-rule-executions?limit=50`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ items: [] }))
        const ids = new Set(attached.map((r) => r.id))
        if (alive) setExecs((ex.items ?? []).filter((e: Execution) => e.rule && ids.has(e.rule.id)).slice(0, 4))
      } else setExecs([])
    })()
    return () => { alive = false }
  }, [marketplace, refreshKey])

  return (
    <div className="mb-4 rounded-lg border border-default dark:border-slate-800 bg-white dark:bg-slate-950 p-3">
      <div className="flex items-start gap-3">
        <Ring score={score} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-slate-700 dark:text-slate-200 mb-1">
            <ShieldCheck size={14} className="text-emerald-500" /> Campaign health
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {factors.map((f) => (
              <span key={f.label} className="inline-flex items-center gap-1 text-xs" title={f.detail}>
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${DOT[f.status]}`} />
                <span className="text-slate-500">{f.label}</span>
                <span className={TXT[f.status]}>{f.detail}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {rules.length > 0 && (
        <div className="mt-3 pt-2 border-t border-subtle dark:border-slate-800">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300"><Zap size={12} className="text-violet-500" /> Automation applied ({rules.length})</span>
            <Link href="/marketing/advertising/automation" className="inline-flex items-center gap-0.5 text-xs text-blue-600 hover:underline">Rules <ExternalLink size={10} /></Link>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {rules.map((r) => (
              <span key={r.id} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border border-default dark:border-slate-700 text-slate-600 dark:text-slate-300" title={r.trigger}>
                {r.name}{r.scopeMarketplace ? <span className="text-tertiary">· {r.scopeMarketplace}</span> : null}
              </span>
            ))}
          </div>
          {execs.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {execs.map((e) => (
                <li key={e.id} className="text-xs text-slate-500 flex items-center gap-2">
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${e.status === 'SUCCESS' || e.status === 'COMPLETED' ? 'bg-emerald-500' : e.status === 'FAILED' ? 'bg-rose-500' : 'bg-slate-400'}`} />
                  <span className="text-slate-600 dark:text-slate-300">{e.rule?.name}</span>
                  <span className="text-tertiary">{e.status.toLowerCase()}</span>
                  <span className="text-tertiary ml-auto">{new Date(e.startedAt).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
