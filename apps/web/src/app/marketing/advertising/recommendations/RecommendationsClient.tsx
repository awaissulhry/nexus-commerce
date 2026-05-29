'use client'

/** AX2.7 — Unified AI + rules recommendations feed with one-click apply. */

import { useCallback, useEffect, useState } from 'react'
import { Sparkles, Check, ArrowUpRight, AlertTriangle } from 'lucide-react'
import Link from 'next/link'
import { getBackendUrl } from '@/lib/backend-url'

type RecCategory = 'bid' | 'negative' | 'graduate' | 'budget' | 'sov'
type RecSeverity = 'high' | 'medium' | 'low'
interface Recommendation { id: string; category: RecCategory; severity: RecSeverity; title: string; detail: string; estImpactCents: number; apply: { kind: string; payload: unknown } | null }
interface RecResult { generatedAt: string; windowDays: number; counts: Record<RecCategory, number>; potentialMonthlyImpactCents: number; recommendations: Recommendation[] }

const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100)
const SEV_CHIP: Record<RecSeverity, string> = {
  high: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  low: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
}
const CAT_LABEL: Record<RecCategory, string> = { bid: 'Bid', negative: 'Negative', graduate: 'Graduate', budget: 'Budget', sov: 'Share of voice' }
const CAT_DOT: Record<RecCategory, string> = { bid: 'bg-blue-500', negative: 'bg-rose-500', graduate: 'bg-emerald-500', budget: 'bg-violet-500', sov: 'bg-sky-500' }

export function RecommendationsClient() {
  const [data, setData] = useState<RecResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [brief, setBrief] = useState<{ tldr: string; modelUsed: string } | null>(null)
  const [cat, setCat] = useState<RecCategory | 'all'>('all')
  const [applied, setApplied] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [alerts, setAlerts] = useState<Array<{ id: string; campaignId: string | null; campaignName: string; type: string; severity: string; message: string }>>([])

  const load = useCallback(() => {
    setLoading(true); setApplied(new Set())
    fetch(`${getBackendUrl()}/api/advertising/recommendations`, { cache: 'no-store' }).then((x) => x.json()).then(setData).catch(() => {}).finally(() => setLoading(false))
    setBrief(null)
    fetch(`${getBackendUrl()}/api/advertising/recommendations/brief`, { cache: 'no-store' }).then((x) => x.json()).then(setBrief).catch(() => {})
    fetch(`${getBackendUrl()}/api/advertising/alerts`, { cache: 'no-store' }).then((x) => x.json()).then((r) => setAlerts(r.alerts ?? [])).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  const apply = async (r: Recommendation) => {
    if (!r.apply) return
    setBusy(r.id)
    try {
      const res = await fetch(`${getBackendUrl()}/api/advertising/recommendations/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.apply) }).then((x) => x.json())
      if (!res?.error) setApplied((s) => new Set(s).add(r.id))
    } finally { setBusy(null) }
  }
  const applyAllHigh = async () => {
    const targets = (data?.recommendations ?? []).filter((r) => r.severity === 'high' && r.apply && !applied.has(r.id))
    for (const r of targets) await apply(r) // sequential to keep audit ordering clean
  }

  const recs = (data?.recommendations ?? []).filter((r) => cat === 'all' ? true : r.category === cat)
  const cats: Array<RecCategory | 'all'> = ['all', 'bid', 'negative', 'graduate', 'budget', 'sov']

  return (
    <div className="max-w-[1100px]">
      <div className="flex items-center gap-2 mb-1"><Sparkles size={20} className="text-amber-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Recommendations</h1></div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Everything worth doing right now — bid moves, wasted-spend negatives, converting terms to promote, budget shifts — ranked by impact, each one click to apply.{loading ? ' (loading…)' : ''}</p>

      {/* Alerts strip (AX2.12) */}
      {alerts.length > 0 && (
        <div className="rounded-lg border border-rose-200 dark:border-rose-900/50 bg-rose-50/60 dark:bg-rose-950/20 px-4 py-3 mb-4">
          <div className="flex items-center gap-1.5 text-xs font-medium text-rose-700 dark:text-rose-300 mb-2"><AlertTriangle size={13} /> {alerts.length} active alert{alerts.length > 1 ? 's' : ''}</div>
          <div className="space-y-1">
            {alerts.slice(0, 6).map((a) => (
              <div key={a.id} className="flex items-center gap-2 text-sm">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.severity === 'high' ? 'bg-rose-500' : 'bg-amber-500'}`} />
                {a.campaignId ? <Link href={`/marketing/advertising/campaigns/${a.campaignId}`} className="font-medium text-slate-800 dark:text-slate-100 hover:underline truncate max-w-[260px]">{a.campaignName}</Link> : <span className="font-medium truncate max-w-[260px]">{a.campaignName}</span>}
                <span className="text-slate-600 dark:text-slate-300">{a.message}</span>
              </div>
            ))}
            {alerts.length > 6 && <div className="text-xs text-slate-400">+{alerts.length - 6} more</div>}
          </div>
        </div>
      )}

      {/* AI brief */}
      <div className="rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50/60 dark:bg-amber-950/20 px-4 py-3 mb-4">
        <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 mb-1"><Sparkles size={13} /> AI action brief{brief?.modelUsed === 'rules-only' ? <span className="text-amber-500/70 font-normal">· rules summary (set ANTHROPIC_API_KEY for AI)</span> : null}</div>
        <p className="text-sm text-slate-700 dark:text-slate-200">{brief ? brief.tldr : 'Generating…'}</p>
      </div>

      {/* Summary tiles */}
      {data && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2"><div className="text-xs text-slate-500">Potential impact</div><div className="text-lg font-semibold text-emerald-600">{eur(data.potentialMonthlyImpactCents)}<span className="text-xs font-normal text-slate-400">/mo</span></div></div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2"><div className="text-xs text-slate-500">Total actions</div><div className="text-lg font-semibold">{data.recommendations.length}</div></div>
          <button onClick={applyAllHigh} className="ml-auto inline-flex items-center gap-1 py-1.5 px-3 text-sm rounded-md bg-rose-600 text-white hover:bg-rose-700">Apply all high-priority</button>
        </div>
      )}

      {/* Category filter */}
      <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-700 overflow-hidden mb-3">
        {cats.map((c) => (
          <button key={c} onClick={() => setCat(c)} className={`px-2.5 py-1.5 text-xs border-l first:border-l-0 border-slate-200 dark:border-slate-700 ${cat === c ? 'bg-slate-900 text-white dark:bg-slate-700' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
            {c === 'all' ? 'All' : CAT_LABEL[c]}{c !== 'all' && data ? ` (${data.counts[c]})` : ''}
          </button>
        ))}
      </div>

      {/* Feed */}
      <div className="space-y-2">
        {recs.length === 0 && !loading && <div className="rounded-lg border border-slate-200 dark:border-slate-800 px-4 py-8 text-center text-slate-400 text-sm">Nothing to act on — your account is well-tuned, or there isn&apos;t enough data yet.</div>}
        {recs.map((r) => {
          const done = applied.has(r.id)
          return (
            <div key={r.id} className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${done ? 'border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/40 dark:bg-emerald-950/10' : 'border-slate-200 dark:border-slate-800'}`}>
              <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${CAT_DOT[r.category]}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${SEV_CHIP[r.severity]}`}>{r.severity}</span>
                  <span className="text-[11px] text-slate-400">{CAT_LABEL[r.category]}</span>
                  <span className="font-medium text-slate-900 dark:text-slate-100 truncate">{r.title}</span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{r.detail}</p>
              </div>
              {r.category !== 'sov' && <span className="text-xs tabular-nums text-slate-400 shrink-0 mt-1">{eur(r.estImpactCents)}</span>}
              <div className="shrink-0">
                {r.apply ? (
                  done ? <span className="inline-flex items-center gap-1 text-xs text-emerald-600"><Check size={14} /> Applied</span>
                    : <button disabled={busy === r.id} onClick={() => apply(r)} className="inline-flex items-center gap-1 py-1 px-2.5 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{busy === r.id ? '…' : 'Apply'}</button>
                ) : <span className="inline-flex items-center gap-0.5 text-xs text-slate-400"><ArrowUpRight size={12} /> Review</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
