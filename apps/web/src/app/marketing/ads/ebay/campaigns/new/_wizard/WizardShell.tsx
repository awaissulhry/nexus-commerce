'use client'

/**
 * ER2 — the shared stepper shell on the SP-Super-Wizard chrome (§PL-7:
 * .h10-spw-top eyebrow+h1+exit, the DS `Stepper` for the step rail, +
 * connectors, .h10-spw-foot Back·err·Next). Steps are freely clickable
 * (Amazon idiom); advancing past BLOCKING issues opens a modal that lists
 * them with no continue-anyway (stricter than SPW — eBay launches spend
 * money; deviation recorded in the spec §11.3).
 */
import { useState, type ReactNode } from 'react'
import { Button } from '@/design-system/primitives'
import { Stepper } from '@/design-system/components'
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
    <div className="h10-spw eb-root">
      <header className="h10-spw-top">
        <div>
          <div className="eyebrow">Nexus Ads · eBay</div>
          <h1>Campaign Builder : {props.title}</h1>
        </div>
        <Link className="h10-spw-exit" href="/marketing/ads/ebay/campaigns/new">Exit to campaign types</Link>
      </header>

      {/* `canSelect` returns true for every step because that is what this wizard already did —
          `go()` performs no validation, so any step has always been reachable. The DS defaults to
          completed-only and makes jumping ahead an explicit opt-in; this is that opt-in, not a
          behaviour change. Tightening it is the wizard owner's call, not this conversion's. */}
      <Stepper
        className="eb-wiz-steps"
        steps={props.steps.map((s) => ({ key: s.key, label: s.label }))}
        current={idx}
        onSelect={(_i, step) => props.onStep(step.key)}
        canSelect={() => true}
      />

      <div style={{ marginTop: 18 }}>{props.children}</div>

      <footer className="h10-spw-foot">
        {idx > 0 ? <Button size="lg" onClick={props.onBack}>Back</Button> : <span />}
        <span className="grow" style={{ flex: 1 }} />
        {props.blockers.length > 0 && <span className="h10-spw-err">{props.blockers.length} item{props.blockers.length === 1 ? '' : 's'} need attention</span>}
        {props.footerNote}
        <Button size="lg" variant="primary" disabled={props.nextBusy} onClick={tryNext}>{props.nextBusy ? '…' : props.nextLabel}</Button>
      </footer>

      <H10Modal open={showBlockers} onClose={() => setShowBlockers(false)} title="Before you continue"
        subtitle="These must be resolved — launches spend real money, so blocking checks have no continue-anyway."
    footer={<><span style={{ flex: 1 }} /><Button variant="primary" onClick={() => setShowBlockers(false)}>Fix them</Button></>}>
        <ul className="eb-results">{props.blockers.map((b) => <li key={b} className="err">{b}</li>)}</ul>
      </H10Modal>
    </div>
  )
}
