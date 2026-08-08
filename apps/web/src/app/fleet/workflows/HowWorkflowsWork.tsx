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
            worker by hand. Those are the built-ins; routines you author yourself appear beside
            them the moment you create one, and nothing shows here before it is real.
          </p>
          <p>
            <strong>How to read a routine.</strong> Under each name is the chain of{' '}
            <Term k="step">steps</Term> the routine runs, left to right — usually workers,
            sometimes deterministic code, sometimes you. A worker that is switched off is
            still shown, <em>struck through</em>: it gets skipped and costs nothing, and the
            dials on the Workers page are what decide that. On the right, the bars are the
            last twelve runs, oldest first — the colour is how each one ended, the height is
            how long it took next to the longest one shown. Twelve empty slots means it has
            never run. The chip beside the name is its <Term k="revision">revision</Term>.
          </p>
          <p>
            <strong>What the status words mean.</strong> <em>On</em> — the next scheduled run will
            do real work. <em>Idle</em> — the clock ticks, but a worker the routine needs is
            switched off, so it will run and do nothing. <em>Off</em> — the fleet clock is off,
            the routine has no published wiring yet, or you switched the routine off.{' '}
            <em>Ready</em> — waits for you to start it. <em>Halted</em> — the fleet stop
            switch is on, and nothing runs, scheduled or manual. A status always carries its
            reason on the next line.
          </p>
          <p>
            <strong>Reading a routine&rsquo;s own page.</strong> The pipeline is the routine in
            stages, left to right: everything in one stage runs at the same time, and the chip
            above each stage names what arrives from the one before it. Each{' '}
            <Term k="step">step</Term> says what it is, whether it will run, and what it did on
            the most recent run — how long it took, what it cost, what it found. A worker that is
            switched off is struck through and says it was skipped, which costs nothing. Code
            steps say &ldquo;always runs&rdquo; and carry no timing, because they are part of the
            job rather than a worker with a run of its own.
          </p>
          <p>
            <strong>Reading the runs.</strong> One line per <Term k="run">run</Term> of the whole
            routine, newest first: when it went, what started it, how it ended, and a pill for
            each worker in it with a dot for how that worker did. When something went wrong the
            explanation gets its own line underneath, in full — an amber one means the run hit one
            of its own limits and stopped, which is the system working, not a fault. Open{' '}
            <em>N workers</em> for each worker&rsquo;s own cost, time and a link to its full
            story. And selecting a run re-draws the pipeline above as <em>that</em> run: what each
            step actually did, that time. Worker dials are today&rsquo;s and are not shown for a
            past run, because nothing records what they were set to back then.
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
            <Term k="approval">your approval</Term>. No routine — built-in or one you author —
            can reach Amazon any other way.
          </p>
          <p>
            <strong>Editing and versions.</strong> "Edit the wiring" on a routine&rsquo;s page
            opens a <Term k="draft">draft</Term>: add or remove workers, choose each step&rsquo;s{' '}
            <Term k="gate">gate</Term>, and connect who hands what to whom. Drafts are inert —{' '}
            <Term k="publish">publishing</Term> is the one act that records a change, behind a
            confirmation that shows the exact diff. Every revision is immutable, every activation
            supersedes its predecessor, and revert-to-built-in is one click that cannot fail.
            Publishing is live: the wiring you publish is what runs, a changed clock re-arms the
            same moment, and every run stamps the revision that served it.
          </p>
          <p>
            <strong>Trying things safely.</strong> &ldquo;Test this draft&rdquo; runs a draft
            against real evidence with real models but writes nothing — you see what every step
            would have found and what it cost, with zero trace in Runs. A custom routine runs by
            hand (&ldquo;Run now&rdquo;) or on its own clock the moment you publish a schedule —
            and its off switch stops both until you turn it back on.
          </p>
        </div>
      ) : null}
    </section>
  )
}
