'use client'

/**
 * SPW.0 — SP Super Wizard shell (Helium 10 Ads match). Entered from the Campaign
 * Builder type-chooser "SP Super Wizard" card. Renders INLINE inside the ads shell
 * (the AdsSidebar rail stays visible — unlike the AI-Goal builder's fixed takeover).
 *
 * This phase is chrome only: eyebrow + title + Exit Builder, a 3-step stepper
 * (Product Selection · Campaign Setup · Automation & Launch), a sticky left sub-nav
 * with scroll-spy for step 1, and a Back/Next footer. The step sections are
 * scaffolds — wired in SPW.1 (products) · SPW.2/3 (structure) · SPW.4/5 (setup) ·
 * SPW.6/7 (automation + launch).
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Info } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { ProductSelection, type SpwProduct } from './ProductSelection'
import { StructureSelection, type StructureMode, type AutomationMode } from './StructureSelection'
import { PlacementBidMultiplier, type PlacementBids, emptyPlacementBids } from '../../_shared/PlacementBidMultiplier'
import { CampaignSetup, generateCampaigns, campaignsMissingTargeting, applyAutoNegatives, type SpwCampaign } from './CampaignSetup'
import { TargetingModal } from './TargetingModal'
import { LaunchStep, defaultRulesConfig, rulesConfigured, type RulesConfig } from './LaunchStep'
import { defaultCustomKeywordTypes, defaultCustomTargeting, type CustomKeywordType, type TargetingKind } from './CustomScheme'

type StepN = 1 | 2 | 3
const STEPS: Array<{ n: StepN; label: string }> = [
  { n: 1, label: 'Product Selection' },
  { n: 2, label: 'Campaign Setup' },
  { n: 3, label: 'Automation & Launch' },
]

// Step 1 stacks four sections under a sticky scroll-spy sub-nav.
const S1_SECTIONS = [
  { id: 'product-group', label: 'Product Group Name' },
  { id: 'bid-multiplier', label: 'Bid Multiplier' },
  { id: 'product-selection', label: 'Product Selection' },
  { id: 'structure', label: 'Structure selection' },
]

const EXIT_TO = '/marketing/ads/campaign-builder'

export function SpSuperWizard() {
  const router = useRouter()
  const [step, setStep] = useState<StepN>(1)
  const [activeSec, setActiveSec] = useState('product-group')
  const [productGroupName, setProductGroupName] = useState('')
  const [products, setProducts] = useState<SpwProduct[]>([])
  const [bidMult, setBidMult] = useState<PlacementBids>(emptyPlacementBids())
  const [structureMode, setStructureMode] = useState<StructureMode>('standard')
  const [automationMode, setAutomationMode] = useState<AutomationMode>('rule')
  const [customKeywordTypes, setCustomKeywordTypes] = useState<CustomKeywordType[]>(defaultCustomKeywordTypes())
  const [customTargetingTypes, setCustomTargetingTypes] = useState<TargetingKind[]>(defaultCustomTargeting())
  const [customNameTokens, setCustomNameTokens] = useState<string[]>(['campaignType', 'targetingType', 'matchType', 'keywordType'])
  const [rememberSettings, setRememberSettings] = useState(true)
  const [autoNegate, setAutoNegate] = useState(true)
  const [rules, setRules] = useState<RulesConfig>(defaultRulesConfig())

  // Step 2 campaigns are generated from the step-1 structure; Restore Default re-generates.
  // applyAutoNegatives layers the negative-keyword funnel + Auto-isolation on top (NT.1).
  const baseCampaigns = useMemo(() => applyAutoNegatives(generateCampaigns(productGroupName, structureMode, customKeywordTypes, customTargetingTypes, customNameTokens, products[0]?.asin || products[0]?.sku || ''), autoNegate), [productGroupName, structureMode, customKeywordTypes, customTargetingTypes, customNameTokens, products, autoNegate])
  const [campaigns, setCampaigns] = useState<SpwCampaign[]>(baseCampaigns)
  useEffect(() => { setCampaigns(baseCampaigns) }, [baseCampaigns])
  const [guardOpen, setGuardOpen] = useState(false)
  const [editTgt, setEditTgt] = useState<{ id: string; mode: 'targeting' | 'negative' } | null>(null)
  const [launching, setLaunching] = useState(false)
  const [launchErr, setLaunchErr] = useState('')

  const goNext = useCallback(() => {
    if (step === 2 && campaignsMissingTargeting(campaigns) > 0) { setGuardOpen(true); return }
    setStep((s) => (s < 3 ? ((s + 1) as StepN) : s))
  }, [step, campaigns])
  const goBack = useCallback(() => setStep((s) => (s > 1 ? ((s - 1) as StepN) : s)), [])

  // SPW.7 — gated create: POSTs the wizard plan; the API creates everything in our DB
  // (no Amazon push unless a per-campaign live gate is open), then we land on /campaigns.
  const launch = useCallback(async () => {
    if (launching) return
    setLaunching(true); setLaunchErr('')
    try {
      const payload = {
        market: 'IT',
        productGroupName,
        products: products.map((p) => ({ asin: p.asin || undefined, sku: p.sku || undefined, productId: p.id })),
        campaigns: campaigns.map((c) => ({
          id: c.id, name: c.name, adGroupName: c.adGroupName, kind: c.kind, matchType: c.matchType,
          bidEur: Number(c.bid) || 0.75, budgetEur: Number(c.budget) || 10,
          keywords: c.keywords, productTargets: c.productTargets.map((p) => ({ asin: p.asin || undefined, sku: p.sku || undefined })),
          autoGroups: c.kind === 'auto' ? c.autoGroups.map((g) => ({ key: g.key, enabled: g.enabled, bidEur: Number(g.bid) || Number(c.bid) || 0.75 })) : undefined,
          negKeywords: c.negKeywords.map((n) => ({ text: n.text, matchType: n.matchType })), negProducts: c.negProducts.map((p) => ({ asin: p.asin || undefined, sku: p.sku || undefined })),
        })),
        placementBids: { tos: bidMult.tos, pdp: bidMult.pdp, ros: bidMult.ros },
        rules: rulesConfigured(rules) ? { ruleName: rules.ruleName, automate: rules.automate, perf: rules.perf, rows: rules.sel } : undefined,
      }
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaign-builder/sp-super-wizard/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) throw new Error(j?.error || 'Launch failed')
      router.push('/marketing/ads/campaigns')
    } catch (e) { setLaunchErr((e as Error).message); setLaunching(false) }
  }, [launching, productGroupName, products, campaigns, bidMult, rules, router])

  // Esc closes the "Targeting not set yet" guard (a11y).
  useEffect(() => {
    if (!guardOpen) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setGuardOpen(false) }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [guardOpen])

  // Scroll-spy for the step-1 sub-nav. The scroll container is the .h10-main
  // ancestor, but sections still travel through the viewport as it scrolls, so a
  // default-root IntersectionObserver tracks the topmost visible section.
  useEffect(() => {
    if (step !== 1) return
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (vis[0]) setActiveSec(vis[0].target.id.replace('spw-', ''))
      },
      { rootMargin: '-110px 0px -62% 0px', threshold: 0 },
    )
    S1_SECTIONS.forEach((s) => {
      const el = document.getElementById(`spw-${s.id}`)
      if (el) obs.observe(el)
    })
    return () => obs.disconnect()
  }, [step])

  const gotoSec = (id: string) => document.getElementById(`spw-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div className={`h10-spw${step === 2 ? ' cset' : ''}`}>
      <header className="h10-spw-top">
        <div className="hl">
          <span className="eyebrow">Helium 10 Ads</span>
          <h1>Campaign Builder : SP Super Wizard</h1>
        </div>
        <button type="button" className="h10-spw-exit" onClick={() => router.push(EXIT_TO)}>Exit Builder</button>
      </header>

      <nav className="h10-spw-steps" aria-label="Wizard steps">
        {STEPS.map((s, i) => (
          <Fragment key={s.n}>
            <button
              type="button"
              className={`h10-spw-step ${step === s.n ? 'on' : ''} ${step > s.n ? 'done' : ''}`}
              aria-current={step === s.n ? 'step' : undefined}
              onClick={() => setStep(s.n)}
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
          <div className="h10-spw-s1">
            <aside className="h10-spw-subnav" aria-label="Product Selection sections">
              {S1_SECTIONS.map((s) => (
                <button key={s.id} type="button" className={activeSec === s.id ? 'on' : ''} onClick={() => gotoSec(s.id)}>
                  {s.label}
                </button>
              ))}
            </aside>
            <div className="h10-spw-s1main">
              <section id="spw-product-group" className="h10-spw-sec">
                <h2>Product Group Name</h2>
                <p className="h10-spw-desc">All selected Products will be added to this product group</p>
                <div className="h10-spw-card">
                  <label className="h10-spw-field">
                    <span className="lbl">Product Group Name <i className="req">*</i> <Info size={13} className="ic" /></span>
                    <input value={productGroupName} onChange={(e) => setProductGroupName(e.target.value)} placeholder="Enter a product group name" aria-label="Product group name" />
                  </label>
                </div>
              </section>
              <section id="spw-bid-multiplier" className="h10-spw-sec">
                <h2>Bid Multiplier</h2>
                <p className="h10-spw-desc">Set how much you want to increase your bid based on the placement and platform.</p>
                <div className="h10-spw-card">
                  <PlacementBidMultiplier value={bidMult} onChange={(p) => setBidMult((v) => ({ ...v, ...p }))} />
                </div>
              </section>
              <section id="spw-product-selection" className="h10-spw-sec">
                <h2>Product Selection</h2>
                <p className="h10-spw-desc">Select Amazon product to add to this campaign</p>
                <ProductSelection products={products} setProducts={setProducts} />
              </section>
              <section id="spw-structure" className="h10-spw-sec">
                <h2>Structure selection</h2>
                <p className="h10-spw-desc">Select the structure of campaigns and their naming rule.</p>
                <StructureSelection mode={structureMode} setMode={setStructureMode} automationMode={automationMode} setAutomationMode={setAutomationMode} asinImage={products[0]?.imageUrl ?? null} customKeywordTypes={customKeywordTypes} setCustomKeywordTypes={setCustomKeywordTypes} customTargetingTypes={customTargetingTypes} setCustomTargetingTypes={setCustomTargetingTypes} customNameTokens={customNameTokens} setCustomNameTokens={setCustomNameTokens} previewNames={baseCampaigns.map((c) => c.name)} remember={rememberSettings} setRemember={setRememberSettings} autoNegate={autoNegate} setAutoNegate={setAutoNegate} />
              </section>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="h10-spw-stub-step">
            <h2>Sponsored Product Campaigns</h2>
            <CampaignSetup campaigns={campaigns} setCampaigns={setCampaigns} currency="€" autoNegate={autoNegate} onRestore={() => setCampaigns(baseCampaigns)} onEditTargeting={(id) => setEditTgt({ id, mode: 'targeting' })} onEditNegative={(id) => setEditTgt({ id, mode: 'negative' })} />
          </div>
        )}

        {step === 3 && <LaunchStep campaigns={campaigns} productGroupName={productGroupName} productCount={products.length} currency="€" rules={rules} setRules={setRules} />}
      </div>

      <footer className="h10-spw-foot">
        {step > 1 && <button type="button" className="h10-spw-back" onClick={goBack}>Back</button>}
        <span className="grow" />
        {launchErr && <span className="h10-spw-err">{launchErr}</span>}
        <button type="button" className="h10-spw-next" onClick={() => (step < 3 ? goNext() : void launch())} disabled={launching}>
          {step < 3 ? 'Next' : launching ? 'Launching…' : 'Launch'}
        </button>
      </footer>

      {guardOpen && (
        <div className="h10-spw-guard-back" role="dialog" aria-modal="true" aria-label="Targeting not set yet" onClick={() => setGuardOpen(false)}>
          <div className="h10-spw-guard" onClick={(e) => e.stopPropagation()}>
            <div className="gh">Targeting not set yet</div>
            <p>{campaignsMissingTargeting(campaigns)} Campaigns don&apos;t have any targeting, which will prevent them from running properly.</p>
            <div className="gf">
              <button type="button" className="h10-spw-back" onClick={() => setGuardOpen(false)}>Cancel</button>
              <button type="button" className="h10-spw-next" onClick={() => { setGuardOpen(false); setStep(3) }}>Continue</button>
            </div>
          </div>
        </div>
      )}

      {editTgt && (() => {
        const c = campaigns.find((x) => x.id === editTgt.id)
        if (!c) return null
        return <TargetingModal campaign={c} mode={editTgt.mode} autoNegate={autoNegate} currency="€" onClose={() => setEditTgt(null)} onSave={(patch) => setCampaigns((cs) => applyAutoNegatives(cs.map((x) => (x.id === c.id ? { ...x, ...patch } : x)), autoNegate))} />
      })()}
    </div>
  )
}
