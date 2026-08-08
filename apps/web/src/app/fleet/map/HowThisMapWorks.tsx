'use client'

/**
 * NAF.SB.M.8 — the teaching layer.
 *
 * Hand-rolled collapsible in the house pattern (HowItWorks on the Overview,
 * HowWorkflowsWork on Workflows): no tour library, no spotlight overlay. A
 * beginner needs a few honest paragraphs at the moment they are confused far
 * more than a guided tour they will dismiss once.
 *
 * It sits above the map rather than over it, so opening it never hides the
 * thing it is explaining.
 *
 * Every sentence here has to survive being read by someone who has never seen
 * an agent fleet — no schema identifiers, no internal nouns. The jargon that
 * genuinely cannot be avoided is linked to the shared glossary with `<Term>`.
 */

import { useEffect, useRef, useState } from 'react'
import { BookOpen, ChevronDown, ChevronUp } from 'lucide-react'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { DEFINITIONS } from './definitions'
import { CHIPS } from './lib'

export function HowThisMapWorks({ openSignal }: { openSignal?: number }) {
  const [open, setOpen] = useState(false)
  const numbers = useRef<HTMLHeadingElement | null>(null)

  /**
   * S1R — the band's "What each number counts" affordance lands here.
   *
   * The definitions used to exist only as hover/focus tooltips, which is the
   * one place the field is unanimous they must not be: NN/g's rule is that a
   * tooltip must not carry what the task needs, and GOV.UK's is that a
   * disclosure must not hide what most readers need. What a number counts is
   * the number. So it lives here as real text, reachable by keyboard AND by
   * touch, and the tooltip is demoted to an accelerator.
   *
   * `behavior: 'auto'` deliberately — a smooth scroll would be motion this
   * page has no way to switch off, and the reader asked to be moved.
   */
  useEffect(() => {
    if (openSignal == null) return
    setOpen(true)
    const t = window.setTimeout(() => {
      numbers.current?.scrollIntoView({ block: 'center', behavior: 'auto' })
      numbers.current?.focus()
    }, 0)
    return () => window.clearTimeout(t)
  }, [openSignal])

  return (
    <section className={`sbm-how ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="sbm-how-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <BookOpen size={13} aria-hidden />
        How this map works
        {open ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
      </button>

      {open ? (
        <div className="sbm-how-body">
          <p>
            This page is a picture of your <Term k="worker">workers</Term> — the small AI helpers
            that read your advertising data and suggest changes. It shows what they are, how work
            passes between them, and what each one has been doing. It is a view of things{' '}
            <b>as they are</b>. To change how they are wired, go to Workflows; to change what one
            of them is allowed to do, go to Workers.
          </p>

          <h4>Reading a card</h4>
          <p>
            Each card is one worker. The coloured bar down its left side answers whichever question
            you picked in <b>Colour by</b>, on the left. Next to that is a small shape and a word —
            <i> Off</i>, <i>Working</i>, <i>Needs attention</i> — and those two say the same thing
            as the colour, on purpose: a colour alone is no use if you cannot tell two of them
            apart, or if you are looking at a printed screenshot.
          </p>
          <p>
            A card with a dashed outline reading <i>not yet run</i> has never run. That is not an
            error. It is worth seeing, which is why it is not faded out.
          </p>

          <h4>Reading a line</h4>
          <p>
            A line means one worker&apos;s <Term k="finding">findings</Term> are handed to another.
            The label counts what was actually <b>carried</b> — how many of that worker&apos;s
            findings the <Term k="director">director</Term> named in its <Term k="plan">plan</Term>.
            A faint dashed line means nothing has ever crossed it: the connection exists, but no
            work has gone down it yet.
          </p>
          <p>
            Click a line to see the handoff. The most useful part is what the director{' '}
            <b>dropped</b> — it has to give a reason for every finding it chose not to carry, in
            its own words, and those reasons are printed there.
          </p>
          <p>
            The last line, into the <Term k="critic">critic</Term>, has no count. The critic does
            not produce anything of its own; it marks a plan as passed, sent back or blocked. So
            that line shows the verdict rather than a number.
          </p>

          <h4>The two views</h4>
          <p>
            <b>Workers</b> is the fleet itself. <b>What they watch</b> is the other thing entirely:
            your campaigns and products, and the connections the fleet worked out between them by
            reading your data — which campaigns compete with each other, which are taking each
            other&apos;s sales. One is the machinery; the other is what the machinery is looking
            at.
          </p>
          <p>
            <b>Map</b> and <b>List</b> show the same workers two ways. The map is better for
            seeing where work goes next; the list is better for ranking — who costs most, who has
            the most outstanding.
          </p>

          <h4>What this page cannot do</h4>
          <p>
            Nothing on it changes anything. Every control either changes what you are looking at,
            or takes you somewhere else. You cannot switch a worker on, pause one, or approve
            anything from here — that is deliberate, so a page you read quickly can never be a page
            you break something on by accident.
          </p>

          <h4 id="sbm-numbers" ref={numbers} tabIndex={-1}>
            What each number counts
          </h4>
          <p>
            Every figure in the band above the map, defined once. These are the same
            sentences the band itself shows when you hover or tab onto a number — written
            here as well, because a definition you can only reach with a mouse is a
            definition half the people reading this page cannot reach at all.
          </p>
          <dl className="sbm-defs">
            {/* Generated from the chips themselves. A list retyped here would be a
                second copy of eleven sentences, and the second copy is always the
                one that goes stale. */}
            {CHIPS.map((c) => (
              <div key={c.id}>
                <dt>{c.label}</dt>
                <dd>
                  {c.definition}
                  {c.zeroNote ? <> {c.zeroNote}</> : null}
                </dd>
              </div>
            ))}
            <div>
              <dt>Spent today</dt>
              <dd>{DEFINITIONS['spend-today']}</dd>
            </div>
            <div>
              <dt>Open findings</dt>
              <dd>{DEFINITIONS['findings-open']}</dd>
            </div>
          </dl>

          <h4>Two numbers that surprise people</h4>
          <p>
            <b>Waiting for you is always zero</b> right now, and that is not an empty inbox: the
            fleet&apos;s suggestion tools are preview-only at the moment, so nothing can be queued
            for approval even when a plan passes the critic.
          </p>
          <p>
            <b>Spend can read $0.0000 while a worker has clearly run.</b> Where a worker did not
            run at all in the window you picked, the map says <i>nothing to measure</i> and marks
            it with a hatch instead — because &quot;did not run&quot; and &quot;ran and cost
            nothing&quot; are different facts and should not look the same.
          </p>
        </div>
      ) : null}
    </section>
  )
}
