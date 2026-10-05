'use client'

/**
 * Approvals grid — "How it works" (PLAN §2–§7; clean-up F, 2026-10-05). Replaces the fleet-era HowApprovalsWork drawer,
 * which taught a fleet-only queue (dials, a critic, a hard-coded count of answered requests).
 *
 * A reference, not the teaching: the page says each of these things in place (the status pill, the countdown, the held
 * bulk button, the Automate modal). Rules this file keeps:
 * - headings are answers, not questions;
 * - one vocabulary: the status words are the grid's (`queueWords` STATE_META), the levels the Automate modal's
 *   (`automateWords` CHOICE_LABEL), the keys the ones the page binds (passed in), the stop window `STOP_WINDOW_MS`;
 * - no retyped constant: the expiry hours come from the API (gate-state `expiry.hours`, its EXPIRY_HOURS), and the
 *   text says "a fixed number of hours" until they are read;
 * - DS parts only, `fleet-portal` on the drawer (it portals out of the light fleet surface).
 *
 * The fleet's readiness readout (FleetGateState) sits at the end: it moved here from the top of the old page.
 */
import { useState } from 'react'
import { HelpCircle } from 'lucide-react'
import type { QueueState } from '@nexus/shared/approval-queue'
import Link from '@/lib/workspaces/Link'
import { Drawer } from '@/design-system/components'
import { Button, Kbd, Pill } from '@/design-system/primitives'
import type { GridShortcutHint } from '@/design-system/grid'
import { STOP_WINDOW_MS } from './approvalActions'
import { CHOICE_LABEL, TEST_DAYS } from './automateWords'
import { FleetGateState, expiryHoursOf, useGateState, type GateRead } from './FleetGateState'
import { STATE_META } from './queueWords'
import styles from './HowItWorks.module.css'

const STOP_SECONDS = Math.round(STOP_WINDOW_MS / 1000)

/** The statuses in the order a request lives through them. Every state the API can send is here (tested). */
export const LIFE_ORDER: readonly QueueState[] = [
  'waiting', 'starting', 'on_hold', 'running', 'done', 'failed', 'back_to_you', 'rejected', 'expired', 'replaced', 'recorded',
]

/** What each status means, in one line. `hours` is the API's expiry, or null until it was read. */
export function stateHelp(state: QueueState, hours: number | null): string {
  switch (state) {
    case 'waiting': return 'It needs your yes or no. “Why / result” says why no rule ran it by itself.'
    case 'starting': return `Approved. It runs when the ${STOP_SECONDS}-second stop window ends (“Runs in 14 s”); Undo takes it back.`
    case 'on_hold': return 'Approved and held. It runs at the time shown, unless you undo it first.'
    case 'running': return 'It is running now. A plan shows how many of its steps are done.'
    case 'done': return 'It ran. “Done · reached eBay IT” when the channel confirmed it; “Done in Nexus” when Nexus cannot see the channel’s answer.'
    case 'failed': return 'It ran and failed. The row says why; Retry runs it again.'
    case 'back_to_you': return 'It did not run: the data changed since it was asked, or a permission or a rule stopped it. The row says why; decide again.'
    case 'rejected': return 'Someone said no. Nothing changed.'
    case 'expired': return `Nobody decided within ${hours != null ? `${hours} hours` : 'the time allowed'}. Nothing changed.`
    case 'replaced': return 'Someone changed its value. A new request with that value took its place.'
    case 'recorded': return 'Approved, but this kind can only describe a change: nothing ran.'
  }
}

/** The drawer's text, without the drawer (rendered on its own in tests). */
export function HowItWorksContent({ keys, gate, onRetryGate, now }: {
  /** The keys the page binds, as its hint line shows them. */
  keys: readonly GridShortcutHint[]
  gate: GateRead
  onRetryGate: () => void
  now?: number
}) {
  const hours = expiryHoursOf(gate)
  return (
    <div className={styles.body}>
      <section className={styles.section}>
        <h3 className={styles.heading}>A request is a change that waits for your yes</h3>
        <p className={styles.text}>
          Claude, or another part of Nexus, asks for a change. Nexus works out what it would do (the product, before → after,
          where it lands) and the request waits here. Nothing changes until someone approves it.
        </p>
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Each request has one status, from ask to result</h3>
        <ul className={styles.states} aria-label="The statuses">
          {LIFE_ORDER.map((state) => (
            <li key={state} className={styles.state}>
              <span className={styles.statePill}><Pill tone={STATE_META[state].tone} size="sm">{STATE_META[state].label}</Pill></span>
              <span className={styles.text}>{stateHelp(state, hours)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Approve waits {STOP_SECONDS} seconds, then runs</h3>
        <p className={styles.text}>
          Approve starts a {STOP_SECONDS}-second stop window. In it, Undo takes the approve back and Hold 10 min holds it.
          Then Nexus checks the request again (the data, your permission and the rule) and runs it. If anything changed, it
          comes back to you instead of running.
        </p>
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Reject stops it, and the reason goes back to Claude</h3>
        <p className={styles.text}>
          Nothing changes. A reason is optional; it goes back to whoever asked, so Claude sees why you said no.
        </p>
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Bulk approve takes one kind at a time</h3>
        <p className={styles.text}>
          Tick requests of the same kind, then press Approve in the toolbar. Each one still waits the stop window and is
          checked again before it runs. Never in bulk: refunds, messages, cancellations, closing a listing, deleting,
          change plans, or any kind that cannot be undone. Approve those one by one. Reject works on any mix.
        </p>
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Automate this kind lets a kind of change run without you</h3>
        <p className={styles.text}>
          Open it from a row’s ⋯ menu or from the details. Choose “{CHOICE_LABEL.ask}”, “{CHOICE_LABEL.confirm}” or
          “{CHOICE_LABEL.auto}”. A kind offers only the levels it allows, and some kinds always need you. The limits start
          from the request in front of you, and a test on your last {TEST_DAYS} days shows how many would have run by themselves.
        </p>
        <p className={styles.text}>
          Raising a level asks for the 6-digit code from your authenticator app; going back to “{CHOICE_LABEL.ask}” needs no
          code. A rule changes only new requests: the ones already here still wait for you. Every rule is also in{' '}
          <Link href="/settings/ai/claude" className={styles.link}>Settings › AI › Claude</Link>.
        </p>
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>
          {hours != null ? `Requests expire after ${hours} hours` : 'Requests expire when nobody decides in time'}
        </h3>
        <p className={styles.text}>
          {hours != null
            ? `A request nobody decides expires ${hours} hours after it was asked. Expired means no: nothing changes. A request that failed or came back to you starts a new ${hours} hours.`
            : 'A request nobody decides expires a fixed number of hours after it was asked. Expired means no: nothing changes.'}
        </p>
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Every decision works from the keyboard</h3>
        <ul className={styles.keys} aria-label="Keyboard shortcuts">
          <li className={styles.key}><span><Kbd>↑</Kbd> <Kbd>↓</Kbd></span><span className={styles.text}>Move between requests</span></li>
          {keys.map((hint) => (
            <li key={hint.key} className={styles.key}>
              <span><Kbd>{hint.keyLabel}</Kbd></span>
              <span className={styles.text}>{hint.label}{hint.key === 'a' ? ' (Retry on a failed request)' : ''}</span>
            </li>
          ))}
        </ul>
      </section>

      <FleetGateState read={gate} onRetry={onRetryGate} now={now} />
    </div>
  )
}

/** The header button and its drawer. The fleet's state is read when the drawer opens. */
export function HowItWorks({ keys }: { keys: readonly GridShortcutHint[] }) {
  const [open, setOpen] = useState(false)
  const gate = useGateState(open)
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <HelpCircle size={14} aria-hidden /> How it works
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="How approvals work"
        subtitle="From the ask to the result."
        width={560}
        closeLabel="Close How approvals work"
        className="fleet-portal"
      >
        {open && <HowItWorksContent keys={keys} gate={gate.read} onRetryGate={gate.reload} />}
      </Drawer>
    </>
  )
}
