/**
 * R-47 (2026-09-23) — A NUMBER CELL NEVER LOSES ITS VALUE TO A STRAY LETTER.
 *
 * The defect, measured on the design of 2026-09-04: typing `Q` on `basePrice` (`0`) opened AG's number editor EMPTY,
 * so committing from there cleared the value. The studio's value popup (`FormulaCellEditor`, value mode) took the
 * letter as the new text instead — the server then refused `"Q"` per row, the database kept the number, and the cell
 * showed the refused letter. Either way a keystroke the operator did not mean as a number reached the save path.
 *
 * The rule, as Excel does it: a number cell accepts only what can still become a number. A start key that is not the
 * beginning of a number opens the editor on the STORED value and is refused; a later keystroke or paste that would
 * make the text not a number is refused whole. `=` stays the formula switch (#775) wherever formulas are available.
 * Clearing stays possible — by deleting the text, never by a stray letter.
 *
 * 🔴 Pure `.ts`, tested in node (apps/web vitest is node-only). The editor only WIRES these three functions.
 */
import { isFormulaDraft } from './formulaEditing'

/** What the operator is told when a keystroke or paste is refused. One sentence, stated where the edit happens. */
export const NUMBER_ONLY_MESSAGE = 'Numbers only — the value was kept.'

/**
 * A number, or the beginning of one, as an operator types it: an optional sign, digits, ONE decimal separator
 * (`.` or `,` — the operator's locale decides which they reach for), and an exponent only after a mantissa digit.
 * Partial states (`''`, `-`, `.`, `1.`, `1e`, `1e-`) are drafts: they are on the way to a number.
 *
 * 🔴 The exponent needs a mantissa digit. Without that clause `e` alone would pass as a draft — and `e` is exactly the
 * kind of stray letter this rule exists to refuse.
 */
const DRAFT = /^([+-]?)(\d*)(?:[.,](\d*))?(?:([eE])([+-]?)(\d*))?$/

export function isNumberDraft(raw: string): boolean {
  const m = DRAFT.exec(raw.trim())
  if (!m) return false
  if (m[4] && !(m[2] || m[3])) return false
  return true
}

/**
 * The keys that may START a number edit. Deliberately narrower than `isNumberDraft`: a space is a valid (empty)
 * draft, and as a start key it would replace the value with nothing — a wipe by the space bar.
 */
const START = /^[0-9+\-.,]$/

export interface NumberStart {
  /** The editor's opening text. */
  text: string
  /** Did the start key change anything? `false` ⇒ an untouched open, which never writes. */
  touched: boolean
  /** The start key was refused (the value was kept) — say so. */
  refused: boolean
}

/**
 * How a number editor opens. `eventKey` is the key that started the edit (AG passes the printable key; F2, Enter and a
 * double-click pass none). `stored` is the text the cell holds (its value, or `=<expr>` for a stored formula).
 */
export function numberStart(input: { eventKey?: string | null; stored: string; allowFormula: boolean }): NumberStart {
  const key = input.eventKey
  if (key == null || key.length !== 1) return { text: input.stored, touched: false, refused: false }
  if (key === '=' && input.allowFormula) return { text: '=', touched: true, refused: false }
  if (START.test(key)) return { text: key, touched: true, refused: false }
  return { text: input.stored, touched: false, refused: true }
}

/**
 * One edit — a keystroke, a paste, a deletion — judged whole. `prev` is the text before it, `next` the text after.
 * A formula draft passes when formulas are available (the operator typed `=` and is writing a rule, not a number).
 */
export function acceptNumberEdit(prev: string, next: string, allowFormula: boolean): { text: string; refused: boolean } {
  if (allowFormula && isFormulaDraft(next)) return { text: next, refused: false }
  if (isNumberDraft(next)) return { text: next, refused: false }
  return { text: prev, refused: true }
}

/**
 * The text a number edit commits: a draft with a decimal comma is written with a point, so `12,5` reaches the writer
 * as `12.5` and not as a string the server refuses. Anything that is not a number draft (a formula) is untouched.
 */
export function numberCommitText(text: string): string {
  if (!isNumberDraft(text)) return text
  return text.trim().replace(',', '.')
}
