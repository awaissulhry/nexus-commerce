'use client'

/**
 * SB.0 — Single Campaign builder shell (Helium 10 Ads match). Entered from the Campaign
 * Builder type-chooser "Single Campaign" card. Renders INLINE inside the ads shell (the
 * AdsSidebar rail stays visible), and deliberately REUSES the SP Super Wizard's `h10-spw-*`
 * shell + shared section components so the two builders stay in lockstep — change a shared
 * piece once, both update.
 *
 * 2-step stepper: (1) Campaign Setup — one scrolling form with a sticky scroll-spy sub-nav
 * over Campaign Details · Campaign Bidding Strategy · Bid Multiplier · Bid Strategy ·
 * Product Selection · Budget & Default Bid · Targeting; (2) Review and Launch. The section
 * bodies are scaffolds here — wired in SB.2 (details/strategy/sites) · SB.3 (bid multiplier
 * + shared Bid Strategy) · SB.4 (products + budget) · SB.5 (targeting) · SB.6 (rules +
 * automation) · SB.7 (review + launch).
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Pencil, Trash2, CheckCircle2 } from 'lucide-react'
import { Input } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { InfoTip } from '../../campaigns/InfoTip'
import { PortfolioPicker } from '../sp-super-wizard/PortfolioPicker'
import { ProductSelection, type SpwProduct } from '../sp-super-wizard/ProductSelection'
import { PlacementBidMultiplier, type PlacementBids, emptyPlacementBids } from '../../_shared/PlacementBidMultiplier'
import { BidStrategyCardGrid, defaultBidConfig, type BidConfig } from '../../_shared/BidStrategy'
import { KeywordTargetingPanel, deriveKeywordSuggestions, type KwBid, type NegKw } from '../../_shared/KeywordTargetingPanel'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './single.css'

// SB.2 — Campaign Bidding Strategy options (verbatim Amazon copy from the recording).
type BiddingStrategy = 'down' | 'updown' | 'fixed'
const BIDDING: Array<{ key: BiddingStrategy; label: string; desc: string }> = [
  { key: 'down', label: 'Dynamic Bids - Down only', desc: 'Amazon lowers your bids in real time when your ad may be less likely to convert to a sale.' },
  { key: 'updown', label: 'Dynamic Bids - Up and Down', desc: 'Amazon raises your bids (by a maximum of 100%) in real time when your ad may be more likely to convert to a sale, and lower your bids when less likely to convert to a sale.' },
  { key: 'fixed', label: 'Fixed Bids', desc: "Amazon uses your exact bid and any manual adjustments you set, and won't change your bids based on likelihood of a sale." },
]
// SB.2 — Sites (placement reach) options.
type SitesOpt = 'amazon' | 'business'
const SITES: Array<{ key: SitesOpt; label: string; desc: string }> = [
  { key: 'amazon', label: 'Amazon and beyond', desc: 'Ads appear on Amazon—including both Amazon retail and Amazon Business—as well as select sites and apps off Amazon.' },
  { key: 'business', label: 'Amazon Business', desc: 'Use a B2B strategy to increase sales and exclusively reach business shoppers on Amazon Business.' },
]

// SB.6 — a rule attached to this campaign: either an existing Rules & Automation rule, or a
// new "Guided campaign Negative" added inline. Persisted at launch (SB.7) via the Rules engine.
interface CampaignRule { id: string; name: string; type: string; ruleId?: string }
const ruleTypeLabel = (r: { trigger?: string | null; name?: string | null }): string => {
  const s = `${r.trigger ?? ''} ${r.name ?? ''}`.toLowerCase()
  if (s.includes('negativ')) return 'Negative Targeting'
  if (s.includes('harvest')) return 'Keyword Harvesting'
  if (s.includes('budget')) return 'Budget'
  if (s.includes('daypart')) return 'Dayparting'
  if (s.includes('bid')) return 'Bid'
  return 'Automation Rule'
}

type StepN = 1 | 2
const STEPS: Array<{ n: StepN; label: string }> = [
  { n: 1, label: 'Campaign Setup' },
  { n: 2, label: 'Review and Launch' },
]
// The two phases within "Campaign Setup", shown as sub-bullets under the stepper.
const SETUP_SUBS = ['Select Campaign Types', 'Campaign Settings']

// Step 1 stacks the campaign-setup sections under a sticky scroll-spy sub-nav.
const S1_SECTIONS = [
  { id: 'details', label: 'Campaign Details' },
  { id: 'bidding-strategy', label: 'Campaign Bidding Strategy' },
  { id: 'bid-multiplier', label: 'Bid Multiplier' },
  { id: 'bid-strategy', label: 'Bid Strategy' },
  { id: 'product-selection', label: 'Product Selection' },
  { id: 'budget', label: 'Budget & Default Bid' },
  { id: 'targeting', label: 'Targeting' },
]

const EXIT_TO = '/marketing/ads/campaign-builder'

export function SingleCampaignBuilder() {
  const router = useRouter()
  const [step, setStep] = useState<StepN>(1)
  const [activeSec, setActiveSec] = useState('details')
  // SB.2 — Campaign Details + Bidding Strategy + Sites
  const [name, setName] = useState('')
  const [adGroup, setAdGroup] = useState('')
  const [portfolioId, setPortfolioId] = useState('')
  const [biddingStrategy, setBiddingStrategy] = useState<BiddingStrategy>('down')
  const [sites, setSites] = useState<SitesOpt>('amazon')
  // SB.3 — Bid Multiplier (shared) + Bid Strategy (shared cards + surface-local config)
  const [bidMult, setBidMult] = useState<PlacementBids>(emptyPlacementBids())
  const [bidConfig, setBidConfig] = useState<BidConfig>(defaultBidConfig())
  const [minMaxOn, setMinMaxOn] = useState(false)
  const setBid = (patch: Partial<BidConfig>) => setBidConfig((b) => ({ ...b, ...patch }))
  // SB.4 — Product Selection + Budget & Default Bid
  const [products, setProducts] = useState<SpwProduct[]>([])
  const [svEnabled, setSvEnabled] = useState<Set<string>>(new Set())
  const toggleSv = (id: string) => setSvEnabled((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const [budget, setBudget] = useState('')
  const [defaultBid, setDefaultBid] = useState('')
  // Data-grounded suggested default bid (account median CPC by intent); budget heuristic ≈ 50× bid.
  const [sugBidEur, setSugBidEur] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/campaign-builder/auto-bid-suggestions?market=IT`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!alive || !j?.groups) return; const v = Object.values(j.groups as Record<string, number>).filter((n) => n > 0).sort((a, b) => a - b); if (v.length) setSugBidEur(v[Math.floor(v.length / 2)] / 100) })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  const sug = (base: number) => ({ val: base.toFixed(2), lo: (base * 0.73).toFixed(2), hi: (base * 1.27).toFixed(2) })
  const sugBid = sugBidEur ? sug(sugBidEur) : null
  const sugBudget = sugBidEur ? sug(sugBidEur * 50) : null
  // SB.5 — Targeting (keyword / product). Suggested keywords derive from the selected products.
  const [targetMode, setTargetMode] = useState<'keyword' | 'product'>('keyword')
  const [keywords, setKeywords] = useState<KwBid[]>([])
  const [negKeywords, setNegKeywords] = useState<NegKw[]>([])
  const [productTargets, setProductTargets] = useState<SpwProduct[]>([])
  const kwSuggestions = useMemo(() => deriveKeywordSuggestions(products.map((p) => p.name)), [products])
  // SB.6 — Campaign Rules (attach existing / add negative — via the Rules engine) + automation
  const [campaignRules, setCampaignRules] = useState<CampaignRule[]>([])
  const [existingRules, setExistingRules] = useState<Array<{ id: string; name: string; type: string }>>([])
  const [addRuleOpen, setAddRuleOpen] = useState(false)
  const [pickMode, setPickMode] = useState(false)
  const [autoBidAdjust, setAutoBidAdjust] = useState(true)
  const [ruleToast, setRuleToast] = useState(false)
  const addRuleRef = useRef<HTMLDivElement>(null)
  const ruleSeq = useRef(0)
  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/automation-rules`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && Array.isArray(j?.items)) setExistingRules(j.items.map((it: { id: string; name: string; trigger?: string }) => ({ id: it.id, name: it.name, type: ruleTypeLabel(it) }))) })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  useEffect(() => {
    const h = (e: MouseEvent) => { if (addRuleRef.current && !addRuleRef.current.contains(e.target as Node)) { setAddRuleOpen(false); setPickMode(false) } }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [])
  const flashToast = () => { setRuleToast(true); window.setTimeout(() => setRuleToast(false), 2500) }
  const addNegativeRule = () => { ruleSeq.current += 1; setCampaignRules((rs) => [...rs, { id: `neg-${ruleSeq.current}`, name: 'Guided campaign Negative', type: 'Negative Targeting' }]); setAddRuleOpen(false); setPickMode(false); flashToast() }
  const attachRule = (r: { id: string; name: string; type: string }) => { setCampaignRules((rs) => (rs.some((x) => x.ruleId === r.id) ? rs : [...rs, { id: `att-${r.id}`, name: r.name, type: r.type, ruleId: r.id }])); setAddRuleOpen(false); setPickMode(false); flashToast() }
  const removeRule = (id: string) => setCampaignRules((rs) => rs.filter((r) => r.id !== id))
  // SB.7 — Review & Launch
  const [launching, setLaunching] = useState(false)
  const [launchErr, setLaunchErr] = useState('')
  const launch = useCallback(async () => {
    if (launching) return
    if (!name.trim()) { setLaunchErr('Enter a campaign name (Campaign Details) before launching.'); return }
    setLaunching(true); setLaunchErr('')
    try {
      const payload = {
        market: 'IT', name: name.trim(), adGroupName: adGroup.trim() || undefined, portfolioId: portfolioId || undefined,
        biddingStrategy, sites,
        placementBids: { tos: bidMult.tos, pdp: bidMult.pdp, ros: bidMult.ros },
        products: products.map((p) => ({ asin: p.asin || undefined, sku: p.sku || undefined, productId: p.id })),
        budgetEur: Number(budget) || undefined, defaultBidEur: Number(defaultBid) || undefined,
        bidConfig: bidConfig.strategy !== 'none' ? bidConfig : undefined,
        targetMode,
        keywords: targetMode === 'keyword' ? keywords.map((k) => ({ text: k.text, matchType: k.matchType, bidEur: Number(k.bidEur) || undefined })) : undefined,
        negKeywords: negKeywords.map((n) => ({ text: n.text, matchType: n.matchType })),
        productTargets: targetMode === 'product' ? productTargets.map((p) => ({ asin: p.asin || undefined, sku: p.sku || undefined })) : undefined,
        addNegativeRule: campaignRules.some((r) => r.type === 'Negative Targeting'),
        attachRuleIds: campaignRules.filter((r) => r.ruleId).map((r) => r.ruleId as string),
        autoBidAdjust,
      }
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaign-builder/single/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) throw new Error(j?.error || 'Launch failed')
      router.push('/marketing/ads/campaigns')
    } catch (e) { setLaunchErr((e as Error).message); setLaunching(false) }
  }, [launching, name, adGroup, portfolioId, biddingStrategy, sites, bidMult, products, budget, defaultBid, bidConfig, targetMode, keywords, negKeywords, productTargets, campaignRules, autoBidAdjust, router])
  const bidLabel = bidConfig.strategy === 'none' ? 'None' : (({ maxImpressions: 'Max Impressions', targetAcos: 'Target ACoS', maxOrders: 'Max Orders', custom: 'Custom' } as Record<string, string>)[bidConfig.strategy] ?? '—')
  const placementParts = [bidMult.tos && `ToS ${bidMult.tos}%`, bidMult.pdp && `PDP ${bidMult.pdp}%`, bidMult.ros && `RoS ${bidMult.ros}%`].filter(Boolean)

  const goNext = useCallback(() => setStep((s) => (s < 2 ? ((s + 1) as StepN) : s)), [])
  const goBack = useCallback(() => setStep((s) => (s > 1 ? ((s - 1) as StepN) : s)), [])

  // Scroll-spy for the step-1 sub-nav (mirrors the SP Super Wizard — same scroll container,
  // a default-root IntersectionObserver tracks the topmost visible section).
  useEffect(() => {
    if (step !== 1) return
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (vis[0]) setActiveSec(vis[0].target.id.replace('scb-', ''))
      },
      { rootMargin: '-110px 0px -62% 0px', threshold: 0 },
    )
    S1_SECTIONS.forEach((s) => {
      const el = document.getElementById(`scb-${s.id}`)
      if (el) obs.observe(el)
    })
    return () => obs.disconnect()
  }, [step])

  const gotoSec = (id: string) => document.getElementById(`scb-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div className="h10-spw h10-scb">
      <header className="h10-spw-top">
        <div className="hl">
          <span className="eyebrow">Helium 10 Ads</span>
          <h1>Campaign Builder : Single Campaign</h1>
        </div>
        <button type="button" className="h10-spw-exit" onClick={() => router.push(EXIT_TO)}>Exit Builder</button>
      </header>

      <nav className="h10-spw-steps" aria-label="Builder steps">
        {STEPS.map((s, i) => (
          <Fragment key={s.n}>
            <button
              type="button"
              className={`h10-spw-step ${step === s.n ? 'on' : ''} ${step > s.n ? 'done' : ''}`}
              aria-current={step === s.n ? 'step' : undefined}
              onClick={() => setStep(s.n)}
            >
              <span className="circ">{s.n}</span>
              <span className="lbl">
                {s.label}
                {s.n === 1 && (
                  <span className="h10-scb-substeps">
                    {SETUP_SUBS.map((t, j) => (
                      <span key={t} className={`ss ${step === 1 && j === 1 ? 'on' : 'done'}`}><span className="dot" />{t}</span>
                    ))}
                  </span>
                )}
              </span>
            </button>
            {i < STEPS.length - 1 && <span className="h10-spw-conn" aria-hidden />}
          </Fragment>
        ))}
      </nav>

      <div className="h10-spw-body">
        {step === 1 && (
          <div className="h10-spw-s1">
            <aside className="h10-spw-subnav" aria-label="Campaign Setup sections">
              {S1_SECTIONS.map((s) => (
                <button key={s.id} type="button" className={activeSec === s.id ? 'on' : ''} onClick={() => gotoSec(s.id)}>
                  {s.label}
                </button>
              ))}
            </aside>
            <div className="h10-spw-s1main">
              <section id="scb-details" className="h10-spw-sec">
                <h2>Campaign Details</h2>
                <div className="h10-spw-card">
                  <div className="h10-scb-fields">
                    <label className="h10-spw-field">
                      <span className="lbl">Campaign Name <i className="req">*</i> <InfoTip tip="The name you'll use to identify this campaign in the Ad Manager and reports." /></span>
                      <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Campaign name" />
                    </label>
                    <label className="h10-spw-field">
                      <span className="lbl">Ad Group Name <i className="req">*</i> <InfoTip tip="An ad group holds the products you advertise together and the targeting that applies to them." /></span>
                      <input value={adGroup} onChange={(e) => setAdGroup(e.target.value)} placeholder="Enter Group name" aria-label="Ad group name" />
                    </label>
                    <div className="h10-spw-field">
                      <span className="lbl">Portfolio (Optional) <InfoTip tip="Group campaigns together to organize your advertising and manage budgets across them." /></span>
                      <PortfolioPicker value={portfolioId} onChange={setPortfolioId} />
                    </div>
                  </div>
                </div>
              </section>
              <section id="scb-bidding-strategy" className="h10-spw-sec">
                <h2>Campaign Bidding Strategy</h2>
                <p className="h10-spw-desc">Select a strategy to optimize your campaign bidding performance</p>
                <div className="h10-spw-card">
                  <div className="h10-scb-radios">
                    {BIDDING.map((o) => (
                      <label key={o.key} className={`h10-scb-radio ${biddingStrategy === o.key ? 'on' : ''}`}>
                        <input type="radio" name="scb-bidding" checked={biddingStrategy === o.key} onChange={() => setBiddingStrategy(o.key)} />
                        <span className="rb"><b>{o.label}</b><span className="d">{o.desc}</span></span>
                      </label>
                    ))}
                  </div>
                </div>

                <h2 className="h10-scb-subsec">Sites</h2>
                <p className="h10-spw-desc">Sites are where your ads appear (websites or apps). Choose placements based on your campaign strategy.</p>
                <div className="h10-spw-card">
                  <div className="h10-scb-radios">
                    {SITES.map((o) => (
                      <label key={o.key} className={`h10-scb-radio ${sites === o.key ? 'on' : ''}`}>
                        <input type="radio" name="scb-sites" checked={sites === o.key} onChange={() => setSites(o.key)} />
                        <span className="rb"><b>{o.label}</b><span className="d">{o.desc}</span></span>
                      </label>
                    ))}
                  </div>
                </div>
              </section>
              <section id="scb-bid-multiplier" className="h10-spw-sec">
                <h2>Bid Multiplier</h2>
                <p className="h10-spw-desc">Set how much you want to increase your bid based on the placement</p>
                <div className="h10-spw-card">
                  <PlacementBidMultiplier value={bidMult} onChange={(p) => setBidMult((v) => ({ ...v, ...p }))} />
                </div>
              </section>
              <section id="scb-bid-strategy" className="h10-spw-sec">
                <h2>Bid Strategy</h2>
                <p className="h10-spw-desc">Select a bid algorithm based on your product &amp; campaign goals.</p>
                <div className="h10-spw-card">
                  <BidStrategyCardGrid value={bidConfig} onChange={setBid} />
                  {bidConfig.strategy !== 'none' && (
                    <div className="h10-scb-bidcfg">
                      {bidConfig.strategy === 'targetAcos' && (
                        <div className="grp">
                          <div className="hd"><b>Target ACoS</b> <InfoTip tip="The advertising cost of sales the algorithm steers toward." /></div>
                          <p>Set a target ACoS value</p>
                          <label className="h10-spw-bidfield"><Input inputMode="decimal" value={bidConfig.targetAcos} onChange={(e) => setBid({ targetAcos: e.target.value })} suffix="%" aria-label="Target ACoS" fieldClassName="h10-spw-bidnum" /></label>
                        </div>
                      )}
                      <div className="grp">
                        <div className="hd"><b>Min/Max Bid</b></div>
                        <p>Set limits to keep your bid within an acceptable range</p>
                        <label className="mm">
                          <input type="checkbox" checked={minMaxOn} onChange={(e) => setMinMaxOn(e.target.checked)} aria-label="Set Min/Max bid limits" />
                          <span className="mm-fields">
                            <Input inputMode="decimal" value={bidConfig.minBid} onChange={(e) => setBid({ minBid: e.target.value })} prefix="€" placeholder="Min" disabled={!minMaxOn} aria-label="Min bid" fieldClassName="h10-spw-bidnum" />
                            <Input inputMode="decimal" value={bidConfig.maxBid} onChange={(e) => setBid({ maxBid: e.target.value })} prefix="€" placeholder="Max" disabled={!minMaxOn} aria-label="Max bid" fieldClassName="h10-spw-bidnum" />
                          </span>
                        </label>
                      </div>
                    </div>
                  )}
                </div>
              </section>
              <section id="scb-product-selection" className="h10-spw-sec">
                <h2>Product Selection</h2>
                <p className="h10-spw-desc">Select Amazon product to add to this campaign</p>
                <ProductSelection products={products} setProducts={setProducts} sponsoredVideo={{ enabled: svEnabled, onToggle: toggleSv }} />
              </section>
              <section id="scb-budget" className="h10-spw-sec">
                <h2>Budget &amp; Default Bid</h2>
                <div className="h10-spw-card">
                  <div className="h10-scb-budget">
                    <div className="fld">
                      <span className="lbl">Daily Budget <i className="req">*</i> <InfoTip tip="The most you'll spend per day on this campaign, on average. Some days may run up to 25% over." /></span>
                      <Input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} prefix="€" aria-label="Daily budget" fieldClassName="h10-scb-money" />
                      {sugBudget && <button type="button" className="sug" onClick={() => setBudget(sugBudget.val)}>Suggested: €{sugBudget.val} <span className="rg">(€{sugBudget.lo} - €{sugBudget.hi})</span></button>}
                    </div>
                    <div className="fld">
                      <span className="lbl">Default Bid <i className="req">*</i> <InfoTip tip="The starting bid applied to targets that don't have their own bid. You can fine-tune per target later." /></span>
                      <Input inputMode="decimal" value={defaultBid} onChange={(e) => setDefaultBid(e.target.value)} prefix="€" aria-label="Default bid" fieldClassName="h10-scb-money" />
                      {sugBid && <button type="button" className="sug" onClick={() => setDefaultBid(sugBid.val)}>Suggested: €{sugBid.val} <span className="rg">(€{sugBid.lo} - €{sugBid.hi})</span></button>}
                    </div>
                  </div>
                </div>
              </section>
              <section id="scb-targeting" className="h10-spw-sec">
                <h2>Targeting</h2>
                <div className="h10-scb-radios h10-scb-tgtmode">
                  <label className={`h10-scb-radio ${targetMode === 'keyword' ? 'on' : ''}`}>
                    <input type="radio" name="scb-tgtmode" checked={targetMode === 'keyword'} onChange={() => setTargetMode('keyword')} />
                    <span className="rb"><b>Keyword Targeting</b></span>
                  </label>
                  <label className={`h10-scb-radio ${targetMode === 'product' ? 'on' : ''}`}>
                    <input type="radio" name="scb-tgtmode" checked={targetMode === 'product'} onChange={() => setTargetMode('product')} />
                    <span className="rb"><b>Product Targeting</b></span>
                  </label>
                </div>
                {targetMode === 'keyword' ? (
                  <>
                    <h3 className="h10-scb-subhead">Add Keywords</h3>
                    <KeywordTargetingPanel keywords={keywords} setKeywords={setKeywords} negKeywords={negKeywords} setNegKeywords={setNegKeywords} suggestions={kwSuggestions} defaultBid={defaultBid} />
                  </>
                ) : (
                  <>
                    <h3 className="h10-scb-subhead">Add Products to Target</h3>
                    <ProductSelection products={productTargets} setProducts={setProductTargets} />
                  </>
                )}
              </section>

              <section className="h10-spw-sec">
                <h2>Campaign Rules</h2>
                <p className="h10-spw-desc">Click on rules to edit or view details. Suggestions generated by rules will appear on the Suggestions Page.</p>
                <div className="h10-spw-card h10-scb-rules">
                  <div className="rh">
                    <span className="cnt">{campaignRules.length} Rule{campaignRules.length === 1 ? '' : 's'}</span>
                    <div className="addwrap" ref={addRuleRef}>
                      <button type="button" className="addbtn" aria-haspopup="menu" aria-expanded={addRuleOpen} onClick={() => { setAddRuleOpen((o) => !o); setPickMode(false) }}><ChevronDown size={15} /> Add Rule</button>
                      {addRuleOpen && (
                        <div className="menu" role="menu">
                          {!pickMode ? (
                            <>
                              <button type="button" role="menuitem" onClick={() => setPickMode(true)}>Add Campaign to Rule</button>
                              <button type="button" role="menuitem" onClick={addNegativeRule}>Add Negative Rule</button>
                            </>
                          ) : (
                            <div className="picklist">
                              <div className="ph">Attach to an existing rule</div>
                              {existingRules.length === 0 ? (
                                <div className="pe">No rules yet. Create one in Rules &amp; Automation.</div>
                              ) : existingRules.map((r) => (
                                <button type="button" key={r.id} role="menuitem" onClick={() => attachRule(r)}><span className="n">{r.name}</span><span className="t">{r.type}</span></button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="tbl">
                    <div className="thd"><span>Rule</span><span>Rule Type</span></div>
                    {campaignRules.length === 0 ? (
                      <div className="nodata">No data</div>
                    ) : campaignRules.map((r) => (
                      <div className="trow" key={r.id}>
                        <span className="rname">
                          <button type="button" className="ic" aria-label={`Edit ${r.name}`}><Pencil size={13} /></button>
                          <button type="button" className="ic del" onClick={() => removeRule(r.id)} aria-label={`Delete ${r.name}`}><Trash2 size={13} /></button>
                          {r.name}
                        </span>
                        <span className="rtype">{r.type}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              <section className="h10-spw-sec">
                <h2>Keyword and Bid Suggestion Automation</h2>
                <p className="h10-spw-desc">Automation makes bid adjustments automatically. You can adjust automation for launched campaigns in Rules &amp; Automation.</p>
                <label className="h10-scb-autotoggle">
                  <button type="button" className={`h10-scb-sw ${autoBidAdjust ? 'on' : ''}`} role="switch" aria-checked={autoBidAdjust} aria-label="Automatic Bid Adjustment" onClick={() => setAutoBidAdjust((v) => !v)}><span /></button>
                  Automatic Bid Adjustment
                </label>
              </section>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="h10-spw-stub-step h10-scb-review">
            <h2>Review and Launch</h2>
            <p className="h10-spw-desc">Review your campaign before launching. Go Back to make changes.</p>
            <div className="h10-spw-card h10-scb-review-card">
              <h3>{name.trim() || 'Untitled campaign'}</h3>
              <div className="grid">
                <div className="f"><span className="l">Ad Group</span><span className="v">{adGroup.trim() || `${name.trim() || 'Campaign'} Ad Group`}</span></div>
                <div className="f"><span className="l">Portfolio</span><span className="v">{portfolioId ? 'Selected' : 'None'}</span></div>
                <div className="f"><span className="l">Bidding Strategy</span><span className="v">{BIDDING.find((x) => x.key === biddingStrategy)?.label ?? '—'}</span></div>
                <div className="f"><span className="l">Sites</span><span className="v">{SITES.find((x) => x.key === sites)?.label ?? '—'}</span></div>
                <div className="f"><span className="l">Daily Budget</span><span className="v">{budget ? `€${budget}` : '—'}</span></div>
                <div className="f"><span className="l">Default Bid</span><span className="v">{defaultBid ? `€${defaultBid}` : '—'}</span></div>
                <div className="f"><span className="l">Bid Strategy</span><span className="v">{bidLabel}{bidConfig.strategy === 'targetAcos' && bidConfig.targetAcos ? ` · ${bidConfig.targetAcos}% ACoS` : ''}</span></div>
                <div className="f"><span className="l">Placement</span><span className="v">{placementParts.length ? placementParts.join(' · ') : 'No adjustments'}</span></div>
                <div className="f"><span className="l">Products</span><span className="v">{products.length}</span></div>
                <div className="f"><span className="l">Targeting</span><span className="v">{targetMode === 'keyword' ? `${keywords.length} keyword${keywords.length === 1 ? '' : 's'}` : `${productTargets.length} product target${productTargets.length === 1 ? '' : 's'}`}{negKeywords.length ? ` · ${negKeywords.length} negative` : ''}</span></div>
                <div className="f"><span className="l">Campaign Rules</span><span className="v">{campaignRules.length}</span></div>
                <div className="f"><span className="l">Auto Bid Adjustment</span><span className="v">{autoBidAdjust ? 'On' : 'Off'}</span></div>
              </div>
            </div>
            {launchErr && <div className="h10-scb-launcherr">{launchErr}</div>}
          </div>
        )}
      </div>

      <footer className="h10-spw-foot">
        {step > 1 && <button type="button" className="h10-spw-back" onClick={goBack}>Back</button>}
        <span className="grow" />
        <button type="button" className="h10-spw-next" onClick={() => (step < 2 ? goNext() : void launch())} disabled={launching}>
          {step < 2 ? 'Continue' : launching ? 'Launching…' : 'Launch Campaign'}
        </button>
      </footer>

      {ruleToast && <div className="h10-scb-toast" role="status"><CheckCircle2 size={16} /> Rule Added!</div>}
    </div>
  )
}
