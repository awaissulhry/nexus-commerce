/**
 * GDS — the visible verbs of a row (gap G2, the approvals grid, 2026-10-05).
 *
 * `actionsColumn` drew ONE button (Edit) and a `⋯` menu. A queue needs two verbs on every row — Approve and Reject
 * — each one click, each with its own weight, and a verb that cannot run must stay on screen and say why
 * (check-silent-disabled, U13). This file is the vocabulary and the rules, pure, so they are tested; `ActionsCell`
 * (`cells.tsx`) only draws. Mirrored byte-for-byte in Factory, like `cells.tsx` that imports it.
 */
import type { ReactNode } from 'react'

import type { ButtonVariant } from '../../primitives/Button'

/**
 * A verb's weight. `primary` = the blue fill (the verb the row is waiting for); `default` = the DS base button;
 * `danger` = the red OUTLINE (`danger-outline`), not the red fill — a fill on every row reads as a column of alarms,
 * and the fill is reserved for irreversible live writes (`Button`'s own note).
 */
export type RowVerbTone = 'primary' | 'default' | 'danger'

export interface RowVerb<T = unknown> {
  /** React key and test handle. Defaults to the label when that is a string. */
  id?: string
  label: ReactNode
  /** Default `default` — the look a lone `primary` button always had. */
  tone?: RowVerbTone
  /** A link instead of a button (Edit → the editor). A held verb is never a link. */
  href?: (data: T) => string
  onClick?: (data: T) => void
  /**
   * Hold the verb for this row: return the REASON ("The stock count is older than 24 h — refresh it first").
   * A held verb stays focusable, shows the reason as a tooltip and to screen readers, and does nothing on click.
   * There is no reason-less form on purpose: a control that refuses must say why.
   */
  disabled?: (data: T) => string | null | undefined | false
  /** The accessible name when the label alone repeats on every row: "Approve: Set price XR-GLOVE-M". */
  ariaLabel?: (data: T) => string
}

/** At most two verbs are drawn as buttons; everything else belongs in the `⋯` menu. */
export const MAX_ROW_VERBS = 2

/** What a row offers: none, one or two verbs — typed, so a third cannot be passed by accident. */
export type RowVerbs<T = unknown> = readonly [] | readonly [RowVerb<T>] | readonly [RowVerb<T>, RowVerb<T>]

/**
 * `actionsColumn({ primary })`: ONE verb (the original shape, `{ label, href?, onClick? }`), up to TWO
 * (`[approve, reject]`), or a function of the row that returns 0–2 (a waiting row offers Approve + Reject, a failed
 * one Retry, a finished one nothing).
 */
export type RowVerbsInput<T = unknown> =
  | RowVerb<T>
  | readonly [RowVerb<T>]
  | readonly [RowVerb<T>, RowVerb<T>]
  | ((data: T) => RowVerbs<T>)

const isList = <T,>(input: RowVerbsInput<T>): input is readonly [RowVerb<T>] | readonly [RowVerb<T>, RowVerb<T>] => Array.isArray(input)

/** The verbs to draw for one row, in order, never more than two. */
export function rowVerbsOf<T>(input: RowVerbsInput<T> | undefined, data: T): readonly RowVerb<T>[] {
  if (!input) return []
  const list: readonly RowVerb<T>[] = typeof input === 'function' ? input(data) ?? [] : isList(input) ? input : [input]
  return list.slice(0, MAX_ROW_VERBS)
}

/** True for the shapes this gap added (a list or a function) — the single-object form keeps every old default. */
export function isMultiVerb<T>(input: RowVerbsInput<T> | undefined): boolean {
  return !!input && (typeof input === 'function' || isList(input))
}

/** The DS `Button` variant for a tone. `default` is `secondary`, the variant the single Edit button always drew. */
export function rowVerbVariant(tone: RowVerbTone | undefined): ButtonVariant {
  if (tone === 'primary') return 'primary'
  if (tone === 'danger') return 'danger-outline'
  return 'secondary'
}

/** The reason this verb is held for this row, or null when it can run. A blank reason is not a reason. */
export function rowVerbHeld<T>(verb: RowVerb<T>, data: T): string | null {
  const reason = verb.disabled?.(data)
  return typeof reason === 'string' && reason.trim() ? reason : null
}

/** React key for a verb. */
export function rowVerbKey<T>(verb: RowVerb<T>, index: number): string {
  return verb.id ?? (typeof verb.label === 'string' ? verb.label : String(index))
}

/**
 * The column's default width, from its shape (#690: the width follows the shape, it is derived, not chosen by eye).
 * `⋯` only = 56 (28 + 2 × 14 cell padding); one verb = 120 (unchanged since #690); two verbs, or a function that may
 * return two = 200 (two `sm` buttons of ~7 letters, the `⋯`, two 6px gaps and the padding). A page with longer
 * labels passes `width`.
 */
export function actionsColumnWidth<T>(input: RowVerbsInput<T> | undefined): number {
  if (!input) return 56
  if (typeof input === 'function') return 200
  return isList(input) && input.length > 1 ? 200 : 120
}

/**
 * AG Grid 36.1 `utils/gridEvent.ts`: `_stopPropagationForAgGrid` sets this flag on the native event, and the row,
 * cell and keyboard listeners of the grid return early when they find it. Written out here because this file is
 * mirrored into Factory, which has no AG runtime; `rowVerbs.vitest.test.ts` checks it against AG's own reader, so an
 * AG upgrade that renames it fails a test instead of silently reopening rows on every click.
 */
export const AG_STOP_PROPAGATION_FLAG = '__ag_Grid_Stop_Propagation'

/**
 * Keep a click on a verb from reaching the GRID — no `rowClicked` (the row's drawer), no `cellClicked`, no
 * click-selection — while the button's own handler still runs.
 *
 * 🔴 Not `stopPropagation()`. AG listens on its row container, BELOW React's root, so a React `onClick` that stops
 * propagation runs after AG already opened the row. And a native stop on the cell would also keep the click from
 * React's root, so the button itself would never fire. The flag is the one channel AG reads that leaves the event
 * alone. Bind it in the CAPTURE phase (`onClickCapture`): React runs capture handlers at its root on the way down,
 * before AG's bubble listener sees the event.
 */
export function keepFromGrid(event: Event | { nativeEvent: Event }): void {
  const native = 'nativeEvent' in event ? event.nativeEvent : event
  ;(native as unknown as Record<string, unknown>)[AG_STOP_PROPAGATION_FLAG] = true
}
