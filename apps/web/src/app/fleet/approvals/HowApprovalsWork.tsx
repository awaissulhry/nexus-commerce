'use client'

/**
 * NAF.AQ-S1R S1.b — the teaching layer, as a drawer rather than a wall.
 *
 * FX.4 makes a "How this works" drawer a condition of done on every fleet
 * page. This one existed and was in the wrong place: an inline disclosure that
 * spent a row of the page forever, opening 276 words of prose at **261–266
 * characters per line** (measured on prod) against WCAG 1.4.8's ceiling of 80.
 * Inside a 520px drawer the same words run at ~72. That is the whole fix for
 * "wall of prose", and it is a measurement rather than a matter of taste.
 *
 * The component is the DS `Drawer` — the same one `assignments/
 * HowAssignmentsWork.tsx` already uses for the identical job. One component per
 * concept; nothing new is invented for a second copy of a solved problem.
 * GitLab Pajamas ranks the mechanisms and puts this exactly here: "The UI
 * should be self-explanatory. If extra help is required, it should be in the
 * UI itself, as either UI text or as text within a drawer."
 *
 * Two rules this file is built on, both checkable:
 *
 * · **Headings are answers, not questions.** All six leads used to be
 *   questions in noun-phrase clothing ("What happens if you say nothing."), so
 *   a reader scanning them learned six things they did not know and zero
 *   things they did. GOV.UK is explicit: headings should not be questions,
 *   "they're hard to frontload and users want answers, not questions."
 *
 * · **No <Term> in here.** `.nds-drawer-b` is `overflow-y: auto` and
 *   `.acr-term-tip` is absolutely positioned opening UPWARD out of its line, so
 *   a tooltip inside a drawer is clipped by its own scroll container.
 *   `HowAssignmentsWork` avoids this too; now the reason is written down. The
 *   drawer IS the long-form definition surface — tooltips serve the terse
 *   inline copy.
 *
 * Every number comes in as a prop read from the live gate state. Nothing here
 * retypes a constant: the glossary retyped the expiry clock once and drifted
 * from it by 7× (AQ.0), which is the whole reason `EXPIRY_HOURS` is exported.
 */

import { useState } from 'react'
import Link from 'next/link'
import { HelpCircle } from 'lucide-react'
import { Drawer } from '@/design-system/components/Drawer'

export function HowApprovalsWork({
  expiryHours,
  maintenanceSeconds,
}: {
  /** From `gate.expiry.hours`. Null until the first read returns. */
  expiryHours: number | null
  /** From `gate.expiry.maintenanceSeconds`. */
  maintenanceSeconds: number | null
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="aq-helpbtn" onClick={() => setOpen(true)}>
        <HelpCircle size={13} aria-hidden /> How approvals work
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="How approvals work"
        subtitle="What this queue guarantees, and what it cannot do."
        width={520}
        /* A Drawer portals to <body>, outside `.fleet-surface`, where the DS
           `.dark` block wins again. Measured on prod in dark mode: this panel
           painted rgb(24,38,59) while the page stayed light and the heading
           rendered pure black on it — 1.38:1. `.fleet-portal` carries the same
           pin; see fleet-pages.css:19. */
        className="fleet-portal"
      >
        <div className="aq-how">
          <h4>Only a worker set to PROPOSE can ask you</h4>
          <p>
            A worker at <strong>OBSERVE</strong> can look and report but never ask, and one that
            is <strong>OFF</strong> does not run at all. Which worker sits where is set on{' '}
            <Link href="/fleet/controls">Controls</Link>, never here — this page decides one
            request at a time and changes no permissions.
          </p>

          <h4>The critic has already refused everything it could</h4>
          <p>
            Every proposal passes an adversarial reviewer first, whose entire job is to find
            reasons to say no. Safety blocks computed in code are final: the critic can add a
            block but can never remove one. What reaches you has already survived that, which is
            why there is usually very little here.
          </p>

          <h4>A yes waits twenty seconds before anything happens</h4>
          <p>
            Your decision is recorded the moment you make it — with your name on it — but the
            action itself sits out an undo window, and one click takes it back. Closing the tab
            does not cancel it: the decision is saved immediately and only the execution waits.
          </p>

          <h4>Silence becomes a no, never a yes</h4>
          <p>
            {expiryHours != null ? (
              <>A request expires {expiryHours} hours after it was asked</>
            ) : (
              <>A request expires a fixed number of hours after it was asked</>
            )}
            , and expiry always means <strong>refused</strong> — never approved because nobody
            looked.
            {maintenanceSeconds != null ? (
              <> The clock is checked every {maintenanceSeconds} seconds</>
            ) : (
              <> The clock is checked continuously</>
            )}
            , and that check keeps running even with the whole fleet switched off, so a decision
            you already took is never stranded.
          </p>
          <p>
            If you are not ready to answer, set a request aside rather than approving it to clear
            it. A snooze can never outlive the request — you will not be offered a time past its
            own expiry.
          </p>

          <h4>Your name goes on every decision taken here</h4>
          <p>
            From the moment you decide. Decisions taken before this system existed carry no name
            and say so plainly rather than inventing one, which is why the record can show
            eighteen answered requests and still be honest that you have answered none of them.
          </p>

          <h4>This page decides; it does not change what a worker may do</h4>
          <p>
            It cannot change what a worker is allowed to do — that is{' '}
            <Link href="/fleet/controls">Controls</Link>. It cannot re-run anything or show you
            the story around a decision — that is <Link href="/fleet/activity">Activity</Link>.
          </p>
          <p>
            It can, though, let you disagree with a number rather than only with an idea. Where
            an action has a figure you can sensibly change — a bid, for instance — you can edit
            it before approving. The edit does not overwrite what the worker asked for: it
            replaces that request with your own, and your number is re-checked by the same code
            that produced the original, so anything the tool would refuse from a worker it
            refuses from you too.
          </p>
          <p>
            And some actions can only describe what they would do. The section on the page behind
            this one says which, and how many — it is the one fact about this queue that no other
            screen will tell you.
          </p>
        </div>
      </Drawer>
    </>
  )
}
