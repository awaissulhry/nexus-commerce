'use client'

/**
 * G.1–G.6 — Guided campaign builder (Helium 10 Ads match). The "Guided" type from the Campaign
 * Builder chooser, for experienced sellers — the only builder that spans multiple ad FORMATS in
 * one flow: Sponsored Products + Sponsored Brand + Sponsored Display, with a manual keyword step.
 * (Quick is the SP-only express lane; SP Super Wizard goes deep on SP; Guided goes wide.)
 *
 * 4-step flow: (1) Product Selection — group name + Bid Strategy + Product Selection [= Quick's
 * step 1]; (2) Campaign Setup — Select Campaign Types (SP/SB/SD) then per-type Campaign Settings;
 * (3) Add Keywords — seed the Research campaign; (4) Review and Launch — recap + the harvest/negate
 * Rules matrix + the SP-Wizard control CANVAS, then launch.
 *
 * Built from SHARED pieces (per the build decision): BidStrategyCardGrid (_shared/BidStrategy),
 * ProductSelection + SpwCampaign + defaultAutoGroups (sp-super-wizard/), the NEW shared
 * CampaignTypeSelect + HarvestRules (_shared/, recorded in the design system), KeywordTargetingPanel
 * + deriveKeywordSuggestions (_shared/), the RuleControlPanel canvas (sp-super-wizard/), and
 * PerformanceCriteria. Launch reuses the proven SPW endpoint (one additive `adProduct` field for
 * multi-type) — campaigns + AutomationRules created gated & local-first.
 *
 * SCOPE (SP backbone): SP is fully configured + launches; SB/SD are selectable with minimal
 * settings + launch as managed local shells. Full SB creative + the new DS image-upload component
 * arrive in the follow-up.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Layers, BarChart3, ChevronDown } from 'lucide-react'
import { Input } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { InfoTip } from '../../campaigns/InfoTip'
import { ProductSelection, type SpwProduct } from '../sp-super-wizard/ProductSelection'
import { defaultAutoGroups, type SpwCampaign } from '../sp-super-wizard/CampaignSetup'
import { RuleControlPanel } from '../sp-super-wizard/RuleControlPanel'
import { defaultRulesConfig, type RulesConfig } from '../sp-super-wizard/LaunchStep'
import { BidStrategyCardGrid, BID_STRATEGIES, defaultBidConfig, type BidConfig } from '../../_shared/BidStrategy'
import { CampaignTypeSelect, AD_PRODUCT_META, type AdProduct } from '../../_shared/CampaignTypeSelect'
import { KeywordTargetingPanel, deriveKeywordSuggestions, type KwBid, type NegKw } from '../../_shared/KeywordTargetingPanel'
import { HarvestRules } from '../../_shared/HarvestRules'
import { SponsoredBrandSettings, defaultSbCreative, type SbCreative } from '../../_shared/SponsoredBrandSettings'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './guided.css'

type StepN = 1 | 2 | 3 | 4
const STEPS: Array<{ n: StepN; label: string }> = [
  { n: 1, label: 'Product Selection' },
  { n: 2, label: 'Campaign Setup' },
  { n: 3, label: 'Add Keywords' },
  { n: 4, label: 'Review and Launch' },
]
const SETUP_SUBS = ['Select Campaign Types', 'Campaign Settings']
const EXIT_TO = '/marketing/ads/campaign-builder'
const CURRENCY = '€'
const SUG_LOW = 0.73, SUG_HIGH = 1.27
const FALLBACK_BID = 0.75, BUDGET_MULT = 50
// Registered brand(s) for the Sponsored Brand creative. (Single-brand account — Xavia; a
// multi-brand account would fetch these from the SB registered-brands endpoint.)
const SB_BRANDS = ['Xavia']

type Role = 'Auto' | 'Research' | 'Performance' | 'Product Target'
type GuidedCampaign = SpwCampaign & { adProduct: AdProduct; role: Role }

// Per-format funnels. SP gets the full harvest funnel (+ optional Product Target); SB has no Auto
// (brand campaigns can't auto-target); SD is product-targeting only.
const TYPE_ROLES: Record<AdProduct, Array<{ role: Role; kind: SpwCampaign['kind']; matchType: string; optional?: boolean }>> = {
  SP: [
    { role: 'Auto', kind: 'auto', matchType: 'Auto' },
    { role: 'Research', kind: 'keyword', matchType: 'Broad' },
    { role: 'Performance', kind: 'keyword', matchType: 'Exact' },
    { role: 'Product Target', kind: 'pat', matchType: 'PAT', optional: true },
  ],
  SB: [
    { role: 'Research', kind: 'keyword', matchType: 'Broad' },
    { role: 'Performance', kind: 'keyword', matchType: 'Exact' },
    { role: 'Product Target', kind: 'pat', matchType: 'PAT' },
  ],
  SD: [{ role: 'Product Target', kind: 'pat', matchType: 'PAT' }],
}

const money = (n: number) => `${CURRENCY}${n.toFixed(2)}`

function KindBadge({ kind, adProduct }: { kind: SpwCampaign['kind']; adProduct: AdProduct }) {
  const auto = kind === 'auto'
  return <><span className={`h10-spw-kb ${auto ? 'a' : 'm'}`}>{auto ? 'A' : 'M'}</span><span className="h10-spw-spb">{adProduct}</span></>
}

export function GuidedBuilder() {
  const router = useRouter()
  const [step, setStep] = useState<StepN>(1)
  const [sub, setSub] = useState<0 | 1>(0) // step-2 sub-step: 0 = types, 1 = settings
  const [productGroupName, setProductGroupName] = useState('')
  const [bidConfig, setBidConfig] = useState<BidConfig>(defaultBidConfig())
  const [minMaxOn, setMinMaxOn] = useState(false)
  const [products, setProducts] = useState<SpwProduct[]>([])
  const [types, setTypes] = useState<AdProduct[]>(['SP'])
  const [includePT, setIncludePT] = useState(true) // SP "Include Product Target Campaign"
  const [sbCreative, setSbCreative] = useState<SbCreative>(defaultSbCreative(SB_BRANDS[0]))
  const [namingOpen, setNamingOpen] = useState(false)
  const [keywords, setKeywords] = useState<KwBid[]>([])
  const [negKeywords, setNegKeywords] = useState<NegKw[]>([])
  const [rules, setRules] = useState<{ harvest: RulesConfig; negative: RulesConfig }>({ harvest: defaultRulesConfig('keyword-harvesting'), negative: defaultRulesConfig('negative-targeting') })
  const [portfolioOpen, setPortfolioOpen] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [launchErr, setLaunchErr] = useState('')

  const setBid = (patch: Partial<BidConfig>) => setBidConfig((b) => ({ ...b, ...patch }))

  // Data-grounded suggested bid (account median CPC); budget ≈ 50× bid. Same source as Quick/Single.
  const [sugBidEur, setSugBidEur] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/campaign-builder/auto-bid-suggestions?market=IT`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!alive || !j?.groups) return; const v = Object.values(j.groups as Record<string, number>).filter((n) => n > 0).sort((a, b) => a - b); if (v.length) setSugBidEur(v[Math.floor(v.length / 2)] / 100) })
      .catch(() => {})
    return () => { alive = false }
  }, [])
  const sugBid = sugBidEur && sugBidEur > 0 ? sugBidEur : FALLBACK_BID
  const sugBudget = sugBid * BUDGET_MULT

  // Generate the multi-format campaign set from the selected types (+ SP Product-Target toggle).
  const baseCampaigns = useMemo<GuidedCampaign[]>(() => {
    const g = productGroupName.trim() || 'Guided campaign'
    const out: GuidedCampaign[] = []
    for (const t of AD_PRODUCT_META.map((m) => m.key)) {
      if (!types.includes(t)) continue
      for (const r of TYPE_ROLES[t]) {
        if (r.optional && t === 'SP' && !includePT) continue
        const name = `${g} - ${t} - ${r.role}`
        out.push({
          id: `${t}-${r.role}`.toLowerCase().replace(/\s+/g, '-'),
          name, adGroupName: `${name} Ad Group`, matchType: r.matchType, keywordType: '-', kind: r.kind,
          bid: sugBid.toFixed(2), budget: sugBudget.toFixed(2), sugBid, sugBudget,
          keywords: [], productTargets: [], negKeywords: [], negProducts: [],
          autoGroups: r.kind === 'auto' ? defaultAutoGroups(sugBid) : [],
          adProduct: t, role: r.role,
        })
      }
    }
    return out
  }, [productGroupName, types, includePT, sugBid, sugBudget])
  const [campaigns, setCampaigns] = useState<GuidedCampaign[]>(baseCampaigns)
  // Re-seed when the structure changes, preserving per-row bid/budget/name edits for surviving ids.
  useEffect(() => {
    setCampaigns((prev) => baseCampaigns.map((b) => { const p = prev.find((x) => x.id === b.id); return p ? { ...b, bid: p.bid, budget: p.budget, name: p.name, adGroupName: p.adGroupName } : b }))
  }, [baseCampaigns])
  const updCampaign = (id: string, patch: Partial<GuidedCampaign>) => setCampaigns((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)))

  // Seed sensible harvest/negate defaults for the SP discovery campaigns whenever the SP set
  // changes (preserving any edits the operator already made in the matrix).
  useEffect(() => {
    setRules((r) => {
      const ids = new Set(campaigns.map((c) => c.id))
      const auto = campaigns.find((c) => c.adProduct === 'SP' && c.kind === 'auto')
      const research = campaigns.find((c) => c.adProduct === 'SP' && c.role === 'Research')
      const hsel = { ...r.harvest.sel }; const nsel = { ...r.negative.sel }
      for (const k of Object.keys(hsel)) if (!ids.has(k)) delete hsel[k]
      for (const k of Object.keys(nsel)) if (!ids.has(k)) delete nsel[k]
      const ensure = (obj: Record<string, ReturnType<typeof emptyRow>>, id: string | undefined, val: ReturnType<typeof emptyRow>) => { if (id && !obj[id]) obj[id] = val }
      ensure(hsel, auto?.id, { ...emptyRow(), st: true, tE: true, tBox: includePT, nE: true })
      ensure(hsel, research?.id, { ...emptyRow(), st: true, tE: true, nE: true })
      ensure(nsel, auto?.id, { ...emptyRow(), st: true, nE: true })
      ensure(nsel, research?.id, { ...emptyRow(), st: true, nE: true })
      return { harvest: { ...r.harvest, sel: hsel }, negative: { ...r.negative, sel: nsel } }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaigns.map((c) => c.id).join('|')])

  const algoLabel = bidConfig.strategy === 'none' ? 'None' : BID_STRATEGIES.find((s) => s.key === bidConfig.strategy)?.label ?? '—'
  const stageLabel = bidConfig.strategy === 'none' ? 'None' : BID_STRATEGIES.find((s) => s.key === bidConfig.strategy)?.stage ?? '—'
  const targetValue = bidConfig.strategy === 'targetAcos' && bidConfig.targetAcos.trim() ? `${bidConfig.targetAcos}%` : '—'
  const kwSuggestions = useMemo(() => deriveKeywordSuggestions(products.map((p) => p.name)), [products])

  // Step gating + navigation (step 2 has two sub-steps).
  const canStep1 = productGroupName.trim().length > 0 && products.length > 0
  const canTypes = types.length > 0
  const goNext = useCallback(() => {
    if (step === 1) { setStep(2); setSub(0); return }
    if (step === 2 && sub === 0) { setSub(1); return }
    if (step === 2 && sub === 1) { setStep(3); return }
    if (step === 3) { setStep(4); return }
  }, [step, sub])
  const goBack = useCallback(() => {
    if (step === 2 && sub === 1) { setSub(0); return }
    if (step === 2 && sub === 0) { setStep(1); return }
    if (step === 3) { setStep(2); setSub(1); return }
    if (step === 4) { setStep(3); return }
    setStep((s) => (s > 1 ? ((s - 1) as StepN) : s))
  }, [step, sub])
  const nextDisabled = (step === 1 && !canStep1) || (step === 2 && sub === 0 && !canTypes)

  // G.6 — gated launch via the shared SPW endpoint with an additive per-campaign `adProduct`.
  const launch = useCallback(async () => {
    if (launching) return
    setLaunching(true); setLaunchErr('')
    const grp = productGroupName.trim()
    const researchKw = keywords.filter((k) => k.matchType !== 'EXACT').map((k) => k.text)
    const exactKw = keywords.filter((k) => k.matchType === 'EXACT').map((k) => k.text)
    try {
      const payload = {
        market: 'IT',
        productGroupName: grp,
        products: products.map((p) => ({ asin: p.asin || undefined, sku: p.sku || undefined, productId: p.id })),
        campaigns: campaigns.map((c) => ({
          id: c.id, name: c.name, adGroupName: c.adGroupName, kind: c.kind, matchType: c.matchType, adProduct: c.adProduct,
          bidEur: Number(c.bid) || sugBid, budgetEur: Number(c.budget) || sugBudget,
          keywords: c.kind === 'keyword' ? (c.role === 'Performance' ? exactKw : c.role === 'Research' ? researchKw : []) : [],
          productTargets: [],
          autoGroups: c.kind === 'auto' ? c.autoGroups.map((g) => ({ key: g.key, enabled: g.enabled, bidEur: Number(g.bid) || Number(c.bid) || sugBid })) : undefined,
          negKeywords: c.role === 'Research' ? negKeywords.map((n) => ({ text: n.text, matchType: n.matchType })) : [],
          negProducts: [],
          creative: c.adProduct === 'SB' ? sbCreative : undefined,
        })),
        rules: {
          harvest: { ruleName: rules.harvest.ruleName || `${grp} — Auto Harvest`, automate: rules.harvest.automate, perf: rules.harvest.perf, rows: rules.harvest.sel },
          negative: { ruleName: rules.negative.ruleName || `${grp} — Negative Targeting`, automate: rules.negative.automate, perf: rules.negative.perf, rows: rules.negative.sel },
        },
        automationMode: 'rule' as const,
        bidConfig: bidConfig.strategy !== 'none' ? bidConfig : undefined,
      }
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaign-builder/sp-super-wizard/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) throw new Error(j?.error || 'Launch failed')
      router.push('/marketing/ads/campaigns')
    } catch (e) { setLaunchErr((e as Error).message); setLaunching(false) }
  }, [launching, productGroupName, products, campaigns, keywords, negKeywords, rules, bidConfig, sbCreative, sugBid, sugBudget, router])

  const typeCampaigns = (t: AdProduct) => campaigns.filter((c) => c.adProduct === t)

  return (
    <div className="h10-spw h10-gcb">
      <header className="h10-spw-top">
        <div className="hl">
          <span className="eyebrow">Helium 10 Ads</span>
          <h1>Campaign Builder : Guided</h1>
        </div>
        <button type="button" className="h10-spw-exit" onClick={() => router.push(EXIT_TO)}>Exit Builder</button>
      </header>

      <nav className="h10-spw-steps" aria-label="Builder steps">
        {STEPS.map((s, i) => (
          <Fragment key={s.n}>
            <button type="button" className={`h10-spw-step ${step === s.n ? 'on' : ''} ${step > s.n ? 'done' : ''}`} aria-current={step === s.n ? 'step' : undefined}
              onClick={() => { if (s.n < step || (s.n === 2 && canStep1) || (s.n > 2 && canStep1 && canTypes)) setStep(s.n) }}>
              <span className="circ">{s.n}</span>
              <span className="lbl">
                {s.label}
                {s.n === 2 && (
                  <span className="h10-scb-substeps">
                    {SETUP_SUBS.map((t, j) => <span key={t} className={`ss ${step === 2 && j === sub ? 'on' : step > 2 || (step === 2 && j < sub) ? 'done' : ''}`}><span className="dot" />{t}</span>)}
                  </span>
                )}
              </span>
            </button>
            {i < STEPS.length - 1 && <span className="h10-spw-conn" aria-hidden />}
          </Fragment>
        ))}
      </nav>

      <div className="h10-spw-body">
        {/* Step 1 — Product Selection (= Quick's step 1) */}
        {step === 1 && (
          <div className="h10-gcb-col">
            <section className="h10-spw-sec">
              <h2>Product Group Name <i className="req">*</i></h2>
              <p className="h10-spw-desc">All selected Products will be added to this product group</p>
              <div className="h10-spw-card">
                <label className="h10-spw-field">
                  <span className="lbl">Product Group Name <InfoTip tip="A label for the products advertised across these campaigns — used in the campaign names and reports." /></span>
                  <input value={productGroupName} onChange={(e) => setProductGroupName(e.target.value)} placeholder="Enter product group name here" aria-label="Product group name" />
                </label>
              </div>
            </section>
            <section className="h10-spw-sec">
              <h2>Bid Strategy</h2>
              <p className="h10-spw-desc">Select a bid algorithm based on your product &amp; campaign goals</p>
              <div className="h10-spw-card">
                <BidStrategyCardGrid value={bidConfig} onChange={setBid} />
                {bidConfig.strategy !== 'none' && (
                  <div className="h10-gcb-bidcfg">
                    {bidConfig.strategy === 'targetAcos' && (
                      <div className="grp">
                        <div className="hd"><b>Target ACoS</b> <InfoTip tip="The advertising cost of sales the algorithm steers toward." /></div>
                        <p>Set a target ACoS value</p>
                        <label className="h10-spw-bidfield"><Input inputMode="decimal" value={bidConfig.targetAcos} onChange={(e) => setBid({ targetAcos: e.target.value })} suffix="%" aria-label="Target ACoS" fieldClassName="h10-spw-bidnum" /></label>
                      </div>
                    )}
                    {bidConfig.strategy !== 'custom' && (
                      <div className="grp">
                        <div className="hd"><b>Min/Max Bid</b></div>
                        <p>Set limits to keep your bid within an acceptable range</p>
                        <label className="mm">
                          <input type="checkbox" checked={minMaxOn} onChange={(e) => setMinMaxOn(e.target.checked)} aria-label="Set Min/Max bid limits" />
                          <span className="mm-fields">
                            <Input inputMode="decimal" value={bidConfig.minBid} onChange={(e) => setBid({ minBid: e.target.value })} prefix={CURRENCY} placeholder="Min" disabled={!minMaxOn} aria-label="Min bid" fieldClassName="h10-spw-bidnum" />
                            <Input inputMode="decimal" value={bidConfig.maxBid} onChange={(e) => setBid({ maxBid: e.target.value })} prefix={CURRENCY} placeholder="Max" disabled={!minMaxOn} aria-label="Max bid" fieldClassName="h10-spw-bidnum" />
                          </span>
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
            <section className="h10-spw-sec">
              <h2>Product Selection</h2>
              <p className="h10-spw-desc">Search for the products to advertise across these campaigns</p>
              <ProductSelection products={products} setProducts={setProducts} />
            </section>
          </div>
        )}

        {/* Step 2 — Campaign Setup */}
        {step === 2 && sub === 0 && (
          <div className="h10-gcb-col">
            <section className="h10-spw-sec">
              <h2>Select Campaign Types</h2>
              <p className="h10-spw-desc">Select the campaign types you want to launch. You can add multiple campaign types.</p>
              <CampaignTypeSelect value={types} onChange={setTypes} />
              {types.includes('SD') && (
                <p className="h10-gcb-note">Sponsored Display launches as a Product Targeting campaign — configure its bids &amp; budget in the next step.</p>
              )}
            </section>
          </div>
        )}
        {step === 2 && sub === 1 && (
          <div className="h10-gcb-col">
            {types.map((t) => (
              <section className="h10-spw-sec" key={t}>
                <h2>{AD_PRODUCT_META.find((m) => m.key === t)?.title} Campaign</h2>
                {t === 'SP' && (
                  <label className="h10-gcb-incpt">
                    <input type="checkbox" checked={includePT} onChange={(e) => setIncludePT(e.target.checked)} />
                    <span>Include Product Target Campaign <InfoTip tip="Adds a Product Targeting campaign that targets competitor / complementary ASINs." /></span>
                  </label>
                )}
                {t === 'SB' && (
                  <div className="h10-spw-card h10-gcb-sb">
                    <SponsoredBrandSettings value={sbCreative} onChange={(patch) => setSbCreative((v) => ({ ...v, ...patch }))} products={products} brands={SB_BRANDS} />
                  </div>
                )}
                <div className="h10-spw-card h10-gcb-set">
                  <div className="h10-gcb-set-head"><span>Ad Group</span><span>Default Bid</span><span>Budget</span><span>Bid Algorithm</span></div>
                  {typeCampaigns(t).map((c) => (
                    <div className="h10-gcb-set-row" key={c.id}>
                      <div className="ag">
                        <span className="badge"><KindBadge kind={c.kind} adProduct={c.adProduct} /></span>
                        <div className="nm"><span className="t">{c.name}</span><span className="sub"><Layers size={13} /> {c.adGroupName}</span></div>
                      </div>
                      <div className="num">
                        <div className="money"><span className="pf">{CURRENCY}</span><input inputMode="decimal" value={c.bid} onChange={(e) => updCampaign(c.id, { bid: e.target.value })} aria-label={`Default bid for ${c.name}`} /></div>
                        <div className="sug">Suggested: <b>{money(c.sugBid)}</b> ({money(c.sugBid * SUG_LOW)} - {money(c.sugBid * SUG_HIGH)})</div>
                      </div>
                      <div className="num">
                        <div className="money"><span className="pf">{CURRENCY}</span><input inputMode="decimal" value={c.budget} onChange={(e) => updCampaign(c.id, { budget: e.target.value })} aria-label={`Budget for ${c.name}`} /></div>
                        <div className="sug">Suggested: <b>{money(c.sugBudget)}</b> ({money(c.sugBudget * SUG_LOW)} - {money(c.sugBudget * SUG_HIGH)})</div>
                      </div>
                      <div className="algo"><BarChart3 size={15} /> {algoLabel}</div>
                    </div>
                  ))}
                </div>
                {t === 'SP' && (
                  <>
                    <button type="button" className="h10-gcb-adv" aria-expanded={namingOpen} onClick={() => setNamingOpen((o) => !o)}><ChevronDown size={15} className={namingOpen ? 'up' : ''} /> Advanced Naming Options</button>
                    {namingOpen && (
                      <div className="h10-spw-card h10-gcb-naming">
                        {typeCampaigns('SP').map((c) => (
                          <label className="row" key={c.id}>
                            <span className="l">{c.role} Name</span>
                            <input value={c.name} onChange={(e) => updCampaign(c.id, { name: e.target.value, adGroupName: `${e.target.value} Ad Group` })} aria-label={`${c.role} campaign name`} />
                          </label>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </section>
            ))}
          </div>
        )}

        {/* Step 3 — Add Keywords */}
        {step === 3 && (
          <div className="h10-gcb-col">
            <section className="h10-spw-sec">
              <h2>Add Research Keywords</h2>
              <p className="h10-spw-desc">Seed the Research campaign. Winners are promoted to Performance (Exact) automatically by the harvest rules.</p>
              <KeywordTargetingPanel keywords={keywords} setKeywords={setKeywords} negKeywords={negKeywords} setNegKeywords={setNegKeywords} suggestions={kwSuggestions} defaultBid={sugBid.toFixed(2)} currency={CURRENCY} />
            </section>
          </div>
        )}

        {/* Step 4 — Review and Launch */}
        {step === 4 && (
          <div className="h10-gcb-col">
            <section className="h10-spw-sec">
              <div className="h10-spw-card h10-spw-pgd">
                <h3>Product Group Details</h3>
                <div className="grid">
                  <div className="f"><span className="l">Product Group Name</span><span className="v">{productGroupName.trim() || '—'}</span></div>
                  <div className="f"><span className="l">Number of Products</span><span className="v">{products.length}</span></div>
                  <div className="f"><span className="l">Bid Strategy</span><span className="v"><BarChart3 size={16} className="bi" /> {stageLabel}</span></div>
                  <div className="f"><span className="l">Bid Algorithm</span><span className="v">{algoLabel}</span></div>
                </div>
                <button type="button" className="h10-spw-pgd-port" onClick={() => setPortfolioOpen((o) => !o)}><ChevronDown size={15} className={portfolioOpen ? 'up' : ''} /> Portfolio Association (Optional)</button>
                {portfolioOpen && <p className="h10-gcb-note">Portfolio association arrives with the SB creative follow-up.</p>}
              </div>
            </section>
            <section className="h10-spw-sec">
              <h2>Sponsored Campaign Set</h2>
              <div className="h10-spw-card h10-gcb-set">
                <div className="h10-gcb-rev-head"><span>Ad Group</span><span>Type</span><span>Targeting</span><span>Daily Budget</span><span>Default Bid</span><span>Bid Algorithm</span></div>
                {campaigns.map((c) => (
                  <div className="h10-gcb-rev-row" key={c.id}>
                    <span className="ag"><KindBadge kind={c.kind} adProduct={c.adProduct} /> {c.name}</span>
                    <span>{c.adProduct}</span>
                    <span>{c.kind === 'auto' ? 'Auto' : 'Manual'}</span>
                    <span>{money(Number(c.budget) || 0)}</span>
                    <span>{money(Number(c.bid) || 0)}</span>
                    <span>{algoLabel}{targetValue !== '—' ? ` · ${targetValue}` : ''}</span>
                  </div>
                ))}
              </div>
            </section>
            <section className="h10-spw-sec">
              <HarvestRules rules={rules} setRules={setRules} campaigns={campaigns} />
            </section>
            <section className="h10-spw-sec">
              {/* The SP-Wizard control canvas, driven by these rules (the user's requested addition). */}
              <RuleControlPanel rules={rules} setRules={setRules} bidConfig={bidConfig} setBidConfig={setBidConfig} campaigns={campaigns} />
            </section>
          </div>
        )}
      </div>

      <footer className="h10-spw-foot">
        {(step > 1 || sub > 0) && <button type="button" className="h10-spw-back" onClick={goBack}>Back</button>}
        <span className="grow" />
        {launchErr && <span className="h10-spw-err">{launchErr}</span>}
        {step < 4 ? (
          <button type="button" className="h10-spw-next" onClick={goNext} disabled={nextDisabled}>Next</button>
        ) : (
          <button type="button" className="h10-spw-next" onClick={() => void launch()} disabled={launching}>{launching ? 'Launching…' : 'Launch Campaigns'}</button>
        )}
      </footer>
    </div>
  )
}

function emptyRow() { return { st: false, tB: false, tP: false, tE: false, tBox: false, nP: false, nE: false, nBox: false } }
