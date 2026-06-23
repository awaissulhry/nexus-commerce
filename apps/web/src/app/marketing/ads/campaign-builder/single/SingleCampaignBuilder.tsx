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
import { Fragment, useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { InfoTip } from '../../campaigns/InfoTip'
import { PortfolioPicker } from '../sp-super-wizard/PortfolioPicker'
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
                <div className="h10-spw-card"><p className="h10-scb-todo">PlacementBidMultiplier (shared) — SB.3</p></div>
              </section>
              <section id="scb-bid-strategy" className="h10-spw-sec">
                <h2>Bid Strategy</h2>
                <p className="h10-spw-desc">Select a bid algorithm based on your product &amp; campaign goals.</p>
                <div className="h10-spw-card"><p className="h10-scb-todo">Shared Bid Strategy cards — SB.3</p></div>
              </section>
              <section id="scb-product-selection" className="h10-spw-sec">
                <h2>Product Selection</h2>
                <p className="h10-spw-desc">Select Amazon product to add to this campaign</p>
                <div className="h10-spw-card"><p className="h10-scb-todo">ProductSelection (shared) — SB.4</p></div>
              </section>
              <section id="scb-budget" className="h10-spw-sec">
                <h2>Budget &amp; Default Bid</h2>
                <div className="h10-spw-card"><p className="h10-scb-todo">Budget + default bid (suggested ranges) — SB.4</p></div>
              </section>
              <section id="scb-targeting" className="h10-spw-sec">
                <h2>Targeting</h2>
                <div className="h10-spw-card"><p className="h10-scb-todo">Keyword / Product targeting — SB.5</p></div>
              </section>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="h10-spw-stub-step">
            <h2>Review and Launch</h2>
            <div className="h10-spw-card"><p className="h10-scb-todo">Campaign recap + launch — SB.7</p></div>
          </div>
        )}
      </div>

      <footer className="h10-spw-foot">
        {step > 1 && <button type="button" className="h10-spw-back" onClick={goBack}>Back</button>}
        <span className="grow" />
        <button type="button" className="h10-spw-next" onClick={() => (step < 2 ? goNext() : undefined)}>
          {step < 2 ? 'Continue' : 'Launch Campaign'}
        </button>
      </footer>
    </div>
  )
}
