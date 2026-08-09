'use client'

/**
 * NAF.WF (S7 condition of done) — "How workflows work", the teaching layer for
 * /fleet/workflows and its detail pages. A collapsible card, `<Term>` tooltips
 * and sentences in place — no tour library, no overlays, deliberately.
 *
 * WF-S7R / S7.a — the card now teaches THE PAGE IT IS ON. It had grown to 13
 * paragraphs and 1,775 words, rendered identically on both pages, so seven of
 * those thirteen described a page the reader was not looking at. NN/g's
 * overlay research is the argument: recall fades in about twenty seconds and
 * hints land when they are relevant, so a card that opens onto other pages'
 * material is spending its reader's attention on the wrong screen.
 *
 * Structure, and it is the contract this file keeps:
 *   SHARED  — true wherever you are: what a routine is, the status words, the
 *             trigger, and where you sit in it.
 *   LIST    — what the list page puts on screen: the built-ins, and how to
 *             read a routine card.
 *   DETAIL  — what a routine's own page puts on screen: the pipeline, the
 *             runs, the versions, the editor, running one, and testing one.
 *
 * If you add a paragraph, add it to the array it belongs to. A paragraph that
 * is true on both pages goes in SHARED — not in both lists.
 */

import { useState } from 'react'
import { BookOpen } from 'lucide-react'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'

export function HowWorkflowsWork({ page }: { page: 'list' | 'detail' }) {
  const [open, setOpen] = useState(false)

  const shared = [
    <p key="what">
      <strong>What a workflow is.</strong> A <Term k="workflow">workflow</Term> is a named
      routine: which workers run, in what order, and what each hands to the next. The fleet
      map shows the whole fleet live; a workflow is one routine on its own. The two will
      never be the same picture — if they ever look alike, one of them is wrong.
    </p>,
    <p key="status">
      <strong>What the status words mean.</strong> <em>On</em> — the next scheduled run will
      do real work. <em>Idle</em> — the clock ticks, but a worker the routine needs is
      switched off, so it will run and do nothing. <em>Off</em> — the fleet clock is off,
      the routine has no published wiring yet, or you switched the routine off.{' '}
      <em>Ready</em> — waits for you to start it. <em>Halted</em> — the fleet stop
      switch is on, and nothing runs, scheduled or manual. A status always carries its
      reason on the next line.
    </p>,
    <p key="trigger">
      <strong>What a <Term k="trigger">trigger</Term> is.</strong> The thing that starts a
      routine — a clock, or you. Each row says when the next run comes, and if the clock
      fired but launched nothing, the row says that too, so &ldquo;why didn&rsquo;t it
      run?&rdquo; always has its answer on screen.
    </p>,
    <p key="where">
      <strong>Where you sit.</strong> Every path through every routine ends at the same
      place: findings on the shared board, and proposed actions waiting for{' '}
      <Term k="approval">your approval</Term>. No routine — built-in or one you author —
      can reach Amazon any other way.
    </p>,
  ]

  const list = [
    <p key="builtins">
      <strong>The three built-ins.</strong> The nightly <Term k="sweep">sweep</Term> has
      every switched-on worker read fresh evidence and report findings. The weekly{' '}
      <Term k="council">council</Term> runs the whole pipeline — workers, director, critic —
      and anything that survives waits for your approval. The on-demand check runs one
      worker by hand. Those are the built-ins; routines you author yourself appear beside
      them the moment you create one, and nothing shows here before it is real.
    </p>,
    <p key="readcard">
      <strong>How to read a routine.</strong> Under each name is the chain of{' '}
      <Term k="step">steps</Term> the routine runs, left to right — usually workers,
      sometimes deterministic code, sometimes you. A worker that is switched off is
      still shown, <em>struck through</em>: it gets skipped and costs nothing, and the
      dials on the Workers page are what decide that. On the right, the bars are the
      last twelve runs, oldest first — the colour is how each one ended, the height is
      how long it took next to the longest one shown. Twelve empty slots means it has
      never run. The chip beside the name is its <Term k="revision">revision</Term>.
    </p>,
  ]

  const detail = [
    <p key="pipeline">
      <strong>Reading the pipeline.</strong> The routine in stages, left to right:
      everything in one stage runs at the same time, and the chip above each stage names
      what arrives from the one before it. Each <Term k="step">step</Term> says what it is,
      whether it will run, and what it did on the most recent run — how long it took, what
      it cost, what it found. A worker that is switched off is struck through and says it
      was skipped, which costs nothing. Code steps say &ldquo;always runs&rdquo; and carry
      no timing, because they are part of the job rather than a worker with a run of its
      own.
    </p>,
    <p key="runs">
      <strong>Reading the runs.</strong> One line per <Term k="run">run</Term> of the whole
      routine, newest first: when it went, what started it, how it ended, and a pill for
      each worker in it with a dot for how that worker did. When something went wrong the
      explanation gets its own line underneath, in full — an amber one means the run hit one
      of its own limits and stopped, which is the system working, not a fault. Open{' '}
      <em>N workers</em> for each worker&rsquo;s own cost, time and a link to its full
      story. And selecting a run re-draws the pipeline above as <em>that</em> run: what each
      step actually did, that time. Worker dials are today&rsquo;s and are not shown for a
      past run, because nothing records what they were set to back then.
    </p>,
    <p key="versions">
      <strong>Reading the versions.</strong> Every published change is a numbered{' '}
      <Term k="revision">revision</Term>{' '}
      with a mandatory note saying why — that note is
      the change log. Each row says who wrote it, when, whether it is the wiring running
      now, how long it was active, and how many runs it served. &ldquo;What
      changed&rdquo; opens the diff against the revision before it. Any revision that is
      not the live one can be made live again: the wiring you pick becomes active, what is
      running now is set aside, and nothing is rewritten — the numbers never move, so a run
      that stamped rev 2 still means rev 2.
    </p>,
    <p key="editing">
      <strong>Editing and publishing.</strong> &ldquo;Edit the wiring&rdquo; opens a{' '}
      <Term k="draft">draft</Term>: add or remove workers, choose each step&rsquo;s{' '}
      <Term k="gate">gate</Term>, and connect who hands what to whom. Drafts are inert —{' '}
      <Term k="publish">publishing</Term> is the one act that records a change, behind a
      confirmation that shows the exact diff. Every revision is immutable, every activation
      supersedes its predecessor, and revert-to-built-in is one click that cannot fail.
      Publishing is live: the wiring you publish is what runs, a changed clock re-arms the
      same moment, and every run stamps the revision that served it.
    </p>,
    <p key="editorhelp">
      <strong>What the editor tells you while you work.</strong> The picture on the right is
      the draft as you are wiring it, and it redraws as you type. Anything the fleet would
      refuse is marked twice: once on the card that caused it, and once in the list at the
      bottom — and while anything is listed, Publish, Save and Test are all closed. A step
      card says both directions, what it hands on and what it receives, so you never have to
      read every other card to see the shape. The gate ladder only ever tightens: &ldquo;May
      act&rdquo; carries a lock because tools that always ask — pricing, publishing, spend,
      customer messages — still queue for your approval whatever you set here. For a clock,
      the line under the field says what the schedule means in words and the next three times
      it will fire; if it cannot say, the schedule is one this fleet cannot run. And if you
      leave mid-edit, the next visit offers you that draft back rather than loading it
      behind your back — what you see on arrival is always the wiring that is live.
    </p>,
    <p key="runyourself">
      <strong>Running one yourself.</strong> A routine you authored runs by hand
      (&ldquo;Run now&rdquo;) or on its own clock the moment you publish a schedule — and
      its off switch stops both until you turn it back on.
    </p>,
    <p key="test">
      <strong>What a <Term k="test">test</Term> costs, and what it touches.</strong> You are
      told the estimated spend before it starts and never asked to confirm one without a
      price; when it finishes, the panel puts what it predicted beside what it actually
      cost. The walk is one step at a time, so a stage the picture draws as
      &ldquo;at the same time&rdquo; is still tested in sequence — that keeps the cost
      legible. Findings hand off inside the test: a step that reads the board sees what
      the steps before it would have written, so testing a routine tests the routine and
      not each worker alone. Plans do not hand off, because a preview never writes one —
      a critic still reads the last real plan. Three things are always true and worth knowing before your first one: it
      spends real money, it writes <em>nothing</em> — no findings, no proposals, no row in
      Runs — and it runs workers that are <em>switched off</em>, because the point is to see
      what the wiring would do. The results live with your editing session; leaving the
      editor ends them, and it will ask first.
    </p>,
  ]

  /* Shared first: what a routine is, and where you sit, are the two facts a
     beginner needs before anything on either page means much. */
  const paragraphs = page === 'list' ? [...shared, ...list] : [...shared, ...detail]

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
      {open ? <div className="wf-how">{paragraphs}</div> : null}
    </section>
  )
}
