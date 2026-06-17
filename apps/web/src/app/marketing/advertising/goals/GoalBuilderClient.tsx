'use client'

/** AX3.2 — Full-funnel Goal builder: one goal → coordinated Branded +
 *  Unbranded SP campaigns, each with its own Target ACoS + budget. */

import { useState } from 'react'
import Link from 'next/link'
import { Target, Wand2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface SideState { enabled: boolean; targetAcos: string; dailyBudgetEur: string; keywords: string }

function SideCard({ title, accent, s, set }: { title: string; accent: string; s: SideState; set: (p: Partial<SideState>) => void }) {
  return (
    <div className={`rounded-lg border p-3 ${s.enabled ? 'border-default dark:border-slate-800' : 'border-subtle dark:border-slate-900 opacity-60'}`}>
      <div className="flex items-center justify-between mb-2">
        <span className={`font-medium ${accent}`}>{title}</span>
        <label className="inline-flex items-center gap-1 text-xs text-slate-500"><input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> on</label>
      </div>
      <div className="flex gap-2 mb-2">
        <label className="flex-1 text-[11px] text-slate-500">Target ACoS %<input type="number" value={s.targetAcos} onChange={(e) => set({ targetAcos: e.target.value })} disabled={!s.enabled} className="w-full mt-0.5 px-2 py-1 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
        <label className="flex-1 text-[11px] text-slate-500">Daily budget €<input type="number" value={s.dailyBudgetEur} onChange={(e) => set({ dailyBudgetEur: e.target.value })} disabled={!s.enabled} className="w-full mt-0.5 px-2 py-1 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
      </div>
      <label className="block text-[11px] text-slate-500">Keywords (one per line)<textarea value={s.keywords} onChange={(e) => set({ keywords: e.target.value })} disabled={!s.enabled} rows={5} className="w-full mt-0.5 px-2 py-1 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950 font-mono" /></label>
      <div className="text-[10px] text-tertiary mt-0.5">{s.keywords.split('\n').filter((x) => x.trim()).length} phrases</div>
    </div>
  )
}

export function GoalBuilderClient() {
  const [goalName, setGoalName] = useState('')
  const [marketplace, setMarketplace] = useState('IT')
  const [brandTerms, setBrandTerms] = useState('Xavia')
  const [asins, setAsins] = useState('')
  const [matchTypes, setMatchTypes] = useState<Record<string, boolean>>({ EXACT: true, PHRASE: true, BROAD: false })
  const [branded, setBranded] = useState<SideState>({ enabled: true, targetAcos: '20', dailyBudgetEur: '20', keywords: '' })
  const [unbranded, setUnbranded] = useState<SideState>({ enabled: true, targetAcos: '35', dailyBudgetEur: '20', keywords: '' })
  const [busy, setBusy] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const suggest = async () => {
    setSuggesting(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/goals/suggest-targets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brandTerms: brandTerms.split(',').map((x) => x.trim()).filter(Boolean), asins: asins.split(/[\n,]/).map((x) => x.trim()).filter(Boolean) }) }).then((x) => x.json())
      if (r?.branded) setBranded((s) => ({ ...s, keywords: r.branded.join('\n') }))
      if (r?.unbranded) setUnbranded((s) => ({ ...s, keywords: r.unbranded.join('\n') }))
    } finally { setSuggesting(false) }
  }
  const launch = async () => {
    if (!goalName.trim()) { setResult('Goal name required'); return }
    setBusy(true); setResult(null)
    try {
      const mts = Object.entries(matchTypes).filter(([, v]) => v).map(([k]) => k)
      const r = await fetch(`${getBackendUrl()}/api/advertising/goals/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        goalName: goalName.trim(), marketplace, brandTerms: brandTerms.split(',').map((x) => x.trim()).filter(Boolean),
        asins: asins.split(/[\n,]/).map((x) => x.trim()).filter(Boolean), matchTypes: mts,
        branded: { enabled: branded.enabled, targetAcos: (parseFloat(branded.targetAcos) || 20) / 100, dailyBudgetEur: parseFloat(branded.dailyBudgetEur) || 20, keywords: branded.keywords.split('\n').map((x) => x.trim()).filter(Boolean) },
        unbranded: { enabled: unbranded.enabled, targetAcos: (parseFloat(unbranded.targetAcos) || 35) / 100, dailyBudgetEur: parseFloat(unbranded.dailyBudgetEur) || 20, keywords: unbranded.keywords.split('\n').map((x) => x.trim()).filter(Boolean) },
      }) }).then((x) => x.json())
      if (r?.error) { setResult(`Error: ${r.error}`); return }
      const total = (r.created ?? []).reduce((n: number, c: { keywords: number }) => n + c.keywords, 0)
      setResult(`✓ Launched goal "${goalName}" — ${(r.created ?? []).length} campaign(s), ${total} keywords.`)
    } finally { setBusy(false) }
  }

  return (
    <div className="max-w-[900px]">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2"><Target size={20} className="text-blue-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">New goal</h1></div>
        <Link href="/marketing/advertising/create" className="text-sm text-slate-500 hover:underline">Single campaign builder →</Link>
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">One goal builds a coordinated <span className="text-violet-600">Branded</span> + <span className="text-sky-600">Unbranded</span> structure — defend your brand tightly, grow on discovery terms — each with its own Target ACoS and budget.</p>

      <div className="space-y-3 mb-4">
        <div className="flex gap-2">
          <label className="flex-1 text-xs text-slate-500">Goal name<input value={goalName} onChange={(e) => setGoalName(e.target.value)} placeholder="Spring Collection 2026" className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
          <label className="flex-1 text-xs text-slate-500">Market<select value={marketplace} onChange={(e) => setMarketplace(e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950">{['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK'].map((m) => <option key={m}>{m}</option>)}</select></label>
          <label className="flex-1 text-xs text-slate-500">Brand terms (comma)<input value={brandTerms} onChange={(e) => setBrandTerms(e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
        </div>
        <label className="block text-xs text-slate-500">Bulk ASIN add (one per line / comma-separated)<textarea value={asins} onChange={(e) => setAsins(e.target.value)} rows={3} placeholder="B0XXXXXXXX&#10;B0YYYYYYYY" className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-950 font-mono" /></label>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-xs text-slate-500">Match types:</span>
          {['EXACT', 'PHRASE', 'BROAD'].map((m) => <label key={m} className="flex items-center gap-1"><input type="checkbox" checked={matchTypes[m]} onChange={(e) => setMatchTypes((s) => ({ ...s, [m]: e.target.checked }))} /> {m[0]}{m.slice(1).toLowerCase()}</label>)}
          <button onClick={suggest} disabled={suggesting} className="ml-auto inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-violet-300 text-violet-700 dark:text-violet-300 dark:border-violet-800 hover:bg-violet-50 dark:hover:bg-violet-950/30"><Wand2 size={12} /> {suggesting ? 'Suggesting…' : 'Suggest targets'}</button>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-3 mb-4">
        <SideCard title="Branded" accent="text-violet-600" s={branded} set={(p) => setBranded((s) => ({ ...s, ...p }))} />
        <SideCard title="Unbranded" accent="text-sky-600" s={unbranded} set={(p) => setUnbranded((s) => ({ ...s, ...p }))} />
      </div>

      <div className="flex items-center gap-3">
        <button onClick={launch} disabled={busy || !goalName.trim()} className="px-4 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{busy ? 'Launching…' : 'Launch goal'}</button>
        {result && <span className={`text-sm ${result.startsWith('✓') ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-600'}`}>{result} {result.startsWith('✓') && <Link href="/marketing/advertising/campaigns" className="underline">View</Link>}</span>}
      </div>
    </div>
  )
}
