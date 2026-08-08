'use client'

/**
 * NAF.SB.M.8 — every number on this page, defined once.
 *
 * TWO RULES.
 *
 * 1. ONE SOURCE. A count defined next to the chip that renders it and again
 *    next to the table column that renders the same figure is two definitions
 *    that will drift. Everything is keyed here; the surfaces look it up.
 *
 * 2. NOT A `title` ATTRIBUTE. The first cut of this page used the native
 *    tooltip, which was the exact mistake this study criticised the entity
 *    legend for: a `title` is unreachable by keyboard, is not announced
 *    reliably by screen readers, and never appears on touch. If a fact is
 *    needed to understand the screen it must be focusable, and the trigger
 *    must own it via `aria-describedby` so the association survives whatever
 *    the visual does.
 *
 * The tooltip opens DOWNWARD, because these triggers sit at the top of the
 * page where an upward bubble would be clipped by the header.
 */

import type { ReactNode } from 'react'

export const DEFINITIONS: Record<string, string> = {
  /* the census */
  workers:
    'Every worker drawn on this map: the ones your enabled routines name, plus the ones the nightly job runs itself. Retired workers are not drawn.',
  running: 'Working right now — a run has started and has not finished.',
  working: 'Switched on, allowed to act, and its last run finished cleanly.',
  off: 'You have switched it off, or its dial is at OFF. It will not start, whatever the schedule says.',
  paused: 'Temporarily stopped, with an end date. A pause is never a forgotten off switch.',
  'not-set-up':
    'It exists in code but has no settings row yet, so it cannot be switched on until one is created.',
  attention: 'Something about this worker needs a decision from you. The card says what.',
  'never-run':
    'Has never run at all, over the whole life of the fleet — not just in the window you are looking at.',
  'last-failed':
    'Its most recent run ended in a real failure. A run stopped by one of its own limits is counted separately, because that is a limit working.',
  'hit-a-limit':
    'Its last run hit one of its own budget or token limits and stopped part-way. Nothing is broken — this is a safety limit doing its job.',
  waiting: 'Proposals from this worker that are waiting for your yes or no.',

  /* the zeros that have a cause worth stating */
  'waiting-zero':
    'No worker can put anything here yet: the fleet’s proposal tools are preview-only, so a plan that passes the critic still queues nothing.',
  'running-zero': 'Nothing is running at this moment.',

  /* the edges */
  carried:
    'Findings this worker wrote that the director actually named in its plan. Counted from the plan itself, so it is what the director kept — not everything it read.',
  dropped:
    'Findings the director read and chose not to carry. It has to give a reason for every one, and those reasons are on the line’s panel.',
  'no-count':
    'The critic does not write anything of its own — it records a verdict on the plan in place. So there is nothing crossing this line to count, and it shows the verdict instead.',

  /* cost */
  spend: 'What this worker spent on AI in the window you are looking at.',
  'no-runs':
    'It did not run in this window, so there is nothing to measure — which is not the same as being cheap.',
}

/**
 * Wraps a trigger and gives it a focusable, screen-reader-associated
 * definition. The child must accept `aria-describedby`; in practice it is a
 * button, and the definition appears on hover AND on keyboard focus.
 */
export function Def({
  k,
  note,
  children,
}: {
  k: string
  /** Overrides the keyed text — used when a zero has its own cause. */
  note?: string
  children: (props: { 'aria-describedby': string }) => ReactNode
}) {
  const text = note ?? DEFINITIONS[k]
  const id = `sbm-def-${k}`
  if (!text) return <>{children({ 'aria-describedby': '' })}</>
  return (
    <span className="sbm-def">
      {children({ 'aria-describedby': id })}
      <span role="tooltip" id={id} className="sbm-def-tip">
        {text}
      </span>
    </span>
  )
}
