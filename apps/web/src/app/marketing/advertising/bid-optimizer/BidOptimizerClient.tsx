'use client'

/**
 * AX.8 — Target-ACOS bid optimizer. Set a target ACOS, preview proposed bid
 * changes (raise/lower toward target, hard-cut zero-sale spenders), select,
 * apply. Writes go through the shipped grace-window + audit path.
 */

import { useCallback, useEffect, useState } from 'react'
import { Gauge } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Proposal { targetId: string; expression: string; matchType: string; currentBidCents: number; proposedBidCents: number; deltaCents: number; acos: number | null; spendCents: number; salesCents: number; clicks: number; reason: string }
const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100)

export function BidOptimizerClient() {
  const [targetAcos, setTargetAcos] = useState('30')
  const [props, setProps] = useState<Proposal[]>([])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/bid-optimizer/preview?targetAcos=${(parseFloat(targetAcos) || 30) / 100}`, { cache: 'no-store' }).then((x) => x.json()).catch(() => ({ proposals: [] }))
      setProps(r.proposals ?? []); setSel(new Set((r.proposals ?? []).map((p: Proposal) => p.targetId)))
    } finally { setLoading(false) }
  }, [targetAcos])
  useEffect(() => { void load() }, [load])

  const apply = async () => {
    setResult(null)
    const changes = props.filter((p) => sel.has(p.targetId)).map((p) => ({ targetId: p.targetId, proposedBidCents: p.proposedBidCents }))
    const r = await fetch(`${getBackendUrl()}/api/advertising/bid-optimizer/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes }) }).then((x) => x.json())
    setResult(`✓ Applied ${r.applied} bid changes (queued with 5-min undo).`)
    void load()
  }

  return (
    <div className="max-w-[1100px]">
      <div className="flex items-center gap-2 mb-1"><Gauge size={20} className="text-blue-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Bid optimizer</h1></div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Move bids toward a target ACOS — lower over-spenders, raise profitable winners, hard-cut zero-sale clicks. Review and apply.</p>
      <div className="flex items-center gap-3 mb-3">
        <label className="text-sm text-slate-600 dark:text-slate-300">Target ACOS <input value={targetAcos} onChange={(e) => setTargetAcos(e.target.value)} className="w-16 ml-1 px-2 py-1 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" />%</label>
        <button onClick={load} className="px-3 py-1.5 text-sm rounded-md border border-default dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800">{loading ? 'Computing…' : 'Recompute'}</button>
        <span className="text-xs text-tertiary ml-auto">{props.length} proposed changes</span>
      </div>
      <div className="rounded-lg border border-default dark:border-slate-800 overflow-hidden">
        <table className="w-full text-sm"><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr>
          <th className="px-2 py-2 w-8"><input type="checkbox" checked={props.length > 0 && props.every((p) => sel.has(p.targetId))} onChange={(e) => setSel(e.target.checked ? new Set(props.map((p) => p.targetId)) : new Set())} /></th>
          <th className="text-left px-3 py-2">Target</th><th className="text-left px-3 py-2">Match</th><th className="text-right px-3 py-2">ACOS</th><th className="text-right px-3 py-2">Spend</th><th className="text-right px-3 py-2">Bid</th><th className="text-right px-3 py-2">→ New</th><th className="text-left px-3 py-2">Why</th>
        </tr></thead><tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {props.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-tertiary text-xs">No changes proposed — targets lack enough signal, or bids already optimal.</td></tr>}
          {props.map((p) => (
            <tr key={p.targetId} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
              <td className="px-2 py-1.5"><input type="checkbox" checked={sel.has(p.targetId)} onChange={(e) => { const n = new Set(sel); e.target.checked ? n.add(p.targetId) : n.delete(p.targetId); setSel(n) }} /></td>
              <td className="px-3 py-1.5">{p.expression}</td><td className="px-3 py-1.5 text-xs text-slate-500">{p.matchType}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{p.acos != null ? `${(p.acos * 100).toFixed(0)}%` : '—'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{eur(p.spendCents)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-tertiary">{eur(p.currentBidCents)}</td>
              <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${p.deltaCents > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{eur(p.proposedBidCents)}</td>
              <td className="px-3 py-1.5 text-xs text-slate-500">{p.reason}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <div className="flex items-center gap-3 mt-4">
        <button onClick={apply} disabled={sel.size === 0} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">Apply {sel.size} bid changes</button>
        {result && <span className="text-sm text-emerald-700 dark:text-emerald-300">{result}</span>}
      </div>
    </div>
  )
}
