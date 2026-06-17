'use client'

/**
 * CB-series — Guided Campaign Builder, a pixel-match of Helium 10 Ads' (Adtomic's)
 * /campaign-builder/guided 4-step wizard, wired (CB.5) to our goal/architect/create
 * backend. CB.1 = scaffold + chrome + 4-step stepper + Step 1 (Product Selection).
 * Steps 2-4 are scaffolded panels filled in by CB.2-CB.4.
 */
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { TrendingUp, BarChart3, Droplets, SlidersHorizontal, type LucideIcon } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

const STEPS = ['Product Selection', 'Campaign Setup', 'Add Keywords', 'Review and Launch'] as const

type BidStrategy = 'maxImpressions' | 'targetAcos' | 'maxOrders' | 'custom' | 'none'
const STRATEGIES: { key: BidStrategy; kicker: string; title: string; desc: string; recommended?: boolean; Icon: LucideIcon }[] = [
  { key: 'maxImpressions', kicker: 'Bid Algorithm', title: 'Max Impressions', desc: 'A bid algorithm for products in a launch stage that need to get as many impressions as possible.', Icon: TrendingUp },
  { key: 'targetAcos', kicker: 'Bid Algorithm', title: 'Target ACoS', desc: 'A bid algorithm for products in a performance stage should target an ACoS for scalable advertising.', recommended: true, Icon: BarChart3 },
  { key: 'maxOrders', kicker: 'Bid Algorithm', title: 'Max Orders', desc: 'A bid algorithm for products in a liquidate stage should bid for maximum orders to clear out inventory.', Icon: Droplets },
  { key: 'custom', kicker: 'Custom Rule', title: 'Custom', desc: "Create a custom rule that adjusts a target's bid based on your set performance criteria.", Icon: SlidersHorizontal },
]

interface Prod { id: string; name: string; asin: string | null; photoUrl: string | null }

export function GuidedBuilder() {
  const router = useRouter()
  const [step, setStep] = useState(0)
  // Step 1 state
  const [productGroupName, setProductGroupName] = useState('')
  const [bidStrategy, setBidStrategy] = useState<BidStrategy>('targetAcos')
  const [targetAcos, setTargetAcos] = useState('30')
  const [products, setProducts] = useState<Prod[]>([])
  const [loadingProducts, setLoadingProducts] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  // Step 2 (Campaign Setup) state
  const [includeProductTarget, setIncludeProductTarget] = useState(true)
  const [agCfg, setAgCfg] = useState<Record<string, { bid: string; budget: string }>>({})
  const [showNaming, setShowNaming] = useState(false)
  const [includeSB, setIncludeSB] = useState(false)
  const [includeSD, setIncludeSD] = useState(false)
  // Step 3 (Add Keywords) state
  const [kwTab, setKwTab] = useState<'research' | 'performance' | 'product'>('research')
  const [kwSource, setKwSource] = useState<'suggested' | 'new' | 'mylist'>('suggested')
  const [matchType, setMatchType] = useState<'Broad' | 'Phrase' | 'Exact'>('Broad')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [newKw, setNewKw] = useState('')
  const [addedKw, setAddedKw] = useState<Array<{ text: string; match: string; bid: string }>>([])
  const [showNegs, setShowNegs] = useState(false)
  const [negKw, setNegKw] = useState('')
  // Step 4 (Review & Launch) state
  const [ruleTab, setRuleTab] = useState<'harvest' | 'negative'>('harvest')
  const [ruleName, setRuleName] = useState('')
  const [ruleMode, setRuleMode] = useState<'automate' | 'isolation'>('automate')
  const [laneCfg, setLaneCfg] = useState<Record<string, { search: boolean; create: string[]; neg: string[] }>>({})
  // CB.5 — launch state
  const [market, setMarket] = useState('IT')
  const [launching, setLaunching] = useState(false)
  const [preview, setPreview] = useState<null | { market: string; campaigns: Array<{ name: string; adGroup: string; targeting: string; productAds: number; keywords: number }>; totalCampaigns: number; totalProductAds: number; totalKeywords: number }>(null)
  const [launchMsg, setLaunchMsg] = useState('')

  useEffect(() => {
    void fetch(`${getBackendUrl()}/api/advertising/by-product`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        const rows = (d.rows ?? d.items ?? d.products ?? []) as Array<Record<string, unknown>>
        setProducts(rows.map((p) => ({
          id: String(p.id ?? p.productId ?? p.asin ?? ''),
          name: String(p.name ?? p.title ?? p.asin ?? 'Untitled'),
          asin: (p.asin as string) ?? (Array.isArray(p.asins) ? (p.asins[0] as string) : null) ?? null,
          photoUrl: (p.photoUrl as string) ?? (p.imageUrl as string) ?? null,
        })).filter((p) => p.id))
      })
      .catch(() => {})
      .finally(() => setLoadingProducts(false))
  }, [])

  // Suggested keywords for Step 3 — derive from the selected products' ASINs (best-effort).
  useEffect(() => {
    if (step !== 2 || suggestions.length) return
    const asins = products.filter((p) => selected.has(p.id)).map((p) => p.asin).filter(Boolean)
    void fetch(`${getBackendUrl()}/api/advertising/goals/suggest-targets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asins, brandTerms: [], limit: 40 }) })
      .then((r) => r.json())
      .then((d) => setSuggestions([...((d.branded as string[]) ?? []), ...((d.unbranded as string[]) ?? [])].filter(Boolean).slice(0, 40)))
      .catch(() => {})
  }, [step, products, selected, suggestions.length])

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const exit = () => router.push('/marketing/ads-console/campaigns')
  const filtered = products.filter((p) => !search.trim() || p.name.toLowerCase().includes(search.toLowerCase()))
  const canNext = step === 0 ? !!productGroupName.trim() && selected.size > 0 : true
  const ALGO_LABEL: Record<BidStrategy, string> = { maxImpressions: 'Max Impressions', targetAcos: 'Target ACoS', maxOrders: 'Max Orders', custom: 'Custom', none: 'None' }
  const grp = productGroupName.trim() || 'Guided campaign'
  const spAdGroups = ['Auto', 'Research', 'Performance', ...(includeProductTarget ? ['Product Target'] : [])]
  const agOf = (k: string) => agCfg[k] ?? { bid: '0.45', budget: '25.00' }
  const setAg = (k: string, f: 'bid' | 'budget', v: string) => setAgCfg((m) => ({ ...m, [k]: { ...agOf(k), [f]: v } }))
  // Step 3 keyword helpers
  const hasKw = (text: string, match: string) => addedKw.some((x) => x.text === text && x.match === match)
  const addKw = (text: string) => setAddedKw((a) => (hasKw(text, matchType) ? a : [...a, { text, match: matchType, bid: '0.45' }]))
  const addAllSuggested = () => setAddedKw((a) => { const seen = new Set(a.map((x) => `${x.text}|${x.match}`)); return [...a, ...suggestions.filter((s) => !seen.has(`${s}|${matchType}`)).map((s) => ({ text: s, match: matchType, bid: '0.45' }))] })
  const addNewKw = () => { const lines = newKw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean); setAddedKw((a) => { const seen = new Set(a.map((x) => `${x.text}|${x.match}`)); const fresh = lines.filter((l) => !seen.has(`${l}|${matchType}`)).map((l) => ({ text: l, match: matchType, bid: '0.45' })); return [...a, ...fresh] }); setNewKw('') }
  const removeKw = (i: number) => setAddedKw((a) => a.filter((_, idx) => idx !== i))
  // CB.5 — launch helpers (preview → confirm → gated create)
  const LIVE_MARKETS = ['IT', 'DE']
  const launchPayload = (dryRun: boolean) => ({
    market, productGroupName: grp, bidStrategy,
    defaultBidEur: Number(agOf('SP:Auto').bid) || 0.45,
    dailyBudgetEur: Number(agOf('SP:Auto').budget) || 25,
    asins: products.filter((p) => selected.has(p.id)).map((p) => p.asin).filter(Boolean),
    includeProductTarget,
    keywords: addedKw.map((k) => ({ text: k.text, match: k.match, bid: Number(k.bid) || undefined })),
    dryRun,
  })
  const post = (dryRun: boolean) => fetch(`${getBackendUrl()}/api/advertising/campaign-builder/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(launchPayload(dryRun)) }).then((r) => r.json())
  const doPreview = async () => { setLaunching(true); setLaunchMsg(''); try { const r = await post(true); if (r.plan) setPreview(r.plan); else setLaunchMsg(r.error ?? 'Could not build preview.') } catch { setLaunchMsg('Preview failed.') } finally { setLaunching(false) } }
  const doLaunch = async () => { setLaunching(true); try { const r = await post(false); if (r.ok) { setPreview(null); setLaunchMsg(`Created ${r.created?.length ?? 0} campaign(s) on ${market} (${r.mode === 'sandbox' || r.mode === 'local' ? 'sandbox — not live on Amazon' : 'LIVE on Amazon'}).`) } else setLaunchMsg(r.error ?? 'Launch failed.') } catch { setLaunchMsg('Launch failed.') } finally { setLaunching(false) } }
  // a render FUNCTION (not a nested component) so the bid/budget inputs don't remount + lose focus each keystroke
  const renderSpTable = (prefix: string, ags: string[]) => (
    <div className="az-cb-tbl">
      <div className="az-cb-tr az-cb-th"><span>Ad Group</span><span>Default Bid</span><span>Budget</span><span>Bid Algorithm</span></div>
      {ags.map((ag) => {
        const k = `${prefix}:${ag}`
        return (
          <div className="az-cb-tr" key={k}>
            <span className="ag"><span className="agname">{grp} - {prefix} - {ag}</span><span className="agsub">{grp} - {prefix} - {ag} Ad Group</span></span>
            <span className="bidc"><span className="fld"><span className="cur">€</span><input value={agOf(k).bid} onChange={(e) => setAg(k, 'bid', e.target.value)} /></span><em>Suggested: €{agOf(k).bid}</em></span>
            <span className="bidc"><span className="fld"><span className="cur">€</span><input value={agOf(k).budget} onChange={(e) => setAg(k, 'budget', e.target.value)} /></span><em>Suggested: €{agOf(k).budget}</em></span>
            <span className="algo">{ALGO_LABEL[bidStrategy]}</span>
          </div>
        )
      })}
    </div>
  )

  return (
    <div className="az-cb">
      <div className="az-cb-head">
        <div>
          <div className="az-cb-kicker">Helium 10 Ads</div>
          <h1 className="az-cb-title">Campaign Builder <span className="az-cb-beta">BETA</span></h1>
        </div>
        <div className="az-cb-headr">
          <label className="az-cb-mktsel"><span>Market</span><select value={market} onChange={(e) => setMarket(e.target.value)}>{['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'SE', 'PL', 'IE', 'UK'].map((m) => <option key={m} value={m}>{m}{LIVE_MARKETS.includes(m) ? ' · live' : ''}</option>)}</select></label>
          <button type="button" className="az-cb-exit" onClick={exit}>Exit Builder</button>
        </div>
      </div>

      <ol className="az-cb-steps">
        {STEPS.map((label, i) => (
          <li key={label} className={`az-cb-step ${i === step ? 'on' : ''} ${i < step ? 'done' : ''}`}>
            <span className="num">{i < step ? '✓' : i + 1}</span>
            <span className="lbl">{label}</span>
          </li>
        ))}
      </ol>

      <div className="az-cb-body">
        {step === 0 && (
          <div className="az-cb-card">
            <div className="az-cb-sec">
              <div className="az-cb-h"><b>Product Group Name</b> <i className="req">*</i></div>
              <div className="az-cb-sub">All selected Products will be added to this product group</div>
              <input className="az-cb-input" value={productGroupName} onChange={(e) => setProductGroupName(e.target.value)} />
            </div>

            <div className="az-cb-sec">
              <div className="az-cb-h"><b>Bid Strategy</b></div>
              <div className="az-cb-sub">Select a bid algorithm based on your product &amp; campaign goals</div>
              <div className="az-cb-cards">
                {STRATEGIES.map((s) => (
                  <button type="button" key={s.key} className={`az-cb-bid ${bidStrategy === s.key ? 'sel' : ''} ${s.recommended ? 'hasrec' : ''}`} onClick={() => setBidStrategy(s.key)}>
                    {s.recommended && <span className="rec">Recommended</span>}
                    <span className="ic"><s.Icon size={17} /></span>
                    <span className="kick">{s.kicker}</span>
                    <span className="ti">{s.title}</span>
                    <span className="de">{s.desc}</span>
                  </button>
                ))}
              </div>
              <button type="button" className={`az-cb-none ${bidStrategy === 'none' ? 'sel' : ''}`} onClick={() => setBidStrategy('none')}>
                <span className="no">⊘</span> None
              </button>
            </div>

            {bidStrategy === 'targetAcos' && (
              <div className="az-cb-sec">
                <div className="az-cb-h"><b>Target ACoS</b></div>
                <div className="az-cb-sub">Set a target ACoS value</div>
                <div className="az-cb-pct"><input className="az-cb-input sm" value={targetAcos} onChange={(e) => setTargetAcos(e.target.value)} /><span>%</span></div>
              </div>
            )}

            <div className="az-cb-sec">
              <div className="az-cb-h"><b>Select Products</b></div>
              <div className="az-cb-sub">{selected.size} selected{products.length ? ` · ${products.length} available` : ''}</div>
              <input className="az-cb-input" placeholder="Search products…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <div className="az-cb-prodlist">
                {filtered.slice(0, 100).map((p) => (
                  <label key={p.id} className={`az-cb-prod ${selected.has(p.id) ? 'on' : ''}`}>
                    <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {p.photoUrl ? <img className="thumb" src={p.photoUrl} alt="" /> : <span className="thumb ph" />}
                    <span className="nm">{p.name}</span>
                    {p.asin && <span className="asin">{p.asin}</span>}
                  </label>
                ))}
                {filtered.length === 0 && <div className="az-cb-empty">{loadingProducts ? 'Loading products…' : products.length ? 'No products match your search.' : 'No products found.'}</div>}
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="az-cb-card">
            <div className="az-cb-camp">
              <div className="az-cb-camp-hd">
                <b>Sponsored Product Campaign</b>
                <label className="az-cb-chk"><input type="checkbox" checked={includeProductTarget} onChange={(e) => setIncludeProductTarget(e.target.checked)} /> Include Product Target Campaign</label>
              </div>
              {renderSpTable('SP', spAdGroups)}
              <button type="button" className="az-cb-link" onClick={() => setShowNaming((s) => !s)}>{showNaming ? '▴' : '▾'} Advanced Naming Options</button>
              {showNaming && <div className="az-cb-sub" style={{ marginTop: 8 }}>Campaign + ad-group names are generated from the product group name; custom naming schemes arrive with the structure builder.</div>}
            </div>

            <div className="az-cb-camp">
              <div className="az-cb-camp-hd">
                <b>Sponsored Brand Campaign</b>
                <label className="az-cb-chk"><input type="checkbox" checked={includeSB} onChange={(e) => setIncludeSB(e.target.checked)} /> Include</label>
              </div>
              {includeSB ? (
                <div className="az-cb-sbset">
                  <label className="az-cb-field"><span>Brand</span><select className="az-cb-input"><option>Select brand to add SB campaign into setup</option></select></label>
                  <div className="az-cb-field"><span>Sponsored Brand Ad Type</span>
                    <div className="az-cb-radios">
                      <label><input type="radio" name="sbtype" defaultChecked /> Product Collection</label>
                      <label><input type="radio" name="sbtype" /> Store Spotlight</label>
                      <label><input type="radio" name="sbtype" /> Brand Video</label>
                    </div>
                  </div>
                  {renderSpTable('SB', ['Performance', 'Research', 'Product Target'])}
                </div>
              ) : <div className="az-cb-sub">Requires Brand Registry. Toggle on to add a Sponsored Brands campaign (ad type, landing page, creative).</div>}
            </div>

            <div className="az-cb-camp">
              <div className="az-cb-camp-hd">
                <b>Sponsored Display Campaign</b>
                <label className="az-cb-chk"><input type="checkbox" checked={includeSD} onChange={(e) => setIncludeSD(e.target.checked)} /> Include</label>
              </div>
              {includeSD ? renderSpTable('SD', ['Product Target']) : <div className="az-cb-sub">Toggle on to add a Sponsored Display (product-targeting) campaign.</div>}
            </div>
          </div>
        )}
        {step === 2 && (
          <div className="az-cb-card">
            <div className="az-cb-kwtabs">
              {([['research', 'Research Keywords'], ['performance', 'Performance Keywords'], ['product', 'Product Targeting ASINs']] as const).map(([k, label]) => (
                <button type="button" key={k} className={kwTab === k ? 'on' : ''} onClick={() => setKwTab(k)}>{label}</button>
              ))}
            </div>
            {kwTab !== 'product' ? (
              <div className="az-cb-kwwrap">
                <div className="az-cb-kwleft">
                  <div className="az-cb-h"><b>Add {kwTab === 'research' ? 'Research' : 'Performance'} Keywords</b></div>
                  <div className="az-cb-srctabs">
                    {([['suggested', 'Suggested Keywords'], ['new', 'Enter New Keywords'], ['mylist', 'Add from My List']] as const).map(([k, label]) => (
                      <button type="button" key={k} className={kwSource === k ? 'on' : ''} onClick={() => setKwSource(k)}>{label}</button>
                    ))}
                  </div>
                  <div className="az-cb-mt">
                    <span className="lab">Match Type:</span>
                    {(['Broad', 'Phrase', 'Exact'] as const).map((m) => (
                      <label key={m}><input type="radio" name="mt" checked={matchType === m} onChange={() => setMatchType(m)} /> {m}</label>
                    ))}
                    <span className="grow" />
                    {kwSource === 'suggested' && <button type="button" className="az-cb-addall" onClick={addAllSuggested}>+ Add All</button>}
                  </div>
                  {kwSource === 'suggested' && (
                    <div className="az-cb-sugg">
                      {suggestions.length ? suggestions.map((s) => (
                        <div className="row" key={s}><span>{s}</span><button type="button" className="add" onClick={() => addKw(s)} disabled={hasKw(s, matchType)}>+ Add</button></div>
                      )) : <div className="az-cb-empty">No suggestions yet — use &ldquo;Enter New Keywords&rdquo;.</div>}
                    </div>
                  )}
                  {kwSource === 'new' && (
                    <div className="az-cb-newkw">
                      <textarea value={newKw} onChange={(e) => setNewKw(e.target.value)} placeholder="Enter or paste keywords (one per line or comma-separated)" />
                      <button type="button" className="az-cb-btn dark sm" onClick={addNewKw} disabled={!newKw.trim()}>+ Add Keywords</button>
                    </div>
                  )}
                  {kwSource === 'mylist' && <div className="az-cb-empty">Saved keyword lists will appear here.</div>}
                  <button type="button" className="az-cb-link" onClick={() => setShowNegs((s) => !s)}>{showNegs ? '▴' : '▾'} Advanced Negative Keywords (Optional)</button>
                  {showNegs && <textarea className="az-cb-negs" value={negKw} onChange={(e) => setNegKw(e.target.value)} placeholder="Negative keywords (one per line)" />}
                </div>
                <div className="az-cb-kwright">
                  <div className="hd"><b>{addedKw.length} Keywords Added</b>{addedKw.length > 0 && <button type="button" onClick={() => setAddedKw([])}>Remove All</button>}</div>
                  <div className="th"><span>Keyword</span><span>Match</span><span>SP Bid</span><span /></div>
                  <div className="rows">
                    {addedKw.length ? addedKw.map((k, i) => (
                      <div className="r" key={`${k.text}|${k.match}`}><span className="kw">{k.text}</span><span className="mt">{k.match}</span><span className="bid">€{k.bid}</span><button type="button" onClick={() => removeKw(i)} aria-label="Remove">✕</button></div>
                    )) : <div className="az-cb-empty">No data</div>}
                  </div>
                </div>
              </div>
            ) : (
              <div className="az-cb-newkw">
                <div className="az-cb-h"><b>Product Targeting ASINs</b></div>
                <div className="az-cb-sub">Target competitor or complementary product detail pages by ASIN.</div>
                <textarea value={newKw} onChange={(e) => setNewKw(e.target.value)} placeholder="Enter ASINs (one per line)" />
                <button type="button" className="az-cb-btn dark sm" onClick={addNewKw} disabled={!newKw.trim()}>+ Add ASINs</button>
              </div>
            )}
          </div>
        )}
        {step === 3 && (
          <div className="az-cb-card">
            <div className="az-cb-camp">
              <div className="az-cb-h"><b>Review</b></div>
              <div className="az-cb-review">
                <div>Product group: <b>{grp}</b> · {selected.size} product{selected.size === 1 ? '' : 's'}</div>
                <div>Sponsored Products: <b>{spAdGroups.length}</b> ad group{spAdGroups.length === 1 ? '' : 's'} · bid algorithm <b>{ALGO_LABEL[bidStrategy]}</b></div>
                {includeSB && <div>Sponsored Brands: <b>included</b></div>}
                {includeSD && <div>Sponsored Display: <b>included</b></div>}
                <div>Keywords: <b>{addedKw.length}</b></div>
              </div>
            </div>

            <div className="az-cb-camp">
              <div className="az-cb-kwtabs">
                <button type="button" className={ruleTab === 'harvest' ? 'on' : ''} onClick={() => setRuleTab('harvest')}>Keyword Harvesting</button>
                <button type="button" className={ruleTab === 'negative' ? 'on' : ''} onClick={() => setRuleTab('negative')}>Negative Targeting</button>
              </div>
              <label className="az-cb-field" style={{ maxWidth: 380 }}><span>Rule Name</span><input className="az-cb-input" value={ruleName} onChange={(e) => setRuleName(e.target.value)} placeholder={`${grp} Promotion`} /></label>
              <div className="az-cb-mt" style={{ marginTop: 12 }}>
                <label><input type="radio" name="rulemode" checked={ruleMode === 'automate'} onChange={() => setRuleMode('automate')} /> Automate</label>
                <label><input type="radio" name="rulemode" checked={ruleMode === 'isolation'} onChange={() => setRuleMode('isolation')} /> Search Term Isolation</label>
              </div>
              <div className="az-cb-matrix">
                <div className="mh"><span>Ad Group</span><span>Look for Search Terms</span><span>Create New Targets</span><span>Create New Negative Targets</span></div>
                {spAdGroups.map((ag) => {
                  const k = `SP:${ag}`
                  const c = laneCfg[k] ?? { search: true, create: [] as string[], neg: [] as string[] }
                  const setL = (patch: Partial<typeof c>) => setLaneCfg((m) => ({ ...m, [k]: { ...c, ...patch } }))
                  const tog = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])
                  return (
                    <div className="mr" key={k}>
                      <span className="agc">{grp} - SP - {ag}</span>
                      <span className="ck"><input type="checkbox" checked={c.search} onChange={(e) => setL({ search: e.target.checked })} /></span>
                      <span className="chips">{['Broad', 'Phrase', 'Exact', 'Product'].map((t) => <button type="button" key={t} className={c.create.includes(t) ? 'on' : ''} onClick={() => setL({ create: tog(c.create, t) })} title={t}>{t === 'Product' ? 'PT' : t[0]}</button>)}</span>
                      <span className="chips neg">{['Phrase', 'Exact', 'Product'].map((t) => <button type="button" key={t} className={c.neg.includes(t) ? 'on' : ''} onClick={() => setL({ neg: tog(c.neg, t) })} title={`Negative ${t}`}>{t === 'Product' ? 'PT' : t[0]}</button>)}</span>
                    </div>
                  )
                })}
              </div>
              <div className="az-cb-crit">
                <div className="row"><span className="tag if">IF</span><select className="az-cb-input sm"><option>PPC Orders</option><option>ACOS</option><option>Spend</option><option>Clicks</option></select><select className="az-cb-input sm"><option>&ge;</option><option>&gt;</option><option>&le;</option></select><input className="az-cb-input sm" defaultValue="1" /></div>
                <div className="row"><span className="tag then">THEN</span><span>Create new target &amp; set the starting bid to</span><select className="az-cb-input sm"><option>Set to Current CPC</option><option>Set to Ad Group Default</option><option>Set Custom Bid</option><option>Set to Current CPC + %</option></select></div>
                <div className="row"><span className="lab">Lookback period</span><select className="az-cb-input sm"><option>Last 60 Days</option><option>Last 30 Days</option><option>Last 90 Days</option></select><span>Exclude</span><select className="az-cb-input sm"><option>Last 3 Days</option><option>None</option></select></div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="az-cb-foot">
        {step > 0 && <button type="button" className="az-cb-btn" onClick={() => setStep((s) => s - 1)}>Back</button>}
        <span className="grow" />
        {step < STEPS.length - 1
          ? <button type="button" className="az-cb-btn dark" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>Next</button>
          : <button type="button" className="az-cb-btn dark" disabled={launching || selected.size === 0} onClick={() => void doPreview()}>{launching ? 'Working…' : 'Launch Campaigns'}</button>}
      </div>

      {launchMsg && <div className="az-cb-toast" role="status">{launchMsg}<button type="button" onClick={() => setLaunchMsg('')} aria-label="Dismiss">✕</button></div>}
      {preview && (
        <div className="az-cb-modal" role="dialog" aria-modal="true" onClick={() => setPreview(null)}>
          <div className="box" onClick={(e) => e.stopPropagation()}>
            <div className="hd">Review what will be created on <b>{preview.market}</b></div>
            {LIVE_MARKETS.includes(preview.market)
              ? <div className="note live"><b>{preview.market} is live</b> — confirming creates these as <b>real campaigns on Amazon</b>. New campaigns aren&rsquo;t auto-allowlisted, so their bids won&rsquo;t change until you opt them in.</div>
              : <div className="note sandbox">{preview.market} is not live — these are created in <b>sandbox</b> (nothing reaches Amazon) until you take {preview.market} live in Settings.</div>}
            <div className="sum">{preview.totalCampaigns} campaign{preview.totalCampaigns === 1 ? '' : 's'} · {preview.totalProductAds} product ad{preview.totalProductAds === 1 ? '' : 's'} · {preview.totalKeywords} keyword{preview.totalKeywords === 1 ? '' : 's'}</div>
            <div className="list">
              {preview.campaigns.map((c) => <div className="row" key={c.name}><span className="nm">{c.name}</span><span className="meta">{c.targeting} · {c.productAds} ASIN{c.productAds === 1 ? '' : 's'}{c.keywords ? ` · ${c.keywords} kw` : ''}</span></div>)}
            </div>
            <div className="ft">
              <button type="button" className="az-cb-btn" onClick={() => setPreview(null)}>Cancel</button>
              <span className="grow" />
              <button type="button" className="az-cb-btn dark" disabled={launching} onClick={() => void doLaunch()}>{launching ? 'Creating…' : `Create on ${preview.market}`}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
