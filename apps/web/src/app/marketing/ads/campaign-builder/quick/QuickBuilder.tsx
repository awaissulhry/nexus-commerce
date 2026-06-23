'use client'

/**
 * Q.1–Q.5 — Quick campaign builder (Helium 10 Ads match). The "Quick" type from the Campaign
 * Builder chooser — the opinionated *starter funnel* for new sellers, and the only builder
 * that needs zero keyword knowledge. Pick a product group name + ONE bid strategy + products,
 * and Quick generates the canonical 4-campaign harvest funnel —
 *   Auto (discovers search terms) · Research (broad) · Performance (exact) · Product Target
 * — then the harvest automation promotes converting terms out of the Auto/Research campaigns
 * into Performance/Product Target and isolates them in source. (AI Goal hides the structure;
 * SP Super Wizard makes you design it; Quick hands you the right one.)
 *
 * Built from SHARED SP-Super-Wizard pieces (per the build decision — "use the components from
 * there"): the `.h10-spw-*` shell, BidStrategyCardGrid + BidConfig (_shared/BidStrategy),
 * ProductSelection + SpwProduct (sp-super-wizard/), the SpwCampaign model + defaultAutoGroups,
 * and pcDefaultGroup (rules-automation/_shared). It adds ZERO backend: it POSTs a fixed
 * 4-campaign preset + a harvest/negative rules matrix derived from the four automation toggles
 * to the existing SPW launch endpoint, which creates the campaigns + AutomationRules — gated &
 * local-first (nothing hits Amazon until a per-campaign write gate opens; the rules propose on
 * the Suggestions page via control:'manual').
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Layers, BarChart3 } from 'lucide-react'
import { Input } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { InfoTip } from '../../campaigns/InfoTip'
import { ProductSelection, type SpwProduct } from '../sp-super-wizard/ProductSelection'
import { defaultAutoGroups, type SpwCampaign } from '../sp-super-wizard/CampaignSetup'
import { BidStrategyCardGrid, BID_STRATEGIES, defaultBidConfig, type BidConfig } from '../../_shared/BidStrategy'
import { pcDefaultGroup } from '../../rules-automation/_shared/PerformanceCriteria'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import './quick.css'

type StepN = 1 | 2
const STEPS: Array<{ n: StepN; label: string }> = [
  { n: 1, label: 'Product Selection' },
  { n: 2, label: 'Review and Launch' },
]
const EXIT_TO = '/marketing/ads/campaign-builder'
const CURRENCY = '€'
const SUG_LOW = 0.73, SUG_HIGH = 1.27
const FALLBACK_BID = 0.75, BUDGET_MULT = 50 // budget ≈ 50× bid (matches the Helium 10 recording)

// Quick's fixed 4-campaign harvest funnel. Auto discovers; Research (broad) + Performance
// (exact) + Product Target are the harvest destinations the automation fills — so the seller
// enters no keywords at all. The ids double as the rules-matrix keys posted at launch.
type QuickRole = { id: string; role: string; kind: SpwCampaign['kind']; matchType: string }
const QUICK_FUNNEL: QuickRole[] = [
  { id: 'q-auto', role: 'Auto', kind: 'auto', matchType: 'Auto' },
  { id: 'q-research', role: 'Research', kind: 'keyword', matchType: 'Broad' },
  { id: 'q-performance', role: 'Performance', kind: 'keyword', matchType: 'Exact' },
  { id: 'q-product-target', role: 'Product Target', kind: 'pat', matchType: 'PAT' },
]

// Keyword & Bid Suggestion Automation — all ON by default (Helium 10 match). These drive the
// rules matrix posted to the SPW launch endpoint; they create no new backend.
type Toggles = { promotion: boolean; isolation: boolean; bidAdjustment: boolean; negativeAutomation: boolean }
const AUTOMATION: Array<{ key: keyof Toggles; label: string; tip: string }> = [
  { key: 'promotion', label: 'Automatic Keyword Promotion', tip: 'Promote converting search terms from the Auto & Research campaigns into Performance as exact keywords (and converting ASINs into Product Target).' },
  { key: 'isolation', label: 'Search Term Isolation', tip: 'Once a term graduates, negate it in its source campaign so each search term serves from a single campaign.' },
  { key: 'bidAdjustment', label: 'Automatic Bid Adjustment', tip: 'Let the chosen bid algorithm steer bids on a schedule.' },
  { key: 'negativeAutomation', label: 'Negative Keyword Automation', tip: 'Negate wasteful, non-converting search terms automatically.' },
]

const money = (n: number) => `${CURRENCY}${n.toFixed(2)}`

function KindBadge({ kind }: { kind: SpwCampaign['kind'] }) {
  const auto = kind === 'auto'
  return <><span className={`h10-spw-kb ${auto ? 'a' : 'm'}`}>{auto ? 'A' : 'M'}</span><span className="h10-spw-spb">SP</span></>
}

export function QuickBuilder() {
  const router = useRouter()
  const [step, setStep] = useState<StepN>(1)
  const [productGroupName, setProductGroupName] = useState('')
  const [bidConfig, setBidConfig] = useState<BidConfig>(defaultBidConfig())
  const [minMaxOn, setMinMaxOn] = useState(false)
  const [products, setProducts] = useState<SpwProduct[]>([])
  const [toggles, setToggles] = useState<Toggles>({ promotion: true, isolation: true, bidAdjustment: true, negativeAutomation: true })
  const [launching, setLaunching] = useState(false)
  const [launchErr, setLaunchErr] = useState('')

  const setBid = (patch: Partial<BidConfig>) => setBidConfig((b) => ({ ...b, ...patch }))
  const toggle = (k: keyof Toggles) => setToggles((t) => ({ ...t, [k]: !t[k] }))

  // Data-grounded suggested default bid (account median CPC); budget heuristic ≈ 50× bid. Same
  // source as the Single builder (€9.09 bid → €454.25 budget in the recording).
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

  // The funnel rebuilds when the group name or suggested bid changes; per-row bid/budget edits
  // live in `campaigns` (seeded from the funnel, editable on the Review step).
  const baseFunnel = useMemo<SpwCampaign[]>(() => {
    const g = productGroupName.trim() || 'Campaign'
    return QUICK_FUNNEL.map((r) => {
      const name = `${g} - SP - ${r.role}`
      return {
        id: r.id, name, adGroupName: `${name} Ad Group`,
        matchType: r.matchType, keywordType: '-', kind: r.kind,
        bid: sugBid.toFixed(2), budget: sugBudget.toFixed(2), sugBid, sugBudget,
        keywords: [], productTargets: [], negKeywords: [], negProducts: [],
        autoGroups: r.kind === 'auto' ? defaultAutoGroups(sugBid) : [],
      }
    })
  }, [productGroupName, sugBid, sugBudget])
  const [campaigns, setCampaigns] = useState<SpwCampaign[]>(baseFunnel)
  useEffect(() => { setCampaigns(baseFunnel) }, [baseFunnel])
  const updCampaign = (id: string, patch: Partial<SpwCampaign>) => setCampaigns((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)))

  const canNext = productGroupName.trim().length > 0 && products.length > 0
  const goNext = useCallback(() => setStep((s) => (s < 2 ? ((s + 1) as StepN) : s)), [])
  const goBack = useCallback(() => setStep((s) => (s > 1 ? ((s - 1) as StepN) : s)), [])

  const algoLabel = bidConfig.strategy === 'none' ? 'None' : BID_STRATEGIES.find((s) => s.key === bidConfig.strategy)?.label ?? '—'

  // Q.5 — gated launch via the SHARED SP-Super-Wizard endpoint: a fixed 4-campaign preset + a
  // harvest/negative rules matrix derived from the four toggles. Nothing hits Amazon until a
  // per-campaign write gate opens; the rules propose on the Suggestions page (control:'manual').
  const launch = useCallback(async () => {
    if (launching || !canNext) return
    setLaunching(true); setLaunchErr('')
    const grp = productGroupName.trim()
    // Harvest sources are the discovery campaigns (Auto + Research): look for search terms (st),
    // graduate winners to exact (tE) — only Auto graduates converting ASINs to PAT (tBox) — and,
    // when isolation is on, negate the graduated winner in source (nE).
    const harvestRow = (graduateProduct: boolean) => ({ st: true, tB: false, tP: false, tE: toggles.promotion, tBox: graduateProduct && toggles.promotion, nP: false, nE: toggles.isolation, nBox: false })
    // Negative rule negates non-converting search terms (neg-exact) discovered in the same sources.
    const negRow = () => ({ st: true, tB: false, tP: false, tE: false, tBox: false, nP: false, nE: true, nBox: false })
    try {
      const payload = {
        market: 'IT',
        productGroupName: grp,
        products: products.map((p) => ({ asin: p.asin || undefined, sku: p.sku || undefined, productId: p.id })),
        campaigns: campaigns.map((c) => ({
          id: c.id, name: c.name, adGroupName: c.adGroupName, kind: c.kind, matchType: c.matchType,
          bidEur: Number(c.bid) || sugBid, budgetEur: Number(c.budget) || sugBudget,
          keywords: [], productTargets: [],
          autoGroups: c.kind === 'auto' ? c.autoGroups.map((g) => ({ key: g.key, enabled: g.enabled, bidEur: Number(g.bid) || Number(c.bid) || sugBid })) : undefined,
          negKeywords: [], negProducts: [],
        })),
        rules: {
          harvest: (toggles.promotion || toggles.isolation) ? {
            ruleName: `${grp} — Auto Harvest`, automate: true, perf: pcDefaultGroup('keyword-harvesting'),
            rows: { 'q-auto': harvestRow(true), 'q-research': harvestRow(false) },
          } : undefined,
          negative: toggles.negativeAutomation ? {
            ruleName: `${grp} — Negative Targeting`, automate: true, perf: pcDefaultGroup('negative-targeting'),
            rows: { 'q-auto': negRow(), 'q-research': negRow() },
          } : undefined,
        },
        automationMode: 'rule' as const,
        bidConfig: (toggles.bidAdjustment && bidConfig.strategy !== 'none') ? bidConfig : undefined,
      }
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaign-builder/sp-super-wizard/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) throw new Error(j?.error || 'Launch failed')
      router.push('/marketing/ads/campaigns')
    } catch (e) { setLaunchErr((e as Error).message); setLaunching(false) }
  }, [launching, canNext, productGroupName, products, campaigns, toggles, bidConfig, sugBid, sugBudget, router])

  return (
    <div className="h10-spw h10-qcb">
      <header className="h10-spw-top">
        <div className="hl">
          <span className="eyebrow">Helium 10 Ads</span>
          <h1>Campaign Builder : Quick</h1>
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
              onClick={() => { if (s.n === 1 || canNext) setStep(s.n) }}
            >
              <span className="circ">{s.n}</span>
              <span className="lbl">{s.label}</span>
            </button>
            {i < STEPS.length - 1 && <span className="h10-spw-conn" aria-hidden />}
          </Fragment>
        ))}
      </nav>

      <div className="h10-spw-body">
        {step === 1 && (
          <div className="h10-qcb-s1">
            <section className="h10-spw-sec">
              <h2>Product Group Name <i className="req">*</i></h2>
              <p className="h10-spw-desc">All selected Products will be added to this product group</p>
              <div className="h10-spw-card">
                <label className="h10-spw-field">
                  <span className="lbl">Product Group Name <InfoTip tip="A label for the products advertised by this funnel — used in the campaign names and reports." /></span>
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
                  <div className="h10-qcb-bidcfg">
                    {bidConfig.strategy === 'targetAcos' && (
                      <div className="grp">
                        <div className="hd"><b>Target ACoS</b> <InfoTip tip="The advertising cost of sales the algorithm steers toward." /></div>
                        <p>Set a target ACoS value</p>
                        <label className="h10-spw-bidfield"><Input inputMode="decimal" value={bidConfig.targetAcos} onChange={(e) => setBid({ targetAcos: e.target.value })} suffix="%" aria-label="Target ACoS" fieldClassName="h10-spw-bidnum" /></label>
                      </div>
                    )}
                    {bidConfig.strategy !== 'custom' ? (
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
                    ) : (
                      <p className="h10-qcb-custom-note">A custom bid rule will be created for this funnel — fine-tune its performance criteria in Rules &amp; Automation after launch.</p>
                    )}
                  </div>
                )}
              </div>
            </section>

            <section className="h10-spw-sec">
              <h2>Product Selection</h2>
              <p className="h10-spw-desc">Search for the products to advertise in this funnel</p>
              <ProductSelection products={products} setProducts={setProducts} />
            </section>
          </div>
        )}

        {step === 2 && (
          <div className="h10-qcb-review">
            <section className="h10-spw-sec">
              <h2>Sponsored Product Campaigns</h2>
              <p className="h10-spw-desc">Quick generates this {campaigns.length}-campaign harvest funnel from your products. Fine-tune each bid &amp; budget below.</p>
              <div className="h10-spw-card h10-qcb-rev">
                <div className="h10-qcb-rev-head">
                  <span>Ad Group</span><span>Default Bid</span><span>Budget</span><span>Bid Algorithm</span>
                </div>
                {campaigns.map((c) => (
                  <div className="h10-qcb-rev-row" key={c.id}>
                    <div className="ag">
                      <span className="badge"><KindBadge kind={c.kind} /></span>
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
            </section>

            <section className="h10-spw-sec">
              <h2>Keyword and Bid Suggestion Automation</h2>
              <p className="h10-spw-desc">Automation makes bid adjustments automatically. You can adjust automation for launched campaigns in Rules &amp; Automation.</p>
              <div className="h10-spw-card h10-qcb-autom">
                {AUTOMATION.map((a) => (
                  <label key={a.key} className="h10-qcb-toggle">
                    <input type="checkbox" className="h10-spw-sw" checked={toggles[a.key]} onChange={() => toggle(a.key)} aria-label={a.label} />
                    <span className="t">{a.label} <InfoTip tip={a.tip} /></span>
                  </label>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>

      <footer className="h10-spw-foot">
        {step > 1 && <button type="button" className="h10-spw-back" onClick={goBack}>Back</button>}
        <span className="grow" />
        {launchErr && <span className="h10-spw-err">{launchErr}</span>}
        {step === 1 ? (
          <button type="button" className="h10-spw-next" onClick={goNext} disabled={!canNext}>Next</button>
        ) : (
          <button type="button" className="h10-spw-next" onClick={() => void launch()} disabled={launching}>{launching ? 'Launching…' : 'Launch Campaigns'}</button>
        )}
      </footer>
    </div>
  )
}
