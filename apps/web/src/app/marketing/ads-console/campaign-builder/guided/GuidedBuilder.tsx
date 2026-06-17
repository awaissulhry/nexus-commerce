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

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const exit = () => router.push('/marketing/ads-console/campaigns')
  const filtered = products.filter((p) => !search.trim() || p.name.toLowerCase().includes(search.toLowerCase()))
  const canNext = step === 0 ? !!productGroupName.trim() && selected.size > 0 : true
  const ALGO_LABEL: Record<BidStrategy, string> = { maxImpressions: 'Max Impressions', targetAcos: 'Target ACoS', maxOrders: 'Max Orders', custom: 'Custom', none: 'None' }
  const grp = productGroupName.trim() || 'Guided campaign'
  const spAdGroups = ['Auto', 'Research', 'Performance', ...(includeProductTarget ? ['Product Target'] : [])]
  const agOf = (k: string) => agCfg[k] ?? { bid: '0.45', budget: '25.00' }
  const setAg = (k: string, f: 'bid' | 'budget', v: string) => setAgCfg((m) => ({ ...m, [k]: { ...agOf(k), [f]: v } }))
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
        <button type="button" className="az-cb-exit" onClick={exit}>Exit Builder</button>
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
        {step > 1 && (
          <div className="az-cb-card az-cb-soon">
            <b>{STEPS[step]}</b> — building next (CB.{step + 1}). The wizard shell, stepper and navigation are live; this panel fills in as each step ships.
          </div>
        )}
      </div>

      <div className="az-cb-foot">
        {step > 0 && <button type="button" className="az-cb-btn" onClick={() => setStep((s) => s - 1)}>Back</button>}
        <span className="grow" />
        {step < STEPS.length - 1
          ? <button type="button" className="az-cb-btn dark" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>Next</button>
          : <button type="button" className="az-cb-btn dark" disabled>Launch Campaigns</button>}
      </div>
    </div>
  )
}
