/**
 * GDS — what the formula editor's PREVIEW LINE and function hint say (#730).
 *
 * 🔴 The engine is the authority on what a formula means, and none of that is decided here. The
 * server evaluates (`POST /pim/formulas/preview`, `expr.ts`, 34 functions and a Pratt parser); this
 * decides only how the answer is PRESENTED, which is a different question and the one that has to
 * be right at every keystroke rather than once at the end.
 *
 * It is a separate module from the component for the reason every rule in this folder is: a `.tsx`
 * cannot be imported by this repo's vitest at all — no jsdom, no JSX transform — so a rule that
 * lived in the editor would report "no tests" and look green while never running (banked,
 * `reference_test_scoping_and_hidden_assertions`).
 */
import type { CallContext } from './formulaTokens'

/**
 * The preview endpoint's answer, as the route actually shapes it
 * (`apps/api/src/routes/cell-formula.routes.ts`).
 *
 * 🔴 `ok: true` with `value: null` is a REAL state and not an error: the formula parsed, resolved
 * and produced nothing. The route is careful about this (an unknown reference returns `ok: false`
 * with a position, #723) and an editor that folded the two together would tell an operator their
 * formula was broken when it is merely empty — or worse, the reverse.
 */
export interface FormulaPreviewResponse {
  ok: boolean
  value?: unknown
  before?: unknown
  expectedState?: string
  sourceLabel?: string
  error?: string | null
  retryable?: boolean
  /** 0-based index into the EXPRESSION (the `=` already stripped) — see `previewLine`. */
  errorPos?: number | null
  unknownRefs?: Array<{ name: string; pos: number }>
  dependsOn?: string[]
  unresolved?: string[]
}

/**
 * What to draw under the field.
 *
 * `checking` carries the last good value deliberately — see `previewLine`.
 */
export type PreviewLine =
  | { kind: 'idle' }
  | { kind: 'checking'; last: string | null }
  | { kind: 'value'; value: string }
  | { kind: 'empty' }
  | { kind: 'error'; message: string; pos: number | null }

export interface PreviewState {
  /** The expression as typed, `=` already stripped. */
  expr: string
  /** A request is in flight for the CURRENT text. */
  inFlight: boolean
  /** The most recent response, whatever it was for. */
  response: FormulaPreviewResponse | null
  /** The last value the server returned successfully, for the flicker rule below. */
  lastGood: string | null
}

/**
 * The preview line, from the editor's state.
 *
 * 🔴 **An in-flight request keeps the last good value on screen rather than blanking.** The line
 * updates per keystroke, and a version that cleared while waiting flickered the answer away exactly
 * when the operator was reading it — the one thing §1.3 step 2 exists to show. `checking` is a
 * presentation state carrying the previous answer, so the caller can dim it instead of losing it.
 *
 * 🔴 **A stale ERROR is not kept, and that asymmetry is the point.** A value that is one keystroke
 * out of date is still informative; an error that is one keystroke out of date is a claim about text
 * the operator has already fixed, and it reads as "still broken" while they stare at correct input.
 * So an error survives only while it is the answer to the CURRENT text.
 *
 * An empty expression is `idle`, never an error: a cleared field is how an operator abandons a
 * formula, and shouting at them for it is the disabled-control-that-cannot-explain-itself shape.
 */
export function previewLine({ expr, inFlight, response, lastGood }: PreviewState): PreviewLine {
  if (expr.trim() === '') return { kind: 'idle' }
  if (inFlight) return { kind: 'checking', last: lastGood }
  if (!response) return { kind: 'checking', last: lastGood }
  if (response.ok === false) {
    return {
      kind: 'error',
      message: response.error ?? 'This formula could not be evaluated.',
      pos: typeof response.errorPos === 'number' ? response.errorPos : null,
    }
  }
  const v = response.value
  if (v === null || v === undefined || v === '') return { kind: 'empty' }
  return { kind: 'value', value: typeof v === 'object' ? JSON.stringify(v) : String(v) }
}

/**
 * Where to underline an error in the TEXT, given the position the server reported.
 *
 * 🔴 The server counts into the expression; the field contains the leading `=`. Off by one, every
 * time, and it points the operator at the character BEFORE the mistake — which for `$brnd` is the
 * `$`, i.e. at the one part that was right. `offset` is the length of what `exprOf` stripped.
 *
 * Returns `null` rather than clamping when the position is outside the text: a mark drawn at a
 * position the text does not have is a guess wearing the authority of a measurement.
 */
export function errorMarkAt(pos: number | null, exprLength: number, offset: number): number | null {
  if (pos === null || !Number.isFinite(pos) || pos < 0) return null
  if (pos >= exprLength) return null
  return pos + offset
}

/** One function's documentation, as `GET /pim/formulas/functions` returns it. */
export interface FormulaFunctionDoc {
  name: string
  signature: string
  group?: string
  summary?: string
}

export interface FunctionHint {
  signature: string
  summary: string
  /** Which argument the caret is in, 0-based — the caller emboldens it. */
  argIndex: number
  /** The argument names parsed out of the signature, for the emphasis. */
  args: string[]
}

/**
 * The signature hint for the call the caret is inside.
 *
 * 🔴 Matched case-insensitively, because `expr.ts` accepts `IF(…)` and the docs are lower-case. A
 * case-sensitive lookup silently showed no hint for a formula that runs perfectly — the shape of a
 * help affordance that appears to be missing rather than wrong.
 *
 * `null` when the caret is not in a call, or the name is not one the server documents. An UNKNOWN
 * function gets no invented hint: the preview line will carry the server's own verdict, and a hint
 * for a function that does not exist would contradict it.
 */
export function functionHint(call: CallContext | null, docs: readonly FormulaFunctionDoc[]): FunctionHint | null {
  if (!call || call.name === '') return null
  const name = call.name.toLowerCase()
  const doc = docs.find((d) => d.name.toLowerCase() === name)
  if (!doc) return null
  return {
    signature: doc.signature,
    summary: doc.summary ?? '',
    argIndex: call.argIndex,
    args: signatureArgs(doc.signature),
  }
}

/**
 * The argument names inside a signature: `if(condition, then, else?)` → `['condition','then','else?']`.
 *
 * Split at TOP-LEVEL commas only, so a signature carrying a nested list does not fragment. Returns
 * `[]` for a signature with no parentheses rather than throwing — the docs are server data and this
 * runs on every keystroke.
 */
export function signatureArgs(signature: string): string[] {
  const open = signature.indexOf('(')
  const close = signature.lastIndexOf(')')
  if (open < 0 || close <= open) return []
  const inner = signature.slice(open + 1, close).trim()
  if (inner === '') return []
  const out: string[] = []
  let depth = 0
  let buf = ''
  for (const ch of inner) {
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      out.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim() !== '') out.push(buf.trim())
  return out
}

/**
 * Which references to mark RED, merging the server's verdict with the local typing aid.
 *
 * 🔴 The server's list wins where it exists, and the local one only fills the gap BEFORE the first
 * response arrives. `unknownRefs` from the route is authoritative — it is computed against the same
 * column key set the sheet exposes for this row and market (#728/#729) — while the client's
 * `unknownRefs()` knows only the columns currently on screen. Preferring the local list would mark
 * a perfectly good reference red because the operator has a filtered view, which is a false alarm on
 * the one signal that has to be trusted.
 *
 * Both are keyed by NAME, lower-cased: `$Brand` and `$brand` are one reference and must not be
 * marked half-red.
 */
export function unknownRefNames(
  serverUnknown: ReadonlyArray<{ name: string }> | undefined,
  localUnknown: readonly string[],
  hasServerAnswer: boolean,
): Set<string> {
  const src = hasServerAnswer ? (serverUnknown ?? []).map((u) => u.name) : localUnknown
  return new Set(src.map((n) => n.toLowerCase()))
}
