'use client'

/**
 * AX3.2 — Replicate Structure, the sixth campaign-builder type.
 *
 * Replication used to live at /marketing/ads/blueprints, in the nav rail, away
 * from every other way of creating a campaign. It belongs here: it IS a way of
 * creating campaigns, and it shares this wizard's chrome, its product picker and
 * its portfolio picker.
 *
 * Same three-step shape as the SP Super Wizard — pick what you are copying and
 * what you are copying it onto, review and edit it, then check and launch. The
 * self-competition gate is unchanged and still blocking: this surface only
 * changes where the decisions are made, never whether they are made.
 */
import { Fragment, useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Info } from 'lucide-react'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import { SourcePicker, emptySelection, type SourceSelection } from './SourcePicker'

type StepN = 1 | 2 | 3
const STEPS: Array<{ n: StepN; label: string }> = [
  { n: 1, label: 'Source & Products' },
  { n: 2, label: 'Review & Edit' },
  { n: 3, label: 'Preflight & Launch' },
]

const S1_SECTIONS = [
  { id: 'source', label: 'Source structure' },
  { id: 'copy', label: 'What to copy' },
  { id: 'naming', label: 'Naming' },
  { id: 'products', label: 'Product Selection' },
  { id: 'destination', label: 'Destination' },
]

const MARKETS = ['IT', 'DE', 'FR', 'ES']
const EXIT_TO = '/marketing/ads/campaign-builder'

export function ReplicateBuilder() {
  const router = useRouter()
  const [step, setStep] = useState<StepN>(1)
  const [activeSec, setActiveSec] = useState('source')
  const [market, setMarket] = useState('IT')
  const [selectedAdGroups, setSelectedAdGroups] = useState<Set<string>>(new Set())
  const [source, setSource] = useState<SourceSelection>(emptySelection())

  // Changing market invalidates a selection made against another market's tree.
  useEffect(() => { setSelectedAdGroups(new Set()) }, [market])

  const onSource = useCallback((s: SourceSelection) => setSource(s), [])

  // Scroll-spy for the step-1 sub-nav, matching the SP Super Wizard's.
  useEffect(() => {
    if (step !== 1) return
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (vis[0]) setActiveSec(vis[0].target.id.replace('rep-', ''))
      },
      { rootMargin: '-110px 0px -62% 0px', threshold: 0 },
    )
    S1_SECTIONS.forEach((s) => { const el = document.getElementById(`rep-${s.id}`); if (el) obs.observe(el) })
    return () => obs.disconnect()
  }, [step])

  const gotoSec = (id: string) => document.getElementById(`rep-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  const canAdvance = source.campaigns > 0

  return (
    <div className="h10-spw h10-rep">
      <header className="h10-spw-top">
        <div className="hl">
          <span className="eyebrow">Helium 10 Ads</span>
          <h1>Campaign Builder : Replicate Structure</h1>
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
            <aside className="h10-spw-subnav" aria-label="Source and product sections">
              {S1_SECTIONS.map((s) => (
                <button key={s.id} type="button" className={activeSec === s.id ? 'on' : ''} onClick={() => gotoSec(s.id)}>{s.label}</button>
              ))}
            </aside>
            <div className="h10-spw-s1main">
              <section id="rep-source" className="h10-spw-sec">
                <h2>Source structure</h2>
                <p className="h10-spw-desc">
                  Choose what to copy. Tick a whole portfolio, individual campaigns, or single ad groups —
                  an ad group brings its campaign with it, because Amazon has no ad group without one.
                </p>
                <div className="h10-rep-market" role="group" aria-label="Source marketplace">
                  <span className="lbl"><Info size={13} aria-hidden /> Reading from</span>
                  {MARKETS.map((m) => (
                    <button key={m} type="button" className={market === m ? 'on' : ''} onClick={() => setMarket(m)} aria-pressed={market === m}>{m}</button>
                  ))}
                </div>
                <SourcePicker market={market} selected={selectedAdGroups} setSelected={setSelectedAdGroups} onChange={onSource} />
                <SourceSummary s={source} />
              </section>

              <section id="rep-copy" className="h10-spw-sec">
                <h2>What to copy</h2>
                <p className="h10-spw-desc">Choose which parts of the structure come across. Lands in AX3.3.</p>
                <div className="h10-spw-card h10-rep-todo">Next phase.</div>
              </section>
              <section id="rep-naming" className="h10-spw-sec">
                <h2>Naming</h2>
                <p className="h10-spw-desc">Rename everything in bulk, with a preview of every old and new name. Lands in AX3.3.</p>
                <div className="h10-spw-card h10-rep-todo">Next phase.</div>
              </section>
              <section id="rep-products" className="h10-spw-sec">
                <h2>Product Selection</h2>
                <p className="h10-spw-desc">The products the copied campaigns will advertise. Lands in AX3.3.</p>
                <div className="h10-spw-card h10-rep-todo">Next phase.</div>
              </section>
              <section id="rep-destination" className="h10-spw-sec">
                <h2>Destination</h2>
                <p className="h10-spw-desc">Target market, portfolio, budget cap and bid policy. Lands in AX3.3.</p>
                <div className="h10-spw-card h10-rep-todo">Next phase.</div>
              </section>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="h10-spw-stub-step">
            <h2>Review &amp; Edit</h2>
            <p className="h10-spw-desc">Every campaign, ad group and keyword, editable and deletable before anything is created. Lands in AX3.4.</p>
            <div className="h10-spw-card h10-rep-todo">Next phase.</div>
          </div>
        )}

        {step === 3 && (
          <div className="h10-spw-stub-step">
            <h2>Preflight &amp; Launch</h2>
            <p className="h10-spw-desc">Totals, blockers, the self-competition ledger, and the launch itself. Lands in AX3.5.</p>
            <div className="h10-spw-card h10-rep-todo">Next phase.</div>
          </div>
        )}
      </div>

      <footer className="h10-spw-foot">
        {step > 1 && <button type="button" className="h10-spw-back" onClick={() => setStep((s) => (s > 1 ? ((s - 1) as StepN) : s))}>Back</button>}
        <span className="grow" />
        {step === 1 && !canAdvance && <span className="h10-rep-hint">Select at least one campaign or ad group to continue</span>}
        <button
          type="button"
          className="h10-spw-next"
          disabled={step === 1 && !canAdvance}
          onClick={() => setStep((s) => (s < 3 ? ((s + 1) as StepN) : s))}
        >
          Next
        </button>
      </footer>
    </div>
  )
}

/** What the current selection adds up to — the answer to "am I copying the right thing?". */
function SourceSummary({ s }: { s: SourceSelection }) {
  if (s.campaigns === 0) {
    return <p className="h10-rep-sum none">Nothing selected yet.</p>
  }
  return (
    <div className="h10-rep-sum">
      <b>{s.campaigns}</b> campaign{s.campaigns === 1 ? '' : 's'} · <b>{s.adGroups}</b> ad group{s.adGroups === 1 ? '' : 's'} ·{' '}
      <b>{s.positives}</b> keyword{s.positives === 1 ? '' : 's'} · <b>{s.negatives}</b> negative{s.negatives === 1 ? '' : 's'} ·{' '}
      <b>{s.productAds}</b> product ad{s.productAds === 1 ? '' : 's'}
      <span className="bud">source runs <b>€{s.dailyBudgetTotal.toFixed(2)}/day</b></span>
      {!s.whole && <span className="part">partial — some campaigns contribute only the ad groups you ticked</span>}
    </div>
  )
}
