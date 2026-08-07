'use client'

/**
 * NAF.WF (S7 condition of done) — "How workflows work", the teaching layer
 * for /fleet/workflows and its detail pages. Mirrors the Overview drawer's
 * interaction (collapsible card, six honest paragraphs, no tour library) with
 * content specific to this page. Page-local classes only — the Overview's
 * .acr-flx-* live in a stylesheet another session owns.
 */

import { useState } from 'react'
import { BookOpen } from 'lucide-react'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'

export function HowWorkflowsWork() {
  const [open, setOpen] = useState(false)
  return (
    <section className="acr-card">
      <header className="wf-cardhead">
        <h3>
          <BookOpen size={15} /> How workflows work
        </h3>
        <button className="acr-btn" onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'Read it'}
        </button>
      </header>
      {open ? (
        <div className="wf-how">
          <p>
            <strong>What a workflow is.</strong> A <Term k="workflow">workflow</Term> is a named
            routine: which workers run, in what order, and what each hands to the next. The fleet
            map shows the whole fleet live; a workflow is one routine on its own. The two will
            never be the same picture — if they ever look alike, one of them is wrong.
          </p>
          <p>
            <strong>The three built-ins.</strong> The nightly <Term k="sweep">sweep</Term> has
            every switched-on worker read fresh evidence and report findings. The weekly{' '}
            <Term k="council">council</Term> runs the whole pipeline — workers, director, critic —
            and anything that survives waits for your approval. The on-demand check runs one
            worker by hand. These are the routines that exist in code today; more modes are
            planned, and they will appear here only when they are real.
          </p>
          <p>
            <strong>What the status words mean.</strong> <em>On</em> — the next scheduled run will
            do real work. <em>Idle</em> — the clock ticks, but a worker the routine needs is
            switched off, so it will run and do nothing. <em>Off</em> — the fleet clock itself is
            off. <em>Ready</em> — waits for you to start it. <em>Halted</em> — the fleet stop
            switch is on, and nothing runs, scheduled or manual. A status always carries its
            reason on the next line.
          </p>
          <p>
            <strong>What a <Term k="trigger">trigger</Term> is.</strong> The thing that starts a
            routine — a clock, or you. Each row says when the next run comes, and if the clock
            fired but launched nothing, the row says that too, so &ldquo;why didn&rsquo;t it
            run?&rdquo; always has its answer on screen.
          </p>
          <p>
            <strong>Where you sit.</strong> Every path through every routine ends at the same
            place: findings on the shared board, and proposed actions waiting for{' '}
            <Term k="approval">your approval</Term>. No routine — built-in or, later, one you
            author — can reach Amazon any other way.
          </p>
          <p>
            <strong>Editing and versions.</strong> "Edit the wiring" on a routine&rsquo;s page
            opens a <Term k="draft">draft</Term>: add or remove workers, choose each step&rsquo;s{' '}
            <Term k="gate">gate</Term>, and connect who hands what to whom. Drafts are inert —{' '}
            <Term k="publish">publishing</Term> is the one act that records a change, behind a
            confirmation that shows the exact diff. Every revision is immutable, every activation
            supersedes its predecessor, and revert-to-built-in is one click that cannot fail.
            Until stored execution ships, even a published revision is recorded, not live — the
            fleet says so wherever it applies, rather than letting you believe otherwise.
          </p>
          <p>
            <strong>What comes next.</strong> Stored execution (runs follow your published wiring
            and stamp the revision that served them), trigger editing, and a test run that shows
            what a routine <em>would</em> do while writing nothing.
          </p>
        </div>
      ) : null}
    </section>
  )
}
