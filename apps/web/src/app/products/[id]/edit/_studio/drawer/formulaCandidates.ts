/**
 * PES.4 — what a `$reference` may name on the record open in the drawer (D16, #708/#775).
 *
 * 🔴 A pure module, and deliberately so. The list is built inside a React pane, and a rule that
 * lives inside a component in this repo cannot be tested at all: `apps/web`'s vitest is NODE-ONLY,
 * and a module that imports a `.tsx` reports "no tests" and looks GREEN while never running. The
 * types below are `import type` only — erased at compile time — so nothing here pulls a component
 * into the test program.
 *
 * 🔴 It must agree with `MasterSheet.candidatesFor` exactly. Two surfaces offering different
 * autocomplete for the same row is the drift the "shared = exactly the same" rule exists to stop,
 * and it would show as an operator finding a column on the sheet that the drawer will not complete.
 * The shape is pinned by this module's test rather than by anyone remembering.
 */
import type { FormulaCandidate } from '@/design-system/grid/editors/formulaEditing'
import type { FormulaFunctionDoc } from '@/design-system/grid/editors/formulaPreview'

/** Just enough of a column to describe it — the drawer's `SheetColumn`, structurally. */
export interface CandidateColumn {
  key: string
  label: string
}

/** Just enough of a cell to read its value — the drawer's `StudioCellValue`, structurally. */
export interface CandidateCell {
  value?: unknown
}

/**
 * Where ↑/↓ moves the highlight, as a pure rule.
 *
 * 🔴 Extracted from the keydown handler rather than left inline, and the reason is a measurement:
 * the only screen reading anyone took of this field's autocomplete had a **single match**, so the
 * wrap arithmetic was never exercised on screen and could not be — a one-row list looks identical
 * whether the modulo is right, inverted, or off by one. Verifying it in a browser would have meant
 * another live session on a production fixture to test two lines of arithmetic. This is the cheaper
 * and stricter answer.
 *
 * Wraps deliberately: a list that stops dead at either end makes an operator who overshot travel all
 * the way back. `count === 0` returns the current index untouched — there is nothing to highlight,
 * and moving to 0 would point `aria-activedescendant` at a row that is not rendered.
 */
export function nextActiveIndex(current: number, key: 'ArrowDown' | 'ArrowUp', count: number): number {
  if (count <= 0) return current
  /* 🔴 There is no separate "normalise `current` first" step, and there WAS one until a mutation
     test showed it did nothing: for any index ≥ 0 the modulo below already folds a past-the-end
     value back into range (`(9+1) % 3 === 1`, and `(9-1+3) % 3 === 2` — identical with or without
     pre-normalising), and `current` cannot be negative because it only ever comes from this
     function, from `setActiveIndex(0)`, or from the panel's own index. The line read as a guard,
     was dead for every reachable input, and its comment claimed work it did not do. A stale index
     from a list that has since shrunk is still handled — by the modulo, which is load-bearing. */
  return key === 'ArrowDown' ? (current + 1) % count : (current - 1 + count) % count
}

export function buildFormulaCandidates(
  columns: readonly CandidateColumn[],
  values: Readonly<Record<string, CandidateCell | undefined>>,
  functions: readonly FormulaFunctionDoc[],
): FormulaCandidate[] {
  const cols = columns.map((col) => {
    const raw = values[col.key]?.value
    return {
      name: col.key,
      kind: 'field' as const,
      label: col.label,
      /* 🔴 The literal `'Columns'`, NOT the column's own group. The drawer groups its FORM by
         `col.group` ("Identity", "Compliance", …), so passing that through here would split the
         autocomplete into a dozen headed sections where the sheet shows exactly one — the same list,
         shaped differently, on two surfaces. */
      group: 'Columns',
      /* 🔴 Absent, never `''`, for an empty cell. The editor draws no value chip for a field with
         nothing in it, and an empty chip and a missing one look identical while meaning different
         things — "this column is empty" vs "this candidate has no value to show". */
      value: raw == null || raw === '' ? undefined : String(raw),
    }
  })
  const fns = functions.map((f) => ({
    name: f.name,
    kind: 'function' as const,
    label: f.signature,
    group: 'Functions',
  }))
  /* Fields first. `completionsFor` ranks them ahead of functions anyway, but the order it is HANDED
     is the order equal-ranked entries keep, and the Owner's cases are "pull the value from that
     column" — a language reference is the rarer need. */
  return [...cols, ...fns]
}
