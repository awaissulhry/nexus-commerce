'use client'

/**
 * AX.5 — Guided campaign builder. Step 1: choose type (Amazon-style cards:
 * Sponsored Products / Brands / Display). Step 2: configure (settings →
 * ad group → product → keywords) and create via the AX.4 primitives.
 * Single-campaign counterpart to the bulk Auto-architect (AX.6).
 */

import { useState } from 'react'
import Link from 'next/link'
import { ChevronLeft, Package, Tag, MonitorPlay, Wand2, TrendingUp, Rocket, Shield, Flame, Settings2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

type CType = 'SP' | 'SB' | 'SD'
const TYPES: Array<{ key: CType; label: string; blurb: string; icon: typeof Package }> = [
  { key: 'SP', label: 'Sponsored Products', blurb: 'Promote individual listings to shoppers searching related keywords or viewing similar products.', icon: Package },
  { key: 'SB', label: 'Sponsored Brands', blurb: 'Drive brand discovery with headline + logo + multi-product creatives across search.', icon: Tag },
  { key: 'SD', label: 'Sponsored Display', blurb: 'Re-engage and convert shoppers on and off Amazon by interest and behaviour.', icon: MonitorPlay },
]

// AX2.8 — goal-driven presets. Each goal pre-configures the builder with a
// sensible structure / bidding / budget so the operator just confirms.
type Defaults = { targetingType: string; biddingStrategy: string; dailyBudgetEur: string; defaultBidEur: string; matchTypes: Record<string, boolean> }
const GOALS: Array<{ key: string; label: string; blurb: string; icon: typeof Package; type?: CType; tip?: string; defaults?: Defaults }> = [
  { key: 'grow', label: 'Grow profitable sales', blurb: 'Target-ACOS bidding on your best converters. Balanced manual Sponsored Products.', icon: TrendingUp, type: 'SP', tip: 'Manual SP with exact + phrase coverage and up-&-down bidding toward your target ACOS. Pair with the Bid optimizer.', defaults: { targetingType: 'MANUAL', biddingStrategy: 'autoForSales', dailyBudgetEur: '20', defaultBidEur: '0.75', matchTypes: { EXACT: true, PHRASE: true, BROAD: false } } },
  { key: 'launch', label: 'Launch a new product', blurb: 'Maximise discovery — automatic targeting and broad reach to learn fast.', icon: Rocket, type: 'SP', tip: 'Auto SP to harvest converting search terms, then graduate the winners to exact via Harvesting.', defaults: { targetingType: 'AUTO', biddingStrategy: 'legacyForSales', dailyBudgetEur: '25', defaultBidEur: '0.90', matchTypes: { EXACT: true, PHRASE: true, BROAD: true } } },
  { key: 'defend', label: 'Defend your brand', blurb: 'Own your branded searches with tight exact-match coverage.', icon: Shield, type: 'SP', tip: 'Exact-match on brand terms with fixed bids to hold top-of-search position cheaply.', defaults: { targetingType: 'MANUAL', biddingStrategy: 'manual', dailyBudgetEur: '10', defaultBidEur: '0.60', matchTypes: { EXACT: true, PHRASE: false, BROAD: false } } },
  { key: 'liquidate', label: 'Liquidate aged stock', blurb: 'Push slow movers hard with aggressive bids and a high budget.', icon: Flame, type: 'SP', tip: 'Aggressive auto SP; once it moves, attach a target-ACOS rule to protect margin.', defaults: { targetingType: 'AUTO', biddingStrategy: 'autoForSales', dailyBudgetEur: '30', defaultBidEur: '1.10', matchTypes: { EXACT: true, PHRASE: true, BROAD: true } } },
  { key: 'custom', label: 'Custom / advanced', blurb: 'Choose the ad type and configure every setting yourself.', icon: Settings2 },
]

export function CreateCampaignClient() {
  const [goal, setGoal] = useState<string | null>(null)
  const [goalTip, setGoalTip] = useState<string | null>(null)
  const [type, setType] = useState<CType | null>(null)
  const [f, setF] = useState({ name: '', marketplace: 'IT', targetingType: 'MANUAL', dailyBudgetEur: '10', biddingStrategy: 'legacyForSales', defaultBidEur: '0.50', adGroupName: '', productSku: '', keywords: '', matchTypes: { EXACT: true, PHRASE: true, BROAD: false } as Record<string, boolean>, brandName: '', headline: '', logoAssetId: '', creativeType: 'productCollection', landingType: 'productList', landingUrl: '', sbAsins: '' })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const set = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }))
  const selectGoal = (g: typeof GOALS[number]) => {
    if (g.key === 'custom') { setGoal('custom'); setType(null); setGoalTip(null); return }
    if (g.defaults) setF((s) => ({ ...s, ...g.defaults }))
    setType(g.type ?? 'SP'); setGoalTip(g.tip ?? null); setGoal(g.key)
  }
  const post = (path: string, body: unknown) => fetch(`${getBackendUrl()}/api/advertising${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())

  const create = async () => {
    if (!type) return
    setBusy(true); setResult(null)
    try {
      const c = await post('/campaigns/create', { name: f.name, type, marketplace: f.marketplace, targetingType: f.targetingType, dailyBudgetEur: parseFloat(f.dailyBudgetEur) || 10, biddingStrategy: f.biddingStrategy })
      if (!c?.id) { setResult(`Error: ${c?.error ?? 'campaign create failed'}`); return }
      const g = await post('/adgroups/create', { campaignId: c.id, name: f.adGroupName || `${f.name} - Ad group`, defaultBidEur: parseFloat(f.defaultBidEur) || 0.5 })
      let kw = 0, extra = ''
      if (type === 'SB') {
        const asins = f.sbAsins.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)
        const sb = await post('/sb-creatives/create', { adGroupId: g.id, brandName: f.brandName, headline: f.headline, logoAssetId: f.logoAssetId || undefined, creativeType: f.creativeType, landingType: f.landingType, landingUrl: f.landingType === 'url' ? f.landingUrl : undefined, asins })
        if (sb?.error) { setResult(`Error: ${sb.error}`); return }
        extra = ` with a Brands creative (${asins.length} ASINs)`
      } else if (f.productSku.trim()) {
        await post('/product-ads/create', { adGroupId: g.id, sku: f.productSku.trim() })
      }
      if (f.targetingType === 'MANUAL' && f.keywords.trim()) {
        const mts = Object.entries(f.matchTypes).filter(([, v]) => v).map(([k]) => k)
        for (const text of f.keywords.split('\n').map((x) => x.trim()).filter(Boolean)) {
          for (const mt of mts) { await post('/keywords/create', { adGroupId: g.id, keywordText: text, matchType: mt, bidEur: parseFloat(f.defaultBidEur) || 0.5 }); kw++ }
        }
      }
      setResult(`✓ Created campaign "${f.name}"${extra}${kw ? ` with ${kw} keywords` : ''}.`)
    } finally { setBusy(false) }
  }

  // Step 0 — goal selection (the guided entry point).
  if (!goal) {
    return (
      <div className="max-w-[1100px]">
        <div className="flex items-center justify-between mb-1"><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">What&apos;s your goal?</h1><Link href="/marketing/advertising/architect" className="inline-flex items-center gap-1 text-sm text-violet-600 hover:underline"><Wand2 size={14} /> Or paste keywords (Auto-architect)</Link></div>
        <p className="text-sm text-slate-500 mb-4">Pick a goal and we&apos;ll pre-configure the structure, bidding, and budget — you just confirm. Advanced users can go custom.</p>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {GOALS.map((g) => { const Icon = g.icon; return (
            <button key={g.key} onClick={() => selectGoal(g)} className="text-left p-4 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-blue-400 hover:shadow-sm transition">
              <Icon size={22} className="text-blue-500 mb-2" />
              <div className="font-semibold text-slate-800 dark:text-slate-100">{g.label}</div>
              <div className="text-xs text-slate-500 mt-1">{g.blurb}</div>
            </button>
          ) })}
        </div>
      </div>
    )
  }

  if (!type) {
    return (
      <div className="max-w-[1100px]">
        <button onClick={() => { setGoal(null); setResult(null) }} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"><ChevronLeft size={14} /> Goals</button>
        <div className="flex items-center justify-between mb-4"><h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Choose your campaign type</h1><Link href="/marketing/advertising/architect" className="inline-flex items-center gap-1 text-sm text-violet-600 hover:underline"><Wand2 size={14} /> Or paste keywords (Auto-architect)</Link></div>
        <div className="grid md:grid-cols-3 gap-4">
          {TYPES.map((t) => { const Icon = t.icon; return (
            <button key={t.key} onClick={() => setType(t.key)} className="text-left p-4 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-blue-400 hover:shadow-sm transition">
              <Icon size={22} className="text-blue-500 mb-2" />
              <div className="font-semibold text-slate-800 dark:text-slate-100">{t.label}</div>
              <div className="text-xs text-slate-500 mt-1">{t.blurb}</div>
              <div className="mt-3 inline-block px-3 py-1.5 text-sm rounded-md bg-slate-900 text-white dark:bg-slate-700">Create campaign</div>
            </button>
          ) })}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-[760px]">
      <button onClick={() => { if (goal === 'custom') { setType(null) } else { setGoal(null); setType(null); setGoalTip(null) } setResult(null) }} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2"><ChevronLeft size={14} /> {goal === 'custom' ? 'Campaign type' : 'Goals'}</button>
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-1">New {TYPES.find((t) => t.key === type)!.label}{goal && goal !== 'custom' ? ` · ${GOALS.find((g) => g.key === goal)?.label}` : ''}</h1>
      <p className="text-sm text-slate-500 mb-3">Configure settings, ad group, product, and (manual) keywords. Created via the gated write path (sandbox-safe).</p>
      {goalTip && <div className="text-sm text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/30 rounded-md px-3 py-2 mb-4">💡 {goalTip}</div>}
      <div className="space-y-3">
        <label className="block text-xs text-slate-500">Campaign name<input value={f.name} onChange={(e) => set('name', e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
        <div className="flex gap-2">
          <label className="flex-1 text-xs text-slate-500">Market<select value={f.marketplace} onChange={(e) => set('marketplace', e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950">{['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK'].map((m) => <option key={m}>{m}</option>)}</select></label>
          <label className="flex-1 text-xs text-slate-500">Targeting<select value={f.targetingType} onChange={(e) => set('targetingType', e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"><option value="MANUAL">Manual</option><option value="AUTO">Automatic</option></select></label>
          <label className="flex-1 text-xs text-slate-500">Daily budget €<input value={f.dailyBudgetEur} onChange={(e) => set('dailyBudgetEur', e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
        </div>
        <div className="flex gap-2">
          <label className="flex-1 text-xs text-slate-500">Bidding<select value={f.biddingStrategy} onChange={(e) => set('biddingStrategy', e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"><option value="legacyForSales">Down only</option><option value="autoForSales">Up & down</option><option value="manual">Fixed</option></select></label>
          <label className="flex-1 text-xs text-slate-500">Default bid €<input value={f.defaultBidEur} onChange={(e) => set('defaultBidEur', e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
          <label className="flex-1 text-xs text-slate-500">Ad group name<input value={f.adGroupName} onChange={(e) => set('adGroupName', e.target.value)} placeholder="(auto)" className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
        </div>
        {type === 'SB' ? (
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-3">
            <div className="text-xs font-medium text-slate-600 dark:text-slate-300">Brand creative</div>
            <div className="flex gap-2">
              <label className="flex-1 text-xs text-slate-500">Brand name<input value={f.brandName} onChange={(e) => set('brandName', e.target.value)} placeholder="Xavia" className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
              <label className="flex-1 text-xs text-slate-500">Logo asset id<input value={f.logoAssetId} onChange={(e) => set('logoAssetId', e.target.value)} placeholder="(from Creative Asset Library)" className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
            </div>
            <label className="block text-xs text-slate-500">Headline<input value={f.headline} onChange={(e) => set('headline', e.target.value)} maxLength={50} placeholder="Premium Italian motorcycle gear" className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /><span className="text-[10px] text-slate-400">{f.headline.length}/50</span></label>
            <div className="flex gap-2">
              <label className="flex-1 text-xs text-slate-500">Creative type<select value={f.creativeType} onChange={(e) => set('creativeType', e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"><option value="productCollection">Product collection</option><option value="storeSpotlight">Store spotlight</option><option value="video">Video</option></select></label>
              <label className="flex-1 text-xs text-slate-500">Landing<select value={f.landingType} onChange={(e) => set('landingType', e.target.value)} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"><option value="productList">New landing page</option><option value="store">Store page</option><option value="url">Custom URL</option></select></label>
            </div>
            {f.landingType === 'url' && <label className="block text-xs text-slate-500">Landing URL<input value={f.landingUrl} onChange={(e) => set('landingUrl', e.target.value)} placeholder="https://amazon.it/stores/…" className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /></label>}
            <label className="block text-xs text-slate-500">Featured ASINs (one per line / comma-separated)<textarea value={f.sbAsins} onChange={(e) => set('sbAsins', e.target.value)} rows={3} placeholder="B0XXXXXXXX&#10;B0YYYYYYYY" className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono" /></label>
          </div>
        ) : (
          <label className="block text-xs text-slate-500">Product SKU to advertise<input value={f.productSku} onChange={(e) => set('productSku', e.target.value)} placeholder="MISANO-JACKET-XL-BLACK" className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950" /></label>
        )}
        {f.targetingType === 'MANUAL' && (
          <>
            <label className="block text-xs text-slate-500">Keywords (one per line)<textarea value={f.keywords} onChange={(e) => set('keywords', e.target.value)} rows={6} className="w-full mt-0.5 px-2 py-1.5 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono" /></label>
            <div className="flex gap-3 text-sm">{['EXACT', 'PHRASE', 'BROAD'].map((m) => <label key={m} className="flex items-center gap-1"><input type="checkbox" checked={f.matchTypes[m]} onChange={(e) => set('matchTypes', { ...f.matchTypes, [m]: e.target.checked })} /> {m[0]}{m.slice(1).toLowerCase()}</label>)}</div>
          </>
        )}
        <div className="flex items-center gap-3 pt-1">
          <button onClick={create} disabled={!f.name || busy} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{busy ? 'Creating…' : 'Create campaign'}</button>
          {result && <span className="text-sm text-emerald-700 dark:text-emerald-300">{result} <Link href="/marketing/advertising/campaigns" className="underline">View</Link></span>}
        </div>
      </div>
    </div>
  )
}
