/**
 * GDS / PES.2 — the ONE decision about whether a grid change should be written.
 *
 * Collapsed into a pure function (the #44 pattern, recommended by ruling #63) because these
 * conditions accumulate one `if` at a time in an event handler, where nothing tests them and a
 * missed case is invisible until it costs data. Every rule below was learned from a real defect.
 *
 * ## The three ways a `cellValueChanged` is NOT an operator's edit
 *
 * 1. **`source: 'data'`** — the grid's own data being set. Writing it back would save the sheet to
 *    the server every time it was populated.
 * 2. **A change the component caused itself** — a revert after a refusal, a repaint after a 409.
 *    🔴 `setDataValue` re-fires `cellValueChanged` and does NOT stamp `source: 'data'`, so no
 *    source check can catch this one: only the component knows a change is its own undo. It passes
 *    `selfInflicted` while it is doing it. PES.3 hit this as an acknowledgement bar that re-armed
 *    itself unescapably.
 * 3. **No column id** — nothing to address the write to.
 *
 * ## Why this is a deny-list, and it is deliberate
 *
 * AG types `source` as `string | undefined` and documents only EXAMPLES
 * (`'edit' | 'paste' | 'undo' | 'redo' | 'data'`). An allow-list would silently drop an edit whose
 * source string nobody predicted — a fill-handle variant, say — and **an edit that shows on screen
 * but never reaches the server is precisely the dishonesty a sheet exists to prevent**. Dropping a
 * real edit is the worse failure, so the gate names what is known not to be an edit and lets
 * everything else through.
 *
 * Pure and tested, so the reasons above are asserted rather than remembered.
 */

/** AG's own `source` for a change the grid made to its own data. */
export const NON_EDIT_SOURCES: readonly string[] = ['data']

export interface WriteGateInput {
  /** The column the change is on. Absent ⇒ nothing to address a write to. */
  colId?: string | null
  /** AG's `CellValueChangedEvent.source`. */
  source?: string
  /**
   * The component is mid-revert or mid-repaint and this change is its own.
   *
   * No source check can substitute for this: `setDataValue` re-fires the change event without
   * `source: 'data'`, so the only thing that knows is the code that caused it.
   */
  selfInflicted?: boolean
  /**
   * The cell's value before and after. **Both keys must be PRESENT for the unchanged rule to run**
   * — presence, not `undefined`, because `undefined` is itself a legitimate cell value. A caller
   * that passes neither gets exactly the behaviour this gate had before the rule existed.
   */
  oldValue?: unknown
  newValue?: unknown
}

export interface WriteGateVerdict {
  write: boolean
  /** Why not, when not. A dropped write must be explainable, not silent. */
  reason?: 'no-column' | 'grid-data' | 'self-inflicted' | 'unchanged'
}

const ALLOW: WriteGateVerdict = { write: true }

/**
 * Did the value actually move?
 *
 * `null` and `undefined` are the same answer — both mean the cell holds nothing, and which one a
 * row carries is an artefact of how it was built, not something an operator chose.
 *
 * 🔴 `''` is NOT folded in with them. Clearing a field to empty is a real edit an operator makes on
 * purpose, and treating it as "unchanged" would silently drop exactly the write they cared about —
 * the failure this gate's own header calls the worse one.
 *
 * Anything non-primitive compares as CHANGED. A structured cell (a readiness verdict) is never
 * editable, so this should not arise; if it somehow does, erring toward writing keeps the gate's
 * standing bias — dropping a real edit is worse than sending a redundant one.
 */
/**
 * Structural for arrays and plain objects (AM.1, 2026-09-05: `shape:'list'` cells hold `string[]`,
 * `shape:'measure'` cells hold `{ value, unit }`). The rule used to return `false` for any object,
 * which was right when no cell held one — and would have made every unchanged list or measure
 * re-commit on close, a write per Escape-less exit. Key order is normalised so `{value, unit}` and
 * `{unit, value}` are one value; anything that is not a plain object or array falls back to
 * identity, and a value that cannot be serialised is never "unchanged".
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true
  if (a === null || a === undefined || b === null || b === undefined) return false
  if (typeof a === 'object' || typeof b === 'object') {
    if (typeof a !== 'object' || typeof b !== 'object') return false
    if (Array.isArray(a) !== Array.isArray(b)) return false
    const key = (v: unknown): string | null => {
      try {
        return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x))
      } catch {
        return null
      }
    }
    const ka = key(a), kb = key(b)
    return ka !== null && ka === kb
  }
  return Object.is(a, b)
}

export function writeGate(input: WriteGateInput): WriteGateVerdict {
  if (!input.colId) return { write: false, reason: 'no-column' }
  if (input.selfInflicted) return { write: false, reason: 'self-inflicted' }
  if (input.source != null && NON_EDIT_SOURCES.includes(input.source)) return { write: false, reason: 'grid-data' }
  /**
   * 4. **The value did not change.** AG's FILL fires `cellValueChanged` for every cell in the range
   *    whether or not the value moved — its PASTE path equality-checks and its fill path does not,
   *    an asymmetry `sheetPasteProcessor` was already built around. Measured on the wire: filling
   *    `brand` down three rows that all already read "Xavia" issued **2 PATCHes for 0 changes**.
   *
   *    That is not merely wasteful. Every write carries the row's `expectedVersion`, so a no-op
   *    write can lose a 409 race against a real concurrent edit — the sheet reporting a conflict
   *    over a value nobody touched.
   *
   *    Last of the four deliberately: it is the only rule that inspects the VALUE rather than the
   *    provenance of the change, so the three cheaper provenance answers are settled first.
   */
  if ('oldValue' in input && 'newValue' in input && sameValue(input.oldValue, input.newValue)) {
    return { write: false, reason: 'unchanged' }
  }
  return ALLOW
}
