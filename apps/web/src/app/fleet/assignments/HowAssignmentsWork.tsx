'use client'

/**
 * NAF.SB.AS — the teaching layer. FX.4 makes a "How this works" drawer a
 * condition of done on every fleet page: the guide explains the fleet, this
 * explains THIS page, and it is read at the moment someone is confused.
 */

import { useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { Drawer } from '@/design-system/components/Drawer'

export function HowAssignmentsWork() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="acr-pg-sortbtn"
        style={{ marginLeft: 6, verticalAlign: 'baseline' }}
        onClick={() => setOpen(true)}
      >
        <HelpCircle size={13} /> How this works
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="How assignments work"
        subtitle="One worker, one thing to look at."
        width={520}
      >
        <div className="as-how">
          <h4>What an assignment is</h4>
          <p>
            You pick a worker, point it at one campaign (or one marketplace, or
            your whole account), and say what you want back. Nothing happens
            until you press <strong>Start</strong>. Every worker in this fleet is
            switched off, so an assignment will sit here indefinitely until you
            start it — that is the normal state, not a problem to fix.
          </p>

          <h4>What &ldquo;pointed at&rdquo; really means</h4>
          <p>
            The target narrows the <em>evidence</em> the worker reads. It is not
            a hint in a prompt that the worker might ignore — the campaign filter
            is applied to the data before the worker ever sees it, which is the
            only place in the system where scope actually binds.
          </p>
          <p>
            A narrowed run finds <strong>less</strong> than a run over your whole
            account, and that is the point. One kind of evidence is held back
            entirely: waste <em>themes</em> are totals across your whole account
            with no campaign of their own, so attributing them to one campaign
            would blame it for other campaigns&apos; spend.
          </p>

          <h4>An assignment never widens a worker</h4>
          <p>
            If a worker is already limited to one marketplace, an assignment can
            only narrow it further — never point it somewhere it was not allowed
            to go. If the campaign you named is archived before the run starts,
            the run <strong>stops</strong> rather than quietly falling back to
            your whole account.
          </p>

          <h4>What it can and cannot do</h4>
          <p>
            Workers on this page can <strong>look and report</strong>. Nothing
            they find reaches Amazon on its own — a finding is a note for you,
            and any change to your account still goes through the approval
            queue. Only some workers can be assigned at all: several read your
            whole account every time and have nowhere to put a target, so
            offering one would be a control that does nothing.
          </p>

          <h4>Starting costs money</h4>
          <p>
            A run calls a model, and that is real spend even though nothing is
            written to Amazon. Starting the same assignment twice does nothing —
            if a run is already open you are taken to it. A run cannot be
            cancelled once it has begun; it ends on its own, on a budget, or is
            closed after two hours if it stops reporting.
          </p>

          <h4>Assignment or routine?</h4>
          <p>
            <strong>One worker</strong> → an assignment, here.{' '}
            <strong>Two or more workers, or anything on a clock</strong> → a
            routine, on <a href="/fleet/workflows">Workflows</a>. Assignments do
            not repeat.
          </p>
        </div>
      </Drawer>
    </>
  )
}
