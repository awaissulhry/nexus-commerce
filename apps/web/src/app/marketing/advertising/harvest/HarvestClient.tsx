'use client'

/**
 * AX.7 — Harvesting: review wasteful search terms (→ negatives) and
 * converting search terms (→ graduate to Exact), select, apply.
 */

import { useCallback, useEffect, useState } from 'react'
import { Sprout, Ban, ArrowUpRight } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Cand { query: string; externalCampaignId: string; externalAdGroupId: string; impressions: number; clicks: number; costCents: number; orders: number; salesCents: number }
const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100)

export function HarvestClient() {
  const [neg, setNeg] = useState<Cand[]>([])
  const [grad, setGrad] = useState<Cand[]>([])
  const [negSel, setNegSel] = useState<Set<string>>(new Set())
  const [gradSel, setGradSel] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/harvest/preview`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ negatives: [], graduations: [] }))
      setNeg(r.negatives ?? []); setGrad(r.graduations ?? [])
      setNegSel(new Set((r.negatives ?? []).map((c: Cand) => c.query)))
      setGradSel(new Set((r.graduations ?? []).map((c: Cand) => c.query)))
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const apply = async () => {
    setResult(null)
    const body = { negatives: neg.filter((c) => negSel.has(c.query)), graduations: grad.filter((c) => gradSel.has(c.query)) }
    const r = await fetch(`${getBackendUrl()}/api/advertising/harvest/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json())
    setResult(`✓ Added ${r.negativesAdded} negatives, graduated ${r.keywordsGraduated} keywords${r.errors?.length ? ` · ${r.errors.length} errors` : ''}.`)
    void load()
  }

  const tbl = (cands: Cand[], sel: Set<string>, setSel: (s: Set<string>) => void, kind: 'neg' | 'grad') => (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
      <table className="w-full text-sm"><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr>
        <th className="px-2 py-2 w-8"><input type="checkbox" checked={cands.length > 0 && cands.every((c) => sel.has(c.query))} onChange={(e) => setSel(e.target.checked ? new Set(cands.map((c) => c.query)) : new Set())} /></th>
        <th className="text-left px-3 py-2">Search term</th><th className="text-right px-3 py-2">Impr</th><th className="text-right px-3 py-2">Clicks</th><th className="text-right px-3 py-2">Spend</th><th className="text-right px-3 py-2">Orders</th><th className="text-right px-3 py-2">Sales</th>
      </tr></thead><tbody className="divide-y divide-slate-100 dark:divide-slate-800">
        {cands.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400 text-xs">None — run the search-terms report cycle to populate.</td></tr>}
        {cands.map((c) => (
          <tr key={c.query + c.externalAdGroupId} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
            <td className="px-2 py-1.5"><input type="checkbox" checked={sel.has(c.query)} onChange={(e) => { const n = new Set(sel); e.target.checked ? n.add(c.query) : n.delete(c.query); setSel(n) }} /></td>
            <td className="px-3 py-1.5">{c.query}</td>
            <td className="px-3 py-1.5 text-right tabular-nums">{c.impressions}</td><td className="px-3 py-1.5 text-right tabular-nums">{c.clicks}</td>
            <td className={`px-3 py-1.5 text-right tabular-nums ${kind === 'neg' ? 'text-rose-600' : ''}`}>{eur(c.costCents)}</td>
            <td className={`px-3 py-1.5 text-right tabular-nums ${kind === 'grad' ? 'text-emerald-600' : ''}`}>{c.orders}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(c.salesCents)}</td>
          </tr>
        ))}
      </tbody></table>
    </div>
  )

  return (
    <div className="max-w-[1100px]">
      <div className="flex items-center gap-2 mb-1"><Sprout size={20} className="text-emerald-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Harvesting</h1></div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Stop wasteful spend and promote winners — auto-detected from your search-term reports. Review, deselect any, and apply.{loading ? ' (loading…)' : ''}</p>

      <div className="flex items-center gap-2 mb-2"><Ban size={16} className="text-rose-500" /><h2 className="font-medium text-slate-800 dark:text-slate-100">Add as negatives <span className="text-xs text-slate-400">— spend, zero orders ({neg.length})</span></h2></div>
      {tbl(neg, negSel, setNegSel, 'neg')}

      <div className="flex items-center gap-2 mb-2 mt-5"><ArrowUpRight size={16} className="text-emerald-500" /><h2 className="font-medium text-slate-800 dark:text-slate-100">Graduate to Exact <span className="text-xs text-slate-400">— converting terms ({grad.length})</span></h2></div>
      {tbl(grad, gradSel, setGradSel, 'grad')}

      <div className="flex items-center gap-3 mt-4">
        <button onClick={apply} disabled={negSel.size + gradSel.size === 0} className="px-3 py-1.5 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">Apply ({negSel.size} negatives, {gradSel.size} graduations)</button>
        {result && <span className="text-sm text-emerald-700 dark:text-emerald-300">{result}</span>}
      </div>
    </div>
  )
}
