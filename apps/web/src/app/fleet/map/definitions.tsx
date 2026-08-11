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

import { useEffect, useState, type ReactNode } from 'react'
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
  /* S8.e — `spend` lived here with no reader, and it goes rather than being
     given one. Its sentence ("what this worker spent in the window you are
     looking at") is now said by two surfaces that a reader actually meets: the
     rail's own Spend row, which prints "…in this window · …ever" beside the
     figure, and S8.c's window section in the drawer. A third copy kept only to
     satisfy a rule about keys is the drift the rule exists to prevent. */
  /* S8.d — `no-runs` used to live here with its own copy of the cost legend's
     sentence, and the two had already drifted four words apart in the middle:

       legend  "…so it has no cost here — which is not the same as being cheap."
       here    "…so there is nothing to measure — which is not the same as…"

     I first tried DERIVING this key from the overlay bucket. The S8.f test
     rejected it, correctly: deriving is not reading, and a key nothing renders
     is dead however it is computed. So it goes. The overlay owns the sentence
     because the overlay is what puts it on screen, and there is now exactly one
     copy of it in the repo.

     The card's `— no runs` and the list's `no runs in this window` are LABELS in
     fixed-width slots, not the sentence, and are not a second and third wording.
     The card has 18px of slack before it reproduces S7.c's overflow. */
}

/**
 * Wraps a trigger and gives it a focusable, screen-reader-associated
 * definition. The child must accept `aria-describedby`; in practice it is a
 * button, and the definition appears on hover AND on keyboard focus.
 *
 * S1R — TWO MEASURED FAILURES OF WCAG 2.2 SC 1.4.13, both fixed here.
 *
 * **Hoverable** — *"the pointer can be moved over the additional content
 * without the additional content disappearing."* The tip was
 * `pointer-events: none`, and hit-testing the centre of each of the five open
 * tooltips on prod returned the element behind it, five times out of five. It
 * takes the pointer now, and a bridge spans the 7px gap so the pointer can
 * cross without leaving the wrapper.
 *
 * **Dismissible** — *"a mechanism is available to dismiss the additional
 * content without moving pointer hover or keyboard focus."* There was no key
 * handler at all. Escape dismisses now, and the listener is registered **only
 * while a tip is actually shown** — the Approvals stream's first cut of the
 * same fix registered from every un-dismissed instance, so one Escape on a page
 * with 39 of them dismissed all 39.
 *
 * AND ONE THING THAT WAS NOT A WCAG FAILURE BUT WAS WORSE IN PRACTICE: the tip
 * was hidden with `opacity: 0` while staying `visibility: visible`, with no
 * `aria-hidden`, so it was in the accessibility tree whether open or closed.
 * The census strip's flat text measured **808 characters for 60 characters of
 * label** — every definition read once in browse mode and again as the
 * trigger's description. `visibility: hidden` takes it out of browse mode while
 * leaving it reachable through `aria-describedby`, which is the whole point of
 * describing rather than labelling.
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
  const [over, setOver] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const shown = over && !dismissed

  useEffect(() => {
    if (!shown) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Dismiss the tip and stop there: the page's own Escape handler clears
      // the selection and then the active filter, and dismissing a tooltip
      // must not also drop the reader's filter.
      e.stopPropagation()
      setDismissed(true)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [shown])

  if (!text) return <>{children({ 'aria-describedby': '' })}</>

  // Re-arms on leave/blur, so a tip dismissed with Escape comes back the next
  // time you actually ask for it.
  const enter = () => {
    setOver(true)
    setDismissed(false)
  }
  const leave = () => {
    setOver(false)
    setDismissed(false)
  }

  return (
    <span
      className={`sbm-def ${shown ? 'is-open' : ''}`}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={leave}
    >
      {children({ 'aria-describedby': id })}
      <span role="tooltip" id={id} className="sbm-def-tip">
        {text}
      </span>
    </span>
  )
}
