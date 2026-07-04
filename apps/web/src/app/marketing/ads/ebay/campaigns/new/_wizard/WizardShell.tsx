'use client'

/**
 * ER2 — the shared stepper shell on the SP-Super-Wizard chrome (§PL-7:
 * .h10-spw-top eyebrow+h1+exit, .h10-spw-steps with .circ/.lbl/.on/.done +
 * connectors, .h10-spw-foot Back·err·Next). Steps are freely clickable
 * (Amazon idiom); advancing past BLOCKING issues opens a modal that lists
 * them with no continue-anyway (stricter than SPW — eBay launches spend
 * money; deviation recorded in the spec §11.3).
 */
import { Fragment, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { H10Modal } from '../../../_lib/modal'

export interface WizardStep { key: string; label: string }

export function WizardShell(props: {
  title: string
  steps: WizardStep[]
  active: string
  visited: string[]
  onStep: (key: string) => void
  blockers: string[]           // blocking issues on the ACTIVE step
  onNext: () => void
  onBack: () => void
  nextLabel: string
  nextBusy?: boolean
  footerNote?: ReactNode
  children: ReactNode
}) {
  const [showBlockers, setShowBlockers] = useState(false)
  const idx = props.steps.findIndex((s) => s.key === props.active)
  const tryNext = () => {
    if (props.blockers.length) { setShowBlockers(true); return }
    props.onNext()
  }
  return (
    <div className="h10-spw">
      <header className="h10-spw-top">
        <div>
          <div className="eyebrow">Nexus Ads · eBay</div>
          <h1>Campaign Builder : {props.title}</h1>
        </div>
        <Link className="h10-spw-exit" href="/marketing/ads/ebay/campaigns/new">Exit to campaign types</Link>
      </header>

      <nav className="h10-spw-steps" aria-label="Steps">
        {props.steps.map((s, i) => (
          <Fragment key={s.key}>
            {i > 0 && <span className="h10-spw-conn" />}
            <button
              type="button"
              className={`h10-spw-step ${props.active === s.key ? 'on' : ''} ${props.visited.includes(s.key) && props.active !== s.key ? 'done' : ''}`}
              aria-current={props.active === s.key ? 'step' : undefined}
              onClick={() => props.onStep(s.key)}
            >
              <span className="circ">{i + 1}</span>
              <span className="lbl">{s.label}</span>
            </button>
          </Fragment>
        ))}
      </nav>

      <div style={{ marginTop: 18 }}>{props.children}</div>

      <footer className="h10-spw-foot">
        {idx > 0 ? <button type="button" className="h10-spw-back" onClick={props.onBack}>Back</button> : <span />}
        <span className="grow" style={{ flex: 1 }} />
        {props.blockers.length > 0 && <span className="h10-spw-err">{props.blockers.length} item{props.blockers.length === 1 ? '' : 's'} need attention</span>}
        {props.footerNote}
        <button type="button" className="h10-spw-next" disabled={props.nextBusy} onClick={tryNext}>{props.nextBusy ? '…' : props.nextLabel}</button>
      </footer>

      <H10Modal open={showBlockers} onClose={() => setShowBlockers(false)} title="Before you continue"
        subtitle="These must be resolved — launches spend real money, so blocking checks have no continue-anyway."
        footer={<><span style={{ flex: 1 }} /><button type="button" className="h10-am-btn primary" onClick={() => setShowBlockers(false)}>Fix them</button></>}>
        <ul className="eb-results">{props.blockers.map((b) => <li key={b} className="err">{b}</li>)}</ul>
      </H10Modal>
    </div>
  )
}
