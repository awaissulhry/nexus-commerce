'use client'

/**
 * AX.6 — Auto-architect: paste keywords → pick a strategy → preview the
 * generated campaign structure → create it (one click). The headline ease-
 * of-use. Sandbox-safe (creates go through the AX.4 gate).
 */

import { useState } from 'react'
import Link from 'next/link'
import { Wand2, ChevronLeft, Check } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

type Strategy = 'MATCH_TYPE_SPLIT' | 'SKAG' | 'AUTO_FUNNEL'
interface PlanKeyword { text: string; matchType: string; bidEur: number }
interface PlanAdGroup { name: string; defaultBidEur: number; keywords: PlanKeyword[] }
interface PlanCampaign { name: string; targetingType: string; dailyBudgetEur: number; adGroups: PlanAdGroup[] }
interface Plan { strategy: Strategy; campaigns: PlanCampaign[]; keywordCount: number; campaignCount: number; adGroupCount: number }

const STRATEGIES: Array<{ key: Strategy; label: string; blurb: string }> = [
  { key: 'MATCH_TYPE_SPLIT', label: 'Match-type split', blurb: '3 campaigns — Exact / Phrase / Broad — each with all your keywords. The standard way to control bids per match type.' },
  { key: 'SKAG', label: 'SKAG (single-keyword ad groups)', blurb: '1 campaign, one ad group per keyword (exact). Maximum bid granularity per keyword.' },
  { key: 'AUTO_FUNNEL', label: 'Auto-discovery funnel', blurb: 'Auto discovery campaign + Broad + Exact manual. Discover converting terms, then harvest them up (AX.7).' },
]

export function ArchitectClient() {
  const [baseName, setBaseName] = useState('')
  const [marketplace, setMarketplace] = useState('IT')
  const [strategy, setStrategy] = useState<Strategy>('MATCH_TYPE_SPLIT')
  const [keywords, setKeywords] = useState('')
  const [dailyBudgetEur, setDaily] = useState('10')
  const [defaultBidEur, setBid] = useState('0.50')
  const [productSku, setSku] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [creating, setCreating] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const body = () => ({ baseName, marketplace, strategy, keywords: keywords.split('\n'), dailyBudgetEur: parseFloat(dailyBudgetEur) || 10, defaultBidEur: parseFloat(defaultBidEur) || 0.5, productSku: productSku.trim() || undefined })

  const preview = async () => {
    const r = await fetch(`${getBackendUrl()}/api/advertising/architect/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) }).then((x) => x.json()).catch(() => null)
    if (r?.campaigns) setPlan(r)
  }
  const create = async () => {
    setCreating(true); setResult(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/architect/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) }).then((x) => x.json())
      if (r?.ok) setResult(`✓ Created ${r.created.campaigns} campaigns, ${r.created.adGroups} ad groups, ${r.created.keywords} keywords${r.created.productAds ? `, ${r.created.productAds} product ads` : ''}.`)
      else setResult(`Error: ${r?.error ?? 'failed'}`)
    } finally { setCreating(false) }
  }

  return (
    <div className="max-w-[1100px]">
      <Link href="/marketing/advertising/campaigns" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"><ChevronLeft size={14} /> Campaigns</Link>
      <div className="flex items-center gap-2 mb-1"><Wand2 size={20} className="text-violet-500" /><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Auto-architect</h1></div>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Paste a keyword list, pick a structure, and create a full campaign set in one click — by match type, SKAG, or an auto-discovery funnel.</p>

      <div className="grid md:grid-cols-2 gap-5">
        {/* Inputs */}
        <div className="space-y-3">
          <label className="block text-xs text-slate-500">Base name<input value={baseName} onChange={(e) => setBaseName(e.target.value)} placeholder="e.g. Misano Jacket" className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
          <div className="flex gap-2">
            <label className="flex-1 text-xs text-slate-500">Market<select value={marketplace} onChange={(e) => setMarketplace(e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950">{['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK'].map((m) => <option key={m}>{m}</option>)}</select></label>
            <label className="flex-1 text-xs text-slate-500">Daily budget €<input value={dailyBudgetEur} onChange={(e) => setDaily(e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
            <label className="flex-1 text-xs text-slate-500">Default bid €<input value={defaultBidEur} onChange={(e) => setBid(e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
          </div>
          <label className="block text-xs text-slate-500">Product SKU (optional, attaches the ad)<input value={productSku} onChange={(e) => setSku(e.target.value)} placeholder="MISANO-JACKET-XL-BLACK" className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
          <label className="block text-xs text-slate-500">Keywords (one per line)<textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} rows={8} placeholder={'casco moto\ngiacca moto uomo\nguanti moto estivi'} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono" /></label>
          <div className="text-xs text-slate-400">{keywords.split('\n').filter((k) => k.trim()).length} keywords</div>
        </div>

        {/* Strategy + actions */}
        <div className="space-y-3">
          <div className="text-xs text-slate-500">Strategy</div>
          {STRATEGIES.map((s) => (
            <button key={s.key} onClick={() => { setStrategy(s.key); setPlan(null) }} className={`block w-full text-left p-2.5 rounded-lg border ${strategy === s.key ? 'border-violet-500 bg-violet-50 dark:bg-violet-950/30' : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
              <div className="text-sm font-medium text-slate-800 dark:text-slate-100">{s.label}{strategy === s.key && <Check size={14} className="inline ml-1 text-violet-600" />}</div>
              <div className="text-xs text-slate-500">{s.blurb}</div>
            </button>
          ))}
          <div className="flex gap-2 pt-1">
            <button onClick={preview} disabled={!baseName || !keywords.trim()} className="px-3 py-1.5 text-sm rounded-md border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">Preview</button>
            <button onClick={create} disabled={!plan || creating} className="px-3 py-1.5 text-sm rounded-md bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">{creating ? 'Creating…' : 'Create campaigns'}</button>
          </div>
          {result && <div className="text-sm rounded-md px-3 py-2 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">{result} <Link href="/marketing/advertising/campaigns" className="underline">View campaigns</Link></div>}
        </div>
      </div>

      {/* Preview tree */}
      {plan && (
        <div className="mt-5 rounded-lg border border-slate-200 dark:border-slate-800 p-3">
          <div className="text-sm font-medium mb-2">Preview — {plan.campaignCount} campaigns · {plan.adGroupCount} ad groups · {plan.keywordCount} keywords</div>
          <div className="space-y-2">
            {plan.campaigns.map((c, i) => (
              <div key={i} className="border-l-2 border-violet-300 pl-3">
                <div className="text-sm font-medium text-slate-800 dark:text-slate-100">📁 {c.name} <span className="text-xs text-slate-400">({c.targetingType} · €{c.dailyBudgetEur}/d)</span></div>
                {c.adGroups.map((g, j) => (
                  <div key={j} className="ml-4 text-xs text-slate-600 dark:text-slate-300">↳ {g.name} <span className="text-slate-400">— {g.keywords.length} keyword{g.keywords.length === 1 ? '' : 's'}{g.keywords[0] ? ` (${g.keywords[0].matchType.toLowerCase()})` : ' (auto)'}</span></div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
