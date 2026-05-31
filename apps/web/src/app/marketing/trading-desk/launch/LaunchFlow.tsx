'use client'

/**
 * Trading Desk — Launch (P4). Perpetua-style goal launch: pick a product,
 * choose a strategy + budget + seed keywords, preview the campaign cluster,
 * and create it in one go. Wired to the existing keyword-architect:
 * POST /advertising/architect/{preview,apply}. AUTO_FUNNEL = Auto (discovery)
 * + Broad + Exact + a product ad from the chosen SKU.
 */

import { useEffect, useRef, useState } from 'react'
import { Search, Sparkles, Rocket, Check, Package, X } from 'lucide-react'
import Link from 'next/link'
import { getBackendUrl } from '@/lib/backend-url'

interface Product { id: string; sku: string; name: string; imageUrl?: string | null }
interface PlanKeyword { text: string; matchType: string; bidEur: number }
interface PlanAdGroup { name: string; keywords: PlanKeyword[] }
interface PlanCampaign { name: string; type: string; targetingType: string; dailyBudgetEur: number; adGroups: PlanAdGroup[] }
interface Plan { strategy: string; campaigns: PlanCampaign[]; keywordCount: number; campaignCount: number; adGroupCount: number }

const STRATS = [
  { key: 'AUTO_FUNNEL', name: 'Discovery funnel', desc: 'Auto (discovery) + Broad + Exact. Auto finds new terms; graduate the winners to Exact. Best default.', rec: true },
  { key: 'MATCH_TYPE_SPLIT', name: 'Match-type split', desc: 'Three campaigns — Exact, Phrase, Broad — each with all your seed keywords.', rec: false },
  { key: 'SKAG', name: 'Single-keyword', desc: 'One ad group per keyword (exact). Maximum control for hero terms.', rec: false },
]
const MARKETS = ['IT', 'DE', 'FR', 'ES']
const deriveBase = (name: string) => name.replace(/^XAVIA\s+/i, '').split('|')[0].trim().slice(0, 44)

function Thumb({ url, size = 20 }: { url?: string | null; size?: number }) {
  if (!url) return <Package size={size} />
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" />
}

export function LaunchFlow() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Product[]>([])
  const [showRes, setShowRes] = useState(false)
  const [product, setProduct] = useState<Product | null>(null)
  const [baseName, setBaseName] = useState('')
  const [market, setMarket] = useState('IT')
  const [strategy, setStrategy] = useState('AUTO_FUNNEL')
  const [keywords, setKeywords] = useState('')
  const [budget, setBudget] = useState('15')
  const [bid, setBid] = useState('0.50')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!q.trim() || product) { setResults([]); return }
    clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      const d = await fetch(`${getBackendUrl()}/api/products/search?q=${encodeURIComponent(q)}&limit=8`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ items: [] }))
      setResults(((d.items ?? []) as Product[]).map((p) => ({ id: p.id, sku: p.sku, name: p.name, imageUrl: p.imageUrl })))
      setShowRes(true)
    }, 250)
    return () => clearTimeout(timer.current)
  }, [q, product])

  const pick = (p: Product) => { setProduct(p); setBaseName(deriveBase(p.name)); setShowRes(false); setPlan(null); setResult(null) }
  const clearProduct = () => { setProduct(null); setQ(''); setBaseName(''); setPlan(null) }

  const body = () => ({
    baseName: baseName.trim(), marketplace: market, strategy,
    keywords: keywords.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
    dailyBudgetEur: parseFloat(budget) || 10, defaultBidEur: parseFloat(bid) || 0.5,
    productSku: product?.sku,
  })
  const ready = !!product && !!baseName.trim() && keywords.split(/[\n,]/).some((s) => s.trim()) && !!budget && !!bid

  const preview = async () => {
    setBusy(true); setResult(null)
    try {
      const p = await fetch(`${getBackendUrl()}/api/advertising/architect/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) }).then((r) => r.json())
      if (p?.campaigns) setPlan(p as Plan); else setResult({ ok: false, msg: p?.error || 'Preview failed' })
    } finally { setBusy(false) }
  }
  const launch = async () => {
    setBusy(true); setResult(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/architect/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) }).then((x) => x.json())
      if (r?.ok) { setResult({ ok: true, msg: `Created ${r.created.campaigns} campaigns · ${r.created.adGroups} ad groups · ${r.created.keywords} keywords · ${r.created.productAds} product ad${r.created.productAds === 1 ? '' : 's'}.` }); setPlan(null) }
      else setResult({ ok: false, msg: r?.error || 'Launch failed' })
    } finally { setBusy(false) }
  }

  return (
    <>
      <div className="top">
        <div><h1>Launch a product</h1><div className="sub">Goal-based · AI builds the campaign cluster</div></div>
      </div>

      <div className="scroll">
        <div className="launchwrap">
          {/* Product */}
          <div className="field">
            <label>Product {product && <span className="hint">· SKU {product.sku}</span>}</label>
            {product ? (
              <div className="prodpick">
                <span className="thumb"><Thumb url={product.imageUrl} size={20} /></span>
                <span className="nm">{product.name}</span>
                <button className="chg" onClick={clearProduct}><X size={13} /> change</button>
              </div>
            ) : (
              <div className="prodsearch">
                <div className="search" style={{ width: '100%' }}><Search size={14} /><input placeholder="Search your catalog…" value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => results.length && setShowRes(true)} /></div>
                {showRes && results.length > 0 && (
                  <div className="prodres">
                    {results.map((p) => (
                      <div key={p.id} className="prodopt" onClick={() => pick(p)}>
                        <span className="thumb"><Thumb url={p.imageUrl} size={18} /></span>
                        <span style={{ minWidth: 0 }}><span className="nm">{p.name}</span><div className="sk">{p.sku}</div></span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Base name + market + budget */}
          <div className="field"><label>Campaign base name</label><input className="inp" value={baseName} onChange={(e) => setBaseName(e.target.value)} placeholder="e.g. Giacca Pelle Nera" /></div>
          <div className="row2" style={{ marginBottom: 16 }}>
            <div className="field" style={{ marginBottom: 0 }}><label>Market</label><select className="inp" value={market} onChange={(e) => setMarket(e.target.value)}>{MARKETS.map((m) => <option key={m}>{m}</option>)}</select></div>
            <div className="field" style={{ marginBottom: 0 }}><label>Daily budget (€) <span className="hint">per campaign</span></label><input className="inp" type="number" step="1" min="1" value={budget} onChange={(e) => setBudget(e.target.value)} /></div>
          </div>

          {/* Strategy */}
          <div className="field">
            <label>Strategy</label>
            <div className="stratgrid">
              {STRATS.map((s) => (
                <div key={s.key} className={`strat ${strategy === s.key ? 'on' : ''}`} onClick={() => { setStrategy(s.key); setPlan(null) }}>
                  <div className="sn">{s.name}{s.rec && <span className="rec">RECOMMENDED</span>}</div>
                  <div className="sd">{s.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Keywords + bid */}
          <div className="field"><label>Seed keywords <span className="hint">· one per line or comma-separated</span></label><textarea className="inp" value={keywords} onChange={(e) => { setKeywords(e.target.value); setPlan(null) }} placeholder={'giacca pelle moto\ngiacca racing\ngiubbotto moto estivo'} /></div>
          <div className="row2"><div className="field" style={{ marginBottom: 0 }}><label>Default bid (€)</label><input className="inp" type="number" step="0.01" min="0.02" value={bid} onChange={(e) => setBid(e.target.value)} /></div><div /></div>

          {/* Actions */}
          <div className="launchbar">
            <button className="btn lg" disabled={!ready || busy} onClick={() => void preview()}><Sparkles size={15} />{busy && !plan ? 'Building…' : 'Preview cluster'}</button>
            <button className="btn ok lg" disabled={!ready || busy} onClick={() => void launch()}><Rocket size={15} />{busy && plan ? 'Launching…' : 'Launch'}</button>
            {result && <span className={result.ok ? 'okmsg' : 'errmsg'}>{result.ok ? <><Check size={14} style={{ verticalAlign: 'middle' }} /> {result.msg}</> : result.msg}</span>}
            {result?.ok && <Link className="btn sm" href="/marketing/trading-desk/campaigns">View in Campaigns →</Link>}
          </div>

          {/* Plan preview */}
          {plan && (
            <div style={{ marginTop: 18 }}>
              <div className="sectlbl">Preview · {plan.campaignCount} campaigns · {plan.adGroupCount} ad groups · {plan.keywordCount} keywords</div>
              <div className="planbox">
                {plan.campaigns.map((c, i) => (
                  <div key={i} className="plancamp">
                    <div className="cn">{c.name}<span className={`pill ${c.targetingType === 'AUTO' ? 'a' : 'b'}`}>{c.targetingType}</span></div>
                    <div className="cg">{c.adGroups.length} ad group{c.adGroups.length === 1 ? '' : 's'} · {c.adGroups.reduce((a, g) => a + g.keywords.length, 0)} keywords · €{c.dailyBudgetEur}/day{product ? ' · 1 product ad' : ''}</div>
                  </div>
                ))}
              </div>
              <p className="note" style={{ marginTop: 8 }}>Created via the gated write path (sandbox = DB-only + audit). Target-ACOS management happens automatically once live — tune it in Suggestions / the bid optimizer.</p>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
