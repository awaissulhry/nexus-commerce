'use client'

/**
 * CBN — AI Advertising · New Product Goal (the "AI Goal" campaign builder), matched
 * to Helium 10 Ads. Full-screen takeover (own top bar; the ads rail is covered).
 * Sections: Product Goal Details · Select AI Target · Product Setup (Budget Mode +
 * Advanced Allocation + Total Budget + Product Selection w/ real product search) ·
 * Keywords (Add Seed [Suggested/List/Enter] + Exclude) · Advanced Targeting (drawer).
 * Reuses the shared `.h10-*` design system + builder icons.
 */
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X, Video, Plus, Search, Trash2, Users, CheckSquare, Share2, BarChart3, ChevronsUpDown, Info, Folder, Check, Settings, Minus } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { IconAtom, IconEye, IconBars, IconLine } from '../../_shell/builder-icons'
import { InfoTip } from '../../campaigns/InfoTip'
// Share — reuse SP Super Wizard's product picker (Search/Enter tabs + variation expansion + N-Added)
// so improvements propagate. Imported as-is; AI Goal maps its output to its own budget-bearing Prod.
import { ProductSelection, type SpwProduct } from '../../campaign-builder/sp-super-wizard/ProductSelection'

type TargetKey = 'impression' | 'sales' | 'roas'
type BudgetMode = 'strict' | 'shared'
type Prod = { id: string; name: string; sku: string; asin: string; imageUrl: string | null; lqs: number; sugLow: number; sugHigh: number; budget: string }
type RawProduct = { id: string; name: string; sku: string; asin?: string | null; imageUrl?: string | null; photoUrl?: string | null; photoCount?: number; channelCount?: number; hasDescription?: boolean; hasGtin?: boolean }

const TARGETS: Array<{ key: TargetKey; title: string; Icon: typeof IconEye; bestFor: string; desc: string }> = [
  { key: 'impression', title: 'Impression & Click', Icon: IconEye, bestFor: 'New Products', desc: 'This strategy aims to increase impressions and clicks. It is suitable for new products that require traffic.' },
  { key: 'sales', title: 'Sales', Icon: IconBars, bestFor: 'Gross Revenue', desc: 'This strategy aims to increase orders and sales. It is suitable for products that require orders or clearing inventory.' },
  { key: 'roas', title: 'ROAS', Icon: IconLine, bestFor: 'Most Scenarios', desc: 'This strategy emphasizes an adjustment mode focused on ROAS/ACOS and is suitable for most scenarios.' },
]
const BUDGET_MODES: Array<{ key: BudgetMode; title: string; Icon: typeof CheckSquare; desc: string; audience: string; chips: string[] }> = [
  { key: 'strict', title: 'Strict Control', Icon: CheckSquare, desc: 'Individual products have independent budgets. AI will create a campaign for each ASIN.', audience: 'Experienced Advertisers | Specialized Campaigns', chips: ['Precision Control', 'Budget Safeguarding', 'Data-Driven', 'Scalability'] },
  { key: 'shared', title: 'Shared Budget', Icon: Share2, desc: 'Users allocate a single budget that is shared across multiple selected products managed by AI.', audience: 'New Advertisers', chips: ['Simplified Management', 'Dynamic Allocation', 'Time-Efficiency'] },
]

const eur = (n: number) => `€${n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
// Derived Listing Quality Score (0–10) from completeness signals we DO have.
function lqsOf(p: RawProduct): number {
  let s = 3 + Math.min(p.photoCount ?? 0, 8) * 0.55 + (p.hasDescription ? 1 : 0) + (p.hasGtin ? 0.8 : 0) + Math.min((p.channelCount ?? 1) - 1, 3) * 0.3
  return Math.max(1, Math.min(10, Math.round(s * 10) / 10))
}
// ── Bridge the shared SPW picker (SpwProduct) ↔ AI Goal's budget-bearing Prod ──
// New pick → derive LQS from the completeness signals the picker carries (image + identifiers); an
// already-added product keeps its real LQS + budget. Authoritative LQS is recomputed server-side at launch.
const spwToProd = (s: SpwProduct, prev?: Prod): Prod => {
  if (prev) return prev
  const lqs = lqsOf({ id: s.id, name: s.name, sku: s.sku, photoCount: s.imageUrl ? 4 : 0, hasDescription: true, hasGtin: !!s.asin, channelCount: 1 })
  const low = Math.round((4 + lqs * 0.8) * 100) / 100
  return { id: s.id, name: s.name, sku: s.sku, asin: s.asin ?? '', imageUrl: s.imageUrl ?? null, lqs, sugLow: low, sugHigh: Math.round(low * 2 * 100) / 100, budget: '' }
}
const prodToSpw = (p: Prod): SpwProduct => ({ id: p.id, name: p.name, sku: p.sku, asin: p.asin, imageUrl: p.imageUrl, parentId: null, childCount: 0 })

export function AiGoalBuilder() {
  const router = useRouter()
  const [goalName, setGoalName] = useState('')
  const [target, setTarget] = useState<TargetKey>('sales') // H10 default is the middle "Sales" card
  const [budgetMode, setBudgetMode] = useState<BudgetMode>('strict')
  const [advAlloc, setAdvAlloc] = useState(false)
  const [sharedBudget, setSharedBudget] = useState('')
  const [products, setProducts] = useState<Prod[]>([])
  const [showAddProducts, setShowAddProducts] = useState(false)
  const [seedTab, setSeedTab] = useState<'suggested' | 'list' | 'enter'>('suggested')
  const [seeds, setSeeds] = useState<string[]>([])
  const [excludeText, setExcludeText] = useState('')
  const [excluded, setExcluded] = useState<string[]>([])
  const [advOpen, setAdvOpen] = useState(false)
  const [productTargets, setProductTargets] = useState<string[]>([])
  const [excludeAsins, setExcludeAsins] = useState<string[]>([])
  const exitTo = '/marketing/ads/campaign-builder'

  const [launching, setLaunching] = useState(false)
  const [launchErr, setLaunchErr] = useState('')
  const totalBudget = useMemo(() => products.reduce((a, p) => a + (Number(p.budget) || 0), 0), [products])
  const setBudget = (id: string, v: string) => setProducts((ps) => ps.map((p) => (p.id === id ? { ...p, budget: v } : p)))
  const removeProduct = (id: string) => setProducts((ps) => ps.filter((p) => p.id !== id))

  // Launch enables once the goal is valid: a name, ≥1 product, and a budget per the mode.
  const valid = goalName.trim().length > 0 && products.length > 0 && (
    budgetMode === 'shared' ? Number(sharedBudget) >= 1 : products.every((p) => Number(p.budget) >= 1)
  )
  const launch = async () => {
    if (!valid || launching) return
    setLaunching(true); setLaunchErr('')
    const payload = {
      name: goalName.trim(),
      aiTarget: target.toUpperCase(),
      budgetMode: budgetMode.toUpperCase(),
      advancedAllocation: advAlloc,
      totalBudgetCents: budgetMode === 'shared' ? Math.round((Number(sharedBudget) || 0) * 100) : null,
      products: products.map((p) => ({ productId: p.id, asin: p.asin, sku: p.sku, name: p.name, imageUrl: p.imageUrl, lqs: p.lqs, budgetCents: Math.round((Number(p.budget) || 0) * 100) })),
      seedKeywords: seeds, excludeKeywords: excluded, productTargets, excludeAsins,
    }
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/ai-goals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) throw new Error(j?.error || 'Could not create the product goal')
      router.push('/marketing/ads/ai-advertising')
    } catch (e) { setLaunchErr((e as Error).message); setLaunching(false) }
  }

  return (
    <div className="h10-aig">
      <header className="h10-aig-top">
        <button type="button" className="x" onClick={() => router.push(exitTo)} aria-label="Close"><X size={20} /></button>
        <span className="brand"><IconAtom size={22} /> AI Advertising</span>
        <span className="sep" />
        <span className="crumb">New Product Goal</span>
        <span className="grow" />
        <button type="button" className="learn"><Video size={15} /> Learn</button>
        <button type="button" className="launch" disabled={!valid || launching} onClick={launch}>{launching ? 'Launching…' : 'Launch'}</button>
      </header>

      <div className="h10-aig-body">
        <div className="h10-aig-wrap">

          <section className="h10-aig-sec">
            <h2>Product Goal Details</h2>
            <div className="h10-aig-card">
              <label className="h10-aig-field">
                <span className="lbl">Goal Name <i className="req">*</i></span>
                <input value={goalName} onChange={(e) => setGoalName(e.target.value)} placeholder="Enter a goal name" />
              </label>
            </div>
          </section>

          <section className="h10-aig-sec">
            <h2>Select AI Target</h2>
            <div className="h10-aig-targets">
              {TARGETS.map((t) => (
                <button type="button" key={t.key} className={`h10-aig-target ${target === t.key ? 'on' : ''}`} onClick={() => setTarget(t.key)}>
                  <span className="ic"><t.Icon size={26} /></span>
                  <span className="ttl">{t.title}</span>
                  <span className="bf">Best for <b>{t.bestFor}</b></span>
                  <span className="desc">{t.desc}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="h10-aig-sec">
            <h2>Product Setup</h2>
            <div className="h10-aig-card">

              <div className="h10-aig-sub">
                <h3>Budget Mode</h3>
                <p>Select a Budget mode based on the application scenario</p>
                <div className="h10-aig-budget">
                  {BUDGET_MODES.map((b) => (
                    <button type="button" key={b.key} className={`h10-aig-bcard ${budgetMode === b.key ? 'on' : ''}`} onClick={() => setBudgetMode(b.key)}>
                      <span className="bh"><span className="bic"><b.Icon size={18} /></span><span className="bt">{b.title}</span></span>
                      <span className="bd">{b.desc}</span>
                      <span className="ba"><Users size={13} /> {b.audience}</span>
                      <span className="bchips">{b.chips.map((c) => <span className={`chip ${budgetMode === b.key ? 'on' : ''}`} key={c}>{c}</span>)}</span>
                    </button>
                  ))}
                </div>
                {budgetMode === 'strict' && (
                  <label className="h10-aig-adv">
                    <input type="checkbox" checked={advAlloc} onChange={(e) => setAdvAlloc(e.target.checked)} />
                    <span className="t">Advanced Allocation</span>
                    <span className="d">When the campaign&apos;s budget is exhausted, AI will analyze the spending capacity and effectiveness of a campaign and allocate the budget more efficiently to the campaign under that goal.</span>
                  </label>
                )}
              </div>

              {budgetMode === 'shared' && (
                <div className="h10-aig-sub">
                  <h3>Total Budget</h3>
                  <span className="h10-aig-money"><span className="pf">€</span><input inputMode="decimal" value={sharedBudget} onChange={(e) => setSharedBudget(e.target.value)} placeholder="Please enter" /></span>
                </div>
              )}

              <div className="h10-aig-sub">
                <h3>Product Selection</h3>
                <p>Select products for AI Advertising to manage</p>
                <div className="h10-aig-pselbar">
                  <span className="cnt">{products.length} Product{products.length > 1 ? 's' : ''} Added</span>
                  <span className="grow" />
                  <button type="button" className="h10-am-btn" disabled={!products.length} onClick={() => setProducts([])}><Trash2 size={13} /> Remove All</button>
                  <button type="button" className="h10-am-btn primary" onClick={() => setShowAddProducts(true)}><Plus size={13} /> Add Products</button>
                </div>
                <div className="h10-aig-psel">
                  <div className={`psel-head ${budgetMode}`}>
                    <span className="c-del" />
                    <span className="c-prod">Product <ChevronsUpDown size={12} /></span>
                    <span className="c-lqs">LQS <ChevronsUpDown size={12} /></span>
                    {budgetMode === 'strict' && <><span className="c-sug">Suggested Budget</span><span className="c-bud">Budget</span></>}
                  </div>
                  {products.length === 0 ? (
                    <div className="psel-empty"><ProductsEmptyArt /><div className="t">No Product Added</div><button type="button" className="h10-am-btn sm" onClick={() => setShowAddProducts(true)}><Plus size={13} /> Add Products</button></div>
                  ) : (
                    <ul className="psel-rows">
                      {products.map((p) => (
                        <li key={p.id} className={budgetMode}>
                          <button type="button" className="del" onClick={() => removeProduct(p.id)} aria-label="Remove"><Trash2 size={15} /></button>
                          <span className="c-prod"><span className="th">{p.imageUrl ? <img src={p.imageUrl} alt="" /> : null}</span><span className="m"><span className="nm">{p.name}</span><span className="id">{p.asin || p.sku}{p.asin && p.sku ? ` · ${p.sku}` : ''}</span></span></span>
                          <span className="c-lqs"><span className="lqs"><BarChart3 size={11} /> {p.lqs.toFixed(1)}</span></span>
                          {budgetMode === 'strict' && <>
                            <span className="c-sug">{eur(p.sugLow)} - {eur(p.sugHigh)}</span>
                            <span className="c-bud"><span className={`h10-aig-money sm ${p.budget && Number(p.budget) < 1 ? 'err' : ''}`}><span className="pf">€</span><input inputMode="decimal" value={p.budget} onChange={(e) => setBudget(p.id, e.target.value)} placeholder="0" /></span></span>
                          </>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {budgetMode === 'strict' && products.length > 0 && (
                    <div className="psel-total"><span>Total Budget:</span><b>{eur(totalBudget)}</b></div>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="h10-aig-sec">
            <h2>Keywords</h2>
            <div className="h10-aig-card">
              <AddSeedKeywords products={products} seeds={seeds} setSeeds={setSeeds} tab={seedTab} setTab={setSeedTab} />
              <div className="h10-aig-sub">
                <h3 className="h10-aig-kwhd"><span className="badge purple"><Minus size={11} strokeWidth={3} /></span> Exclude Keywords</h3>
                <p>Exclude specific search terms from triggering your ads to avoid irrelevant traffic and reduce costs.</p>
                <KeywordEntry placeholder="Enter keywords you do not want to target" text={excludeText} setText={setExcludeText} list={excluded} setList={setExcluded} max={10} />
              </div>
            </div>
          </section>

          <section className="h10-aig-sec">
            <h2>Advanced Targeting</h2>
            <div className="h10-aig-card adv">
              <div className="adv-row">
                <div>
                  <h3>Advanced Targeting</h3>
                  <p>Add or exclude additional types of targets</p>
                </div>
                <button type="button" className="h10-am-btn ghost" onClick={() => setAdvOpen(true)}><Settings size={13} /> Settings</button>
              </div>
              <div className="adv-note"><Info size={15} /><span>If the SP Auto campaign does not immediately generate keywords or product targets (ASINs), the SP KW and SP PAT campaigns will remain in an Incomplete status due to the lack of required inputs. This is normal and may take some time as the SP Auto campaign gathers data. Please be patient and allow the SP Auto campaign to run long enough to identify relevant keywords and targets.</span></div>
            </div>
          </section>

        </div>
      </div>
      <footer className="h10-aig-bottombar">
        <button type="button" className="h10-am-btn" onClick={() => router.push(exitTo)}>Cancel</button>
        <span className="grow" />
        {launchErr && <span className="err">{launchErr}</span>}
        <button type="button" className="launch" disabled={!valid || launching} onClick={launch}>{launching ? 'Launching…' : 'Launch'}</button>
      </footer>

      {showAddProducts && <AddProductsModal selected={products} onClose={() => setShowAddProducts(false)} onApply={(ps) => { setProducts(ps); setShowAddProducts(false) }} />}
      {advOpen && <AdvancedTargetingDrawer productTargets={productTargets} excludeAsins={excludeAsins} onClose={() => setAdvOpen(false)} onSave={(pt, ea) => { setProductTargets(pt); setExcludeAsins(ea); setAdvOpen(false) }} />}
    </div>
  )
}

/* ── Add Seed Keywords: Suggested / Add from List / Enter Keywords + N/10 panel ── */
function AddSeedKeywords({ products, seeds, setSeeds, tab, setTab }: { products: Prod[]; seeds: string[]; setSeeds: (v: string[]) => void; tab: 'suggested' | 'list' | 'enter'; setTab: (t: 'suggested' | 'list' | 'enter') => void }) {
  const [enter, setEnter] = useState('')
  const [folderQ, setFolderQ] = useState('')
  // Suggested keywords derived from selected product names (real-ish opportunity terms).
  const suggested = useMemo(() => {
    const stop = new Set(['the', 'and', 'for', 'with', 'per', 'da', 'di', 'con', 'e', 'a', '300', 'tc', '|'])
    const seen = new Set<string>(); const out: string[] = []
    for (const p of products) for (const w of p.name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
      if (w.length < 4 || stop.has(w) || seen.has(w)) continue; seen.add(w); out.push(w)
    }
    return out.slice(0, 99)
  }, [products])
  const add = (k: string) => { const t = k.trim().toLowerCase(); if (t && !seeds.includes(t) && seeds.length < 10) setSeeds([...seeds, t]) }
  const empty = products.length === 0

  return (
    <div className="h10-aig-sub">
      <h3 className="h10-aig-kwhd"><span className="badge green"><Plus size={11} strokeWidth={3} /></span> Add Seed Keywords</h3>
      <p>AI will automatically analyze the seed keywords you fill in and keywords based on other sources to determine the keywords with most opportunity</p>
      {empty ? (
        <div className="h10-aig-kw-empty"><ProductsEmptyArt /><div className="t">Select a product above to add keywords to this product goal.</div></div>
      ) : (
        <div className="h10-aig-kwgrid">
          <div className="kw-left">
            <div className="h10-aig-seedtabs">
              <button type="button" className={tab === 'suggested' ? 'on' : ''} onClick={() => setTab('suggested')}>Suggested <i>{suggested.length > 98 ? '99+' : suggested.length}</i></button>
              <button type="button" className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>Add from List</button>
              <button type="button" className={tab === 'enter' ? 'on' : ''} onClick={() => setTab('enter')}>Enter Keywords</button>
            </div>
            {tab === 'suggested' && (
              <ul className="h10-aig-suglist">
                {suggested.map((k) => <li key={k}><span>{k}</span><button type="button" disabled={seeds.includes(k) || seeds.length >= 10} onClick={() => add(k)}>{seeds.includes(k) ? <Check size={13} /> : <Plus size={13} />}</button></li>)}
              </ul>
            )}
            {tab === 'list' && (
              <div className="h10-aig-folderbox">
                <div className="h10-dd-search"><Search size={13} /><input value={folderQ} onChange={(e) => setFolderQ(e.target.value)} placeholder="Search for a folder" /></div>
                <div className="h10-aig-folderempty"><Folder size={18} /> No keyword folders yet</div>
              </div>
            )}
            {tab === 'enter' && (
              <textarea className="h10-aig-enter" value={enter} onChange={(e) => setEnter(e.target.value)} onBlur={() => { enter.split(/[\n,]/).forEach(add); setEnter('') }} placeholder="Enter keywords, one per line" />
            )}
          </div>
          <AddedPanel list={seeds} setList={setSeeds} max={10} />
        </div>
      )}
    </div>
  )
}

/* Generic keyword entry (Exclude Keywords): textarea + Add button + N/10 panel. */
function KeywordEntry({ placeholder, text, setText, list, setList, max }: { placeholder: string; text: string; setText: (v: string) => void; list: string[]; setList: (v: string[]) => void; max: number }) {
  const add = () => { const toks = text.split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean); if (!toks.length) return; setList(Array.from(new Set([...list, ...toks])).slice(0, max)); setText('') }
  return (
    <div className="h10-aig-kwgrid">
      <div className="kw-left">
        <textarea className="h10-aig-enter" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
        <div className="h10-aig-kwbtn"><button type="button" className="h10-am-btn primary" disabled={!text.trim() || list.length >= max} onClick={add}>Add Keywords</button></div>
      </div>
      <AddedPanel list={list} setList={setList} max={max} />
    </div>
  )
}

function AddedPanel({ list, setList, max }: { list: string[]; setList: (v: string[]) => void; max: number }) {
  return (
    <div className="kw-added">
      <div className="kw-added-h"><span>{list.length}/{max} Added</span><button type="button" className="rm" onClick={() => setList([])} disabled={!list.length}><Trash2 size={12} /> Remove All</button></div>
      <div className="kw-added-col">Keyword</div>
      {list.length === 0 ? <div className="kw-added-empty"><ProductsEmptyArt /></div> : (
        <ul className="kw-added-list">{list.map((k) => <li key={k}>{k}<button type="button" onClick={() => setList(list.filter((x) => x !== k))} aria-label={`Remove ${k}`}><X size={12} /></button></li>)}</ul>
      )}
    </div>
  )
}

function ProductsEmptyArt() {
  return (
    <svg className="h10-aig-emptyart" viewBox="0 0 80 64" fill="none" aria-hidden>
      <rect x="14" y="10" width="38" height="46" rx="3" fill="#eef2f7" />
      <rect x="20" y="18" width="26" height="3" rx="1.5" fill="#d4dce6" /><rect x="20" y="26" width="26" height="3" rx="1.5" fill="#d4dce6" /><rect x="20" y="34" width="18" height="3" rx="1.5" fill="#d4dce6" />
      <circle cx="50" cy="40" r="13" fill="#fff" stroke="#c2cdda" strokeWidth="2.5" /><line x1="59" y1="49" x2="66" y2="56" stroke="#c2cdda" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/* ── Add Products — reuses the shared SP Super Wizard ProductSelection (Search/Enter tabs +
   parent→child variation expansion + N-Added panel), mapped to AI Goal's budget-bearing Prod. ── */
function AddProductsModal({ selected, onClose, onApply }: { selected: Prod[]; onClose: () => void; onApply: (ps: Prod[]) => void }) {
  const [picked, setPicked] = useState<SpwProduct[]>(selected.map(prodToSpw))
  const apply = () => {
    const prevById = new Map(selected.map((p) => [p.id, p]))
    onApply(picked.map((s) => spwToProd(s, prevById.get(s.id))))
  }
  return (
    <div className="h10-modal-backdrop" onClick={onClose}>
      <div className="h10-modal aig-add" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add Products to Product Selection">
        <div className="h10-modal-h"><b>Add Products to Product Selection</b><button type="button" className="h10-modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        <div className="h10-modal-b">
          <ProductSelection products={picked} setProducts={setPicked} />
        </div>
        <div className="h10-modal-f"><button type="button" className="h10-am-btn" onClick={onClose}>Cancel</button><span className="grow" /><button type="button" className="h10-am-btn primary" disabled={!picked.length} onClick={apply}>Add Products</button></div>
      </div>
    </div>
  )
}

/* ── Advanced Targeting drawer (right slide-over): Product Targets + Exclude ASINs ── */
function AdvancedTargetingDrawer({ productTargets, excludeAsins, onClose, onSave }: { productTargets: string[]; excludeAsins: string[]; onClose: () => void; onSave: (pt: string[], ea: string[]) => void }) {
  const [pt, setPt] = useState(productTargets.join('\n'))
  const [ea, setEa] = useState(excludeAsins.join('\n'))
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean)
  const ptN = lines(pt).length, eaN = lines(ea).length
  return (
    <div className="h10-aig-drawer-back" onClick={onClose}>
      <aside className="h10-aig-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Advanced Targeting">
        <div className="dh"><b>Advanced Targeting</b><button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        <div className="db">
          <div className="dfield"><div className="dl"><span>Product Targets <InfoTip tip="Target specific products (ASINs) so your ads show on their detail pages." /></span><span className="cnt">{ptN}/10 Added</span></div>
            <textarea value={pt} onChange={(e) => setPt(e.target.value)} placeholder="Enter product targets, one per line" /></div>
          <div className="dfield"><div className="dl"><span>Exclude ASINs <InfoTip tip="Stop your ads from showing on these ASINs." /></span><span className="cnt">{eaN} Added</span></div>
            <textarea value={ea} onChange={(e) => setEa(e.target.value)} placeholder="Enter product ASINs you do not want to target, one per line" /></div>
        </div>
        <div className="df"><button type="button" className="h10-am-btn" onClick={onClose}>Cancel</button><span className="grow" /><button type="button" className="h10-am-btn primary" disabled={!ptN && !eaN} onClick={() => onSave(lines(pt), lines(ea))}>Save</button></div>
      </aside>
    </div>
  )
}
