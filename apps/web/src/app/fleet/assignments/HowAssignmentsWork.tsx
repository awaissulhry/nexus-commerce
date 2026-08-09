'use client'

/**
 * NAF.SB.AS — the teaching layer. FX.4 makes a "How this works" drawer a
 * condition of done on every fleet page: the guide explains the fleet, this
 * explains THIS page, and it is read at the moment someone is confused.
 *
 * NAF.SB.AS-S4R — rewritten against what exists, after an audit found it had
 * gone stale in a way nobody could have noticed.
 *
 * **This file's entire history was one commit — `aaca58093` — and that commit
 * belongs to another session**, which swept it in accidentally (locks §6b). It
 * was never deliberately committed by the stream that owns it, so it stayed
 * AS.1-era while the list, the create drawer and the detail page were each
 * rebuilt around it. A file nobody commits is a file nobody reads.
 *
 * What that cost, measured on production:
 *  - It CONTRADICTED the product. It promised that changes "go through the
 *    approval queue", implying things arrive there; the detail page now says
 *    plainly that an assignment cannot put anything there at all.
 *  - It named an action that no longer exists ("press Start").
 *  - It carried a live typo — `<em>themes</em>` followed by a newline renders
 *    as "themesare", because JSX strips a newline-plus-indent at an element
 *    boundary. Shipped since AS.1, seen by nobody.
 *  - Its Drawer had no root class, so the contrast fix that landed one
 *    component away never reached it (subtitle at 3.10:1).
 *
 * The rule this file now keeps: **it is a reference, not the teaching.** The
 * teaching happens in place — the commit bar, the pre-flight sentence, the
 * state band. Research is consistent that contextual help is engaged with far
 * more than front-loaded explanation, so nothing here is anybody's first
 * encounter with these ideas; it is where they come to check one.
 */

import { useState } from 'react'
import Link from 'next/link'
import { HelpCircle } from 'lucide-react'
import { Drawer } from '@/design-system/components/Drawer'

export function HowAssignmentsWork() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="as-howbtn" onClick={() => setOpen(true)}>
        <HelpCircle size={13} /> How this works
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="How assignments work"
        subtitle="One worker, one thing to look at."
        width={520}
        /* The fourth subtree of this page to need its own root, and the reason
           is the one Part 12 recorded: a portal escapes every ancestor, so no
           page-level class can ever reach it. */
        className="as-drawer"
      >
        <div className="as-how">
          <h4>What an assignment is</h4>
          <p>
            You pick a worker, point it at one campaign — or one portfolio, one
            marketplace, or your whole account — and say what you want back.
            Nothing happens until you press <strong>Start it</strong>. Every
            worker in this fleet is switched off, so an assignment will sit in
            your list indefinitely until you start it. That is the normal state,
            not a problem to fix.
          </p>

          <h4>What &ldquo;pointed at&rdquo; really means</h4>
          <p>
            The target narrows the <em>evidence</em> the worker reads. It is not
            a hint in a prompt that the worker might ignore — the filter is
            applied to the data before the worker ever sees it, which is the
            only place in the system where scope actually binds.
          </p>
          <p>
            A narrowed run finds <strong>less</strong> than a run over your whole
            account, and that is the point. One kind of evidence is held back
            entirely: waste <em>themes</em> are totals across your whole account
            with no campaign of their own, so attributing them to one campaign
            would blame it for other campaigns&apos; spend. A portfolio resolves
            to the campaigns inside it each time it runs, so one added tomorrow
            is in scope tomorrow.
          </p>

          <h4>An assignment never widens a worker</h4>
          <p>
            If a worker is already limited to one marketplace, an assignment can
            only narrow it further — never point it somewhere it was not allowed
            to go. If the campaign you named is archived before the run starts,
            the run <strong>stops</strong> rather than quietly falling back to
            your whole account. Your list shows that too: a target that no longer
            exists goes red before you spend anything on finding out.
          </p>

          <h4>What it can and cannot do</h4>
          <p>
            Workers on this page can <strong>look and report</strong>. Nothing
            they find reaches Amazon on its own — a finding is a note for you.
            And to be exact rather than reassuring:{' '}
            <strong>
              an assignment cannot put anything in{' '}
              <Link href="/fleet/approvals">Approvals</Link> at all yet
            </strong>
            . Only the weekly council queues actions for your decision, and it
            does not read assignment runs. Some workers cannot be assigned at
            all: several read your whole account every time and have nowhere to
            put a target, so offering one would be a control that does nothing.
          </p>

          <h4>Starting costs money</h4>
          <p>
            A run calls a model, and that is real spend even though nothing is
            written to Amazon. It is the only action on this page that costs
            anything, which is why it sits on its own and says so. Starting the
            same assignment twice does nothing — if a run is already open you are
            taken to it. A run cannot be cancelled once it has begun; it ends on
            its own, on a budget, or is closed after two hours if it stops
            reporting.
          </p>

          <h4>Finishing with one</h4>
          <p>
            <strong>Close</strong> files a job you are done with and keeps every
            attempt and finding. <strong>Cancel</strong> is for one that never
            ran. Both are reversible — <strong>Reopen</strong> puts it back, and
            each offers an Undo the moment you do it.{' '}
            <strong>Delete</strong> removes the row outright and is offered only
            while nothing has run; once it has, the attempts are the record.
          </p>

          <h4>Making several at once</h4>
          <p>
            Pick more than one campaign and the drawer asks what you mean:{' '}
            <strong>separate assignments</strong>, one per campaign, or{' '}
            <strong>one covering all of them</strong>. Up to 25 at a time, and an
            Undo that deletes exactly what was just made. Creating is free and
            reversible; starting is neither, so there is no way to start several
            at once.
          </p>

          <h4>Finding one again</h4>
          <p>
            The list filters by state, searches names and targets, and keeps both
            in the address bar — so a filtered list is a link you can send. A
            deadline colours a row and lifts it to the top; it never starts or
            stops anything.
          </p>

          <h4>Assignment or routine?</h4>
          <p>
            <strong>One worker</strong> → an assignment, here.{' '}
            <strong>Two or more workers, or anything on a clock</strong> → a
            routine, on <Link href="/fleet/workflows">Workflows</Link>.
            Assignments do not repeat.
          </p>
        </div>
      </Drawer>
    </>
  )
}
