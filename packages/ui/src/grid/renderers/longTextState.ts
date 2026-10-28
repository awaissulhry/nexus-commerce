/**
 * GDS — what a long-text cell's length MEANS, as a state rather than a number (spec §9.3a).
 *
 * ## Why this is a state and not a counter
 *
 * `LongTextCell` used to render "127/200" beside one line of text. At 160px the text already
 * truncates to `XAVIA G…`; at the 110px §9.3 gives these columns the counter would be most of the
 * cell, so the width saving would be spent on the least useful half of its content. The cell's job
 * in a sheet is *empty / fine / nearly out of room / already refused* — the exact figures belong in
 * the tooltip, where they cost nothing.
 *
 * ## Why it is a separate `.ts` with NO imports
 *
 * `apps/web`'s vitest runs in a node environment and cannot render a component, so a rule living
 * inside `cells.tsx` can only be asserted, never tested. `provenance.ts`, `readiness.ts` and
 * `mediaCell.ts` already split this way — the vocabulary in a `.ts`, the rendering in the `.tsx`.
 * 🔴 Nothing on this module's import path may be a `.tsx`, which is why the params type lives HERE
 * and `cells.tsx` re-exports it, rather than the other way round.
 *
 * ## The five states, and why `unchecked` is not `filled`
 *
 * UX.1 ruled four marks (`empty · filled · near · over`) with three conditions, and their second
 * one produces the fifth: *where no cap is known there is no `near` and no `over`, and the cell must
 * not imply a cap exists.* A cell can be **unchecked** rather than **within cap** — the `caps` pill
 * exists precisely because a product type can have no cached schema. Measured on GALE-JACKET,
 * **60 of 96 columns carry no cap at all**, so this is the majority case, not an edge. Collapsing
 * `unchecked` into `filled` would assert compliance from missing information.
 *
 * 🔴 **`unchecked` means "no cap known HERE", never "no cap exists"** (UX.1's amendment). Some of
 * those 60 are not uncapped, they are UNDELIVERED: `product_description` carries `maxBytes: 20000`
 * on the wire and it reached the cell as a unit flag with the cap itself dropped — *a cap that was
 * never passed is not an absent cap*. So nothing here — the name, the tooltip, the label, or any
 * test — may assert that the FIELD has no limit. When the wire half lands, those cells move to
 * `filled`/`near`/`over` without this model having claimed anything it must then retract.
 *
 * The sheet-level fact has its own home: the `caps` notice, which says the schema was never cached.
 * The MARK answers "what about this cell"; the NOTICE answers "did we know at all".
 */

import { evaluateLengthCaps } from '../editors/sheet'

/** How much room is left before the mark warns. */
export const NEAR_RATIO = 0.8

export type LongTextState = 'empty' | 'unchecked' | 'filled' | 'near' | 'over'

/** The caps as the wire states them. Both may be present, in different units. */
export interface LongTextCaps {
  /** Character cap. */
  maxLength?: number | null
  /** Byte cap — Amazon counts UTF-8 bytes on some fields. */
  maxBytes?: number | null
  /** Which channel imposes the tightest cap, e.g. `"Amazon · DE"`. UX.1's condition 1: a mark names its source. */
  capFrom?: string | null
  /** Shown when the cell is empty and the field is required. */
  required?: boolean
}

export interface LongTextReading {
  state: LongTextState
  /** The value's length in the BINDING cap's unit; `null` when nothing caps it. */
  length: number | null
  cap: number | null
  unit: 'characters' | 'bytes' | null
  capFrom: string | null
  /** Everything the mark does not say, for the cell's tooltip. */
  title: string
}

/**
 * 🔴 The VERDICT is not computed here. `evaluateLengthCaps` (PES.2, `editors/sheet.ts`) is the one
 * implementation — which caps apply, which one binds, and whether the value is over — and
 * `lengthValidation` calls the same function. That is the whole point: the mark an operator sees and
 * the refusal they eventually get cannot reach different answers about one cell. This module owns
 * only the MAPPING to five states and the wording.
 *
 * ⚠ `../editors/sheet` keeps this module's node-testability: its sole import is `import type` from
 * `ag-grid-community`, erased at runtime. A VALUE import there would drag AG's runtime into every
 * node test that reaches this file — there is a note on that file saying so, and it needs to stay.
 */
export function longTextState(value: unknown, caps: LongTextCaps = {}): LongTextReading {
  const text = value == null ? '' : String(value)
  const capFrom = caps.capFrom ?? null

  if (!text) {
    return {
      state: 'empty',
      length: null,
      cap: null,
      unit: null,
      capFrom,
      title: caps.required ? 'Required — no value yet' : 'No value yet',
    }
  }

  const reading = evaluateLengthCaps(text, {
    characters: caps.maxLength ?? null,
    bytes: caps.maxBytes ?? null,
    capFrom,
  })

  // Condition 2: `null` — no cap declared in EITHER unit — is `unchecked`, never `filled`. The
  // absence of a cap is not compliance with one, and the tooltip says so rather than showing a
  // reassuring nothing.
  if (!reading) {
    return {
      state: 'unchecked',
      length: null,
      cap: null,
      unit: null,
      capFrom,
      // Phrased as a fact about DELIVERY, not about the field. See the header: some of these
      // columns do have a cap that simply never arrived.
      title: `${text.length} characters · no length cap was supplied for this column`,
    }
  }

  // `over` is the evaluator's (`n > cap`); `near` is the MARK's own threshold, which the validator
  // has no equivalent of — it only refuses, it does not warn.
  const state: LongTextState = reading.over ? 'over' : reading.ratio >= NEAR_RATIO ? 'near' : 'filled'

  /* An absent `capFrom` must read as UNKNOWN, not as absent. Rendering '' here made a cap with no
     stated source look like a cap with no source — the field simply vanished from the tooltip.
     DEFENSIVE BRANCH, not the live shape: measured 2026-09-02 on
     `GET /products/:id/studio/columns?market=DE&locale=de`, 37 of 37 capped columns carry
     `capFrom` (PES.5 sets it for any declared cap), and 24 combinations (3 products x 2 markets x
     4 scopes) found 0 capped-but-unattributed columns.
     🔴 A REAL defensive branch, not ceremony: the eBay and Shopify scopes carry zero capped
     columns at all, so "an Amazon cap surviving into a scope with no Amazon coordinate to name"
     is untested BECAUSE IT DOES NOT OCCUR TODAY — not proven impossible. If eBay gains
     category-attribute columns, that is exactly where it reappears (hub #422). */
  const source = reading.capFrom ? ` (${reading.capFrom})` : ' (cap source not stated)'
  const phrase =
    state === 'over'
      ? ` — ${reading.n - reading.cap} over the cap, this channel will refuse it`
      : state === 'near'
        ? ` — ${reading.cap - reading.n} left`
        : ''
  /**
   * Every declared cap is named with its unit (PES.5's requirement) — a single number is wrong on
   * one of the four measured shapes whichever it picks: quote only characters and `style`
   * (2,200 ch / 2,000 B) hides the byte cap that actually refuses; quote only bytes and `size`
   * (50 ch / 2,000 B) hides the char cap that binds at a fortieth of it.
   *
   * Worded as `also max N unit` deliberately: that is `lengthValidation`'s own phrasing for the same
   * fact, so the tooltip an operator reads while typing and the refusal they get on publish use the
   * same words for the same cap.
   */
  const also = reading.other ? ` · also max ${reading.other.cap} ${reading.other.unit}` : ''
  const title = `${reading.n} of ${reading.cap} ${reading.unit}${source}${phrase}${also}`

  return { state, length: reading.n, cap: reading.cap, unit: reading.unit, capFrom: reading.capFrom, title }
}

/**
 * What the mark says out loud. Separate from the tooltip because a screen reader should get the
 * STATE without the arithmetic, and because a mark whose only distinction is colour is unreadable
 * to a large minority of operators (UX.1's condition 3 — the glyph carries it, the tone reinforces).
 */
export function longTextMarkLabel(r: LongTextReading): string {
  /* 🔴 `?? 'channel'` used to stand in for a missing source, which reads as "we know the channel and it
     is unremarkable" rather than "we cannot say whose cap this is". A warning that cannot name its
     source must SAY SO — UX.1's condition 1 is that a mark names its source, and silently generic is
     the failure that condition exists to prevent (DS1-25).
     Live shape carries `capFrom` on 37 of 37 capped columns (measured 2026-09-02); this is the
     fallback for a producer that does not, never the expected case.
     ⚠ Latent, zero columns today (PES.5): ONE `capFrom` describes BOTH caps, so it is ambiguous if a
     character cap ever comes from eBay on a field Amazon byte-caps. */
  const from = r.capFrom ? `the ${r.capFrom} cap` : 'the cap — source not stated'
  switch (r.state) {
    case 'over':
      return `Over ${from}`
    case 'near':
      return `Near ${from}`
    case 'unchecked':
      return 'No length cap supplied'
    default:
      return 'Within the cap'
  }
}
