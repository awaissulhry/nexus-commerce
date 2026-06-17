'use client'

/** AX.10 — Budget pacing: raise out-of-budget winners, trim losers. */

import { useCallback, useEffect, useState } from 'react'
import { Wallet } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Prop { campaignId: string; name: string; marketplace: string | null; currentBudgetCents: number; proposedBudgetCents: number; spendCents: number; salesCents: number; roas: number | null; outOfBudget: boolean; reason: string }
const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100)

export function PacingClient() {
  const [props, setProps] = useState<Prop[]>([])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { const r = await fetch(`${getBackendUrl()}/api/advertising/pacing/preview`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ proposals: [] })); setProps(r.proposals ?? []); setSel(new Set((r.proposals ?? []).filter((p: Prop) => p.outOfBudget).map((p: Prop) => p.campaignId))) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const apply = async () => {
    setResult(null)
    const changes = props.filter((p) => sel.has(p.campaignId)).map((p) => ({ campaignId: p.campaignId, proposedBudgetCents: p.proposedBudgetCents }))
    const r = await fetch(`${getBackendUrl()}/api/advertising/pacing/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes }) }).then((x) => x.json())
    setResult(`✓ Applied ${r.applied} budget changes.`); void load()
  }

  return (
    <div className="max-w-[1000px]">
      <div className="flex items-center gap-2 mb-1"><Wallet size={20} className="text-amber-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Budget pacing</h1></div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Stop leaving money on the table — raise budgets on profitable out-of-budget campaigns and trim the losers.{loading ? ' (loading…)' : ''}</p>
      <div className="rounded-lg border border-default dark:border-slate-800 overflow-hidden">
        <table className="w-full text-sm"><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr>
          <th className="px-2 py-2 w-8"><input type="checkbox" checked={props.length > 0 && props.every((p) => sel.has(p.campaignId))} onChange={(e) => setSel(e.target.checked ? new Set(props.map((p) => p.campaignId)) : new Set())} /></th>
          <th className="text-left px-3 py-2">Campaign</th><th className="text-right px-3 py-2">ROAS</th><th className="text-right px-3 py-2">Spend</th><th className="text-right px-3 py-2">Budget</th><th className="text-right px-3 py-2">→ New</th><th className="text-left px-3 py-2">Why</th>
        </tr></thead><tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {props.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-tertiary text-xs">No pacing actions — budgets look healthy.</td></tr>}
          {props.map((p) => (
            <tr key={p.campaignId} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
              <td className="px-2 py-1.5"><input type="checkbox" checked={sel.has(p.campaignId)} onChange={(e) => { const n = new Set(sel); e.target.checked ? n.add(p.campaignId) : n.delete(p.campaignId); setSel(n) }} /></td>
              <td className="px-3 py-1.5">{p.name}{p.outOfBudget && <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-rose-100 text-rose-700">out of budget</span>}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{p.roas != null ? `${p.roas.toFixed(1)}×` : '—'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{eur(p.spendCents)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-tertiary">{eur(p.currentBudgetCents)}</td>
              <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${p.proposedBudgetCents > p.currentBudgetCents ? 'text-emerald-600' : 'text-rose-600'}`}>{eur(p.proposedBudgetCents)}</td>
              <td className="px-3 py-1.5 text-xs text-slate-500">{p.reason}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <div className="flex items-center gap-3 mt-4"><button onClick={apply} disabled={sel.size === 0} className="px-3 py-1.5 text-sm rounded-md bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50">Apply {sel.size} changes</button>{result && <span className="text-sm text-emerald-700 dark:text-emerald-300">{result}</span>}</div>
    </div>
  )
}
