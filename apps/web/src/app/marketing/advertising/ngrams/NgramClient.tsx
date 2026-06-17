'use client'

/** AX.11 — N-gram intelligence: winning vs wasteful word fragments. */

import { useEffect, useState } from 'react'
import { Brain, Download } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Ngram { gram: string; n: number; terms: number; impressions: number; clicks: number; costCents: number; orders: number; salesCents: number; acos: number | null; roas: number | null }
const eur = (c: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100)

export function NgramClient() {
  const [winning, setWinning] = useState<Ngram[]>([])
  const [wasteful, setWasteful] = useState<Ngram[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/advertising/ngrams`, { cache: 'no-store' }).then((x) => x.json()).then((r) => { setWinning(r.winning ?? []); setWasteful(r.wasteful ?? []) }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const csv = (rows: Ngram[], name: string) => {
    const head = 'gram,n,terms,impressions,clicks,cost,orders,sales,acos,roas\n'
    const body = rows.map((r) => `"${r.gram}",${r.n},${r.terms},${r.impressions},${r.clicks},${(r.costCents / 100).toFixed(2)},${r.orders},${(r.salesCents / 100).toFixed(2)},${r.acos ?? ''},${r.roas ?? ''}`).join('\n')
    const blob = new Blob([head + body], { type: 'text/csv' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `ngrams-${name}.csv`; a.click()
  }

  const tbl = (rows: Ngram[], kind: 'win' | 'waste') => (
    <div className="rounded-lg border border-default dark:border-slate-800 overflow-hidden">
      <table className="w-full text-sm"><thead className="bg-slate-50 dark:bg-slate-900/60 text-xs text-slate-500"><tr><th className="text-left px-3 py-2">N-gram</th><th className="text-right px-3 py-2">Terms</th><th className="text-right px-3 py-2">Clicks</th><th className="text-right px-3 py-2">Spend</th><th className="text-right px-3 py-2">Orders</th><th className="text-right px-3 py-2">{kind === 'win' ? 'ROAS' : 'ACOS'}</th></tr></thead>
      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{rows.length === 0 ? <tr><td colSpan={6} className="px-3 py-6 text-center text-tertiary text-xs">No data — run the search-terms report cycle.</td></tr> : rows.map((r) => (
        <tr key={r.gram} className="hover:bg-slate-50 dark:hover:bg-slate-900/40"><td className="px-3 py-1.5"><span className={`text-[10px] mr-1 px-1 rounded ${r.n === 2 ? 'bg-violet-100 text-violet-600' : 'bg-slate-100 text-slate-500'}`}>{r.n}g</span>{r.gram}</td><td className="px-3 py-1.5 text-right tabular-nums text-tertiary">{r.terms}</td><td className="px-3 py-1.5 text-right tabular-nums">{r.clicks}</td><td className="px-3 py-1.5 text-right tabular-nums">{eur(r.costCents)}</td><td className="px-3 py-1.5 text-right tabular-nums">{r.orders}</td><td className={`px-3 py-1.5 text-right tabular-nums ${kind === 'win' ? 'text-emerald-600' : 'text-rose-600'}`}>{kind === 'win' ? (r.roas != null ? `${r.roas.toFixed(1)}×` : '—') : (r.acos != null ? `${(r.acos * 100).toFixed(0)}%` : '—')}</td></tr>
      ))}</tbody></table>
    </div>
  )

  return (
    <div className="max-w-[1100px]">
      <div className="flex items-center gap-2 mb-1"><Brain size={20} className="text-violet-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">N-gram intelligence</h1></div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">The words and pairs that win or waste across all your search terms — act on a fragment once instead of term-by-term.{loading ? ' (loading…)' : ''}</p>
      <div className="grid lg:grid-cols-2 gap-4">
        <div><div className="flex items-center justify-between mb-2"><h2 className="font-medium text-emerald-700 dark:text-emerald-400">Winning fragments</h2><button onClick={() => csv(winning, 'winning')} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"><Download size={12} /> CSV</button></div>{tbl(winning, 'win')}</div>
        <div><div className="flex items-center justify-between mb-2"><h2 className="font-medium text-rose-700 dark:text-rose-400">Wasteful fragments</h2><button onClick={() => csv(wasteful, 'wasteful')} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"><Download size={12} /> CSV</button></div>{tbl(wasteful, 'waste')}</div>
      </div>
    </div>
  )
}
