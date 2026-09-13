/**
 * GDS / PES.2 — readiness, as ONE source of tone and label.
 *
 * Assigned to this lane by the programme's §3: *"Readiness vocabularies are TWO, deliberately …
 * No lane maps one onto the other locally; PES.2 exports `readinessMeta()` as the one tone/label
 * source."* This is that export.
 *
 * ## Two vocabularies, and why they must not be collapsed
 *
 * **ROW level** — `ready | missing | errors | live | unlisted`. One row against one channel
 * coordinate: what would happen if this SKU were published to Amazon · IT right now. `live` is not
 * a degree of readiness at all — it means our record holds a channel reference — and `unlisted`
 * means the question has never been asked. Computed per row by the sheet read.
 *
 * **SCOPE level** — `ready | warn | blocked | absent | notComputed`. A whole scope chip: Amazon ●92%,
 * eBay ⚠71%.
 * It summarises a family across every row and every required field, and its job is to tell an
 * operator which tab to open next.
 *
 * They look mappable and are not. `live` has no scope-level counterpart (a scope is never "already
 * published" — some of its rows are, some are not), `absent` has no row-level counterpart, and
 * `missing` vs `errors` is a distinction the chip deliberately discards while `warn` vs `blocked`
 * is a distinction about SHIPPABILITY that the row states do not carry. Any lane that writes its
 * own `state === 'errors' ? 'blocked' : …` has invented a rule nobody agreed, and two surfaces will
 * then disagree about the same family. So: no converter is exported here, on purpose. A scope
 * verdict comes from the readiness API; a row verdict comes from the sheet read.
 *
 * Pure — no React, so the tone/label table is testable and both apps can read it.
 */

/** One row against one channel coordinate. */
export type RowReadinessState = 'ready' | 'missing' | 'errors' | 'live' | 'unlisted'

/** A whole scope: the chips on the studio's scope bar. */
export type ScopeReadinessState = 'ready' | 'warn' | 'blocked' | 'absent' | 'notComputed'

export type ReadinessStateName = RowReadinessState | ScopeReadinessState

/** The DS `Pill` / `Chip` tone vocabulary. Kept as a string union so this file imports nothing. */
export type ReadinessTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info'

export interface ReadinessMeta {
  tone: ReadinessTone
  /** The word on the pill. */
  label: string
  /** Which vocabulary this state belongs to — a caller that cares can assert on it. */
  vocabulary: 'row' | 'scope'
  /** One sentence an operator can read on hover, when the caller has nothing more specific. */
  hint: string
}

const ROW: Record<RowReadinessState, ReadinessMeta> = {
  ready: { tone: 'success', label: 'Ready', vocabulary: 'row', hint: 'Every field this channel requires is filled — this row can be published' },
  live: { tone: 'info', label: 'Listed', vocabulary: 'row', hint: 'Our record holds a channel reference. Whether it is selling is on the presence line.' },
  missing: { tone: 'warning', label: 'Missing', vocabulary: 'row', hint: 'Required fields are empty — publishing would be refused' },
  errors: { tone: 'danger', label: 'Errors', vocabulary: 'row', hint: 'A value breaks this channel’s rules — publishing would be refused' },
  unlisted: { tone: 'neutral', label: 'No listing here', vocabulary: 'row', hint: 'We hold no listing record for this coordinate. Nothing has been checked against the channel.' },
}

/**
 * DECLARED IN SEVERITY ORDER, most attention first — and that order is the
 * contract, not a formatting choice (LX.F F6).
 *
 * `SCOPE_READINESS_STATES = Object.keys(SCOPE)` below is what the `/products/next`
 * readiness filter and the listing-readiness page offer, and what the studio's
 * parser accepts; the API sorts the catalogue by the SAME rank
 * (`readiness-model.ts` `SCOPE_STATES` / `scopeStateRank`, asserted equal by
 * `scope-readiness.vitest.test.ts`). It used to be `ORDER BY r.state` in SQL —
 * alphabetical — which put `ready` above `warn` and buried `blocked`.
 */
const SCOPE: Record<ScopeReadinessState, ReadinessMeta> = {
  blocked: { tone: 'danger', label: 'Blocked', vocabulary: 'scope', hint: 'Required fields are missing or invalid — this scope cannot publish' },
  warn: { tone: 'warning', label: 'Warnings', vocabulary: 'scope', hint: 'Publishable, with fields this channel may reject' },
  // R-LX-9 — absent is not empty. `absent` says an operator has set nothing up
  // here; `notComputed` says nobody has ASKED yet (no `ReadinessIndex` row for
  // this coordinate and language). Rendering the two the same let an unmeasured
  // scope read as a measured one — the "could not measure vs measured empty"
  // failure on a chip. Neutral like `absent`, and deliberately a different word.
  notComputed: { tone: 'neutral', label: 'Not computed', vocabulary: 'scope', hint: 'Readiness has not been computed for this scope and language yet — this is not a score of zero' },
  // Scope-neutral wording, deliberately: this table also renders the MASTER chip, which is not a
  // channel. "Not on this channel yet" read as a category error there (caught by PES.1).
  absent: { tone: 'neutral', label: 'Not set up', vocabulary: 'scope', hint: 'Nothing has been set up for this scope yet' },
  ready: { tone: 'success', label: 'Ready', vocabulary: 'scope', hint: 'Nothing is blocking this scope' },
}

/**
 * The tone and label for a readiness state.
 *
 * `ready` is the one name both vocabularies share, and it means the same thing in both, so the
 * caller says which vocabulary it is asking about. Defaulting would let a scope chip silently read
 * the row table — which is exactly the local mapping this file exists to prevent.
 */
export function readinessMeta(state: RowReadinessState, vocabulary: 'row'): ReadinessMeta
export function readinessMeta(state: ScopeReadinessState, vocabulary: 'scope'): ReadinessMeta
export function readinessMeta(state: ReadinessStateName, vocabulary: 'row' | 'scope'): ReadinessMeta {
  const table = vocabulary === 'scope' ? SCOPE : ROW
  const hit = (table as Record<string, ReadinessMeta | undefined>)[state]
  if (hit) return hit
  // An unknown state is a contract change, and a grid that renders it as "Ready" would be lying.
  // Name it instead: neutral, verbatim, and obviously not one of ours.
  return { tone: 'neutral', label: String(state), vocabulary, hint: `Unrecognised ${vocabulary} readiness state “${state}”` }
}

/**
 * The identity band's readiness pill colour — from the STATE and nothing else (#43, #727).
 *
 * 🔴 THE tone function for that pill, and it lives here rather than beside the component for two
 * reasons: this file owns the tone table, and this repo's vitest is `environment: 'node'` with no
 * JSX transform — a rule inside a `.tsx` cannot be imported by a test at all, so it would have
 * shipped unchecked. That is how the regression this fixes got in: `CompletenessPill` computed
 * `100 → full, <40 → low` from the PERCENTAGE, and on Amazon·DE an alias in state `errors` at 84%
 * painted neutral grey while the pill's own aria-label said "Error".
 *
 * Moved from PES.3's `channel/rows.ts` `aliasBarTone`, whose four cases move with it, so both scopes
 * cannot answer this differently.
 */
export function readyPillTone(state: RowReadinessState | null | undefined): ReadinessTone {
  /* No state is NEUTRAL and says so — master completeness is a ratio with no readiness behind it,
     and inventing a colour for it would be the same invention #43 forbids in the other direction. */
  if (state == null) return 'neutral'
  return readinessMeta(state, 'row').tone
}

/** Every state name in a vocabulary, for a legend or a filter's option list. */
export const ROW_READINESS_STATES = Object.keys(ROW) as RowReadinessState[]
export const SCOPE_READINESS_STATES = Object.keys(SCOPE) as ScopeReadinessState[]
