'use client'

/**
 * FX.4 — "How the fleet works": the whole system explained on one
 * collapsible card, plus the dismissable first-visit intro. Hand-rolled,
 * no tour library — a beginner needs six honest paragraphs more than a
 * spotlight overlay.
 */

import { useEffect, useState } from 'react'
import { BookOpen, X } from 'lucide-react'
import { Term } from './glossary'

const INTRO_KEY = 'naf-fleet-intro-dismissed'

export function FirstVisitIntro() {
  const [dismissed, setDismissed] = useState(true)
  useEffect(() => {
    setDismissed(localStorage.getItem(INTRO_KEY) === '1')
  }, [])
  if (dismissed) return null
  return (
    <div className="acr-flx-intro">
      <div>
        <strong>New here? Three things to know.</strong>
        <ol>
          <li>
            These are AI <Term k="worker">workers</Term> that read your advertising data and
            report what they find. They are all switched off until you turn them on.
          </li>
          <li>
            Nothing here can touch Amazon by itself. Every proposed change must pass an
            adversarial <Term k="critic">critic</Term> and then wait for{' '}
            <Term k="approval">your approval</Term>.
          </li>
          <li>
            Trust is earned in rungs — <Term k="trust-ladder">the trust ladder</Term> — with
            weeks of evidence at each step, and lost automatically on mistakes.
          </li>
        </ol>
      </div>
      <button
        className="acr-btn"
        aria-label="Dismiss introduction"
        onClick={() => {
          localStorage.setItem(INTRO_KEY, '1')
          setDismissed(true)
        }}
      >
        <X size={13} /> Got it
      </button>
    </div>
  )
}

export function HowItWorks() {
  const [open, setOpen] = useState(false)
  return (
    <section className="acr-card">
      <header className="acr-fl-head">
        <h3>
          <BookOpen size={15} /> How the fleet works
        </h3>
        <button className="acr-btn" onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'Read it'}
        </button>
      </header>
      {open ? (
        <div className="acr-flx-how">
          <p>
            <strong>The cast.</strong> <Term k="worker">Workers</Term> read prepared{' '}
            <Term k="evidence">evidence</Term> and report <Term k="finding">findings</Term> to a
            shared board. A <Term k="director">director</Term> turns the board into one ranked{' '}
            <Term k="plan">plan</Term>. A <Term k="critic">critic</Term> tries to tear the plan
            apart with twelve checks. An <Term k="auditor">auditor</Term> writes you a nightly
            brief. Nobody in this cast can touch Amazon.
          </p>
          <p>
            <strong>The rhythm.</strong> Every night at 04:45 UTC the{' '}
            <Term k="sweep">sweep</Term> runs the workers on fresh data. Every Monday at 05:15
            UTC the <Term k="council">council</Term> runs the whole pipeline — workers, director,
            critic — and anything that survives lands in your approval inbox.
          </p>
          <p>
            <strong>The safety stack.</strong> Code does the math; the model does the judgment.
            Every action proposal is preview-only by construction — the tools that workers use
            have no execute path. Plans must fit the <Term k="blast-radius">blast radius</Term>{' '}
            limits, respect protected brand terms and hand-held campaigns, and pass the critic.
            Then each surviving action still waits for <Term k="approval">your yes</Term>. The
            fleet spends at most its <Term k="ceiling">daily ceiling</Term> on AI, and a halt
            stops everything instantly.
          </p>
          <p>
            <strong>The trust ladder.</strong> <Term k="off">OFF</Term> →{' '}
            <Term k="observe">OBSERVE</Term> → <Term k="propose">PROPOSE</Term> →{' '}
            <Term k="auto">AUTO</Term>. Fourteen clean days and a{' '}
            <Term k="grade">grade</Term> of B earn the first promotion; thirty days, 70%
            approval and proven <Term k="calibration">calibration</Term> are the price of AUTO —
            plus your explicit sign-off, and the server refuses AUTO for anyone who hasn&apos;t
            earned it. <Term k="demotion">Demotion</Term> is automatic.
          </p>
          <p>
            <strong>You teach it.</strong> Every approval or rejection you make becomes{' '}
            <Term k="exemplar">precedent</Term> the workers read on their next run. A one-line
            reject reason is the highest-value thing you can type into this system.
          </p>
        </div>
      ) : null}
    </section>
  )
}
