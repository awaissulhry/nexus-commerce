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
import { CHIPS } from './lib'

/**
 * ⚠ S1R — a correction to rule 1, found while building on it.
 *
 * This file used to RESTATE all eleven census definitions, which `lib.ts`
 * already carried on `CHIPS[].definition`. So the header claimed one source
 * while shipping two copies of the same eleven sentences, and those copies were
 * themselves the drift the rule exists to prevent. They are derived now: a
 * chip's definition can only be written where the chip is declared, and the
 * zero-notes come from the same declaration.
 */
export const DEFINITIONS: Record<string, string> = {
  /* the census — derived from the chips, never restated */
  ...Object.fromEntries(CHIPS.map((c) => [c.id, c.definition])),
  ...Object.fromEntries(
    CHIPS.filter((c) => c.zeroNote != null).map((c) => [`${c.id}-zero`, c.zeroNote as string]),
  ),

  /* the edges */
  carried:
    'Findings this worker wrote that the director actually named in its plan. Counted from the plan itself, so it is what the director kept — not everything it read.',
  dropped:
    'Findings the director read and chose not to carry. It has to give a reason for every one, and those reasons are on the line’s panel.',
  'no-count':
    'The critic does not write anything of its own — it records a verdict on the plan in place. So there is nothing crossing this line to count, and it shows the verdict instead.',

  /* the standing facts beside the counts (S1R) — neither of these is a filter.
     A lens counts workers and its number is exactly the nodes left undimmed
     when you press it; these two count something else, so they are facts. */
  'spend-today':
    'What the whole fleet has spent on AI since midnight, against the hard daily cap. Past the cap, runs are refused before any model is called.',
  'findings-open':
    'Suggestions the workers have written that nothing has used or dismissed yet. This counts findings, not workers, so it is not something you can filter the map by.',

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
