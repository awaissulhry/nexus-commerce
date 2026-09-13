/**
 * GDS — WHAT EVERY SHEET COLUMN CARRIES, defined once.
 *
 * ## Why this file exists (2026-09-04, Owner: "no inconsistencies or any differences in the UI at all")
 *
 * Master and the channel scopes built their column definitions separately, and a three-scope
 * measurement (master·DE, Amazon·IT, eBay·IT) found the channels missing SIX things master had:
 * the validation tint on cells, the validation-first tooltip, right-aligned tabular numbers, the
 * long-text renderer with its length counter, the floating filter row (a 57px header on master
 * against 29px on the channels), and the footer keyboard hint. Not one was a design decision —
 * each was a piece written into `master/columns.tsx` that the channel never received, because
 * there was no single place to receive it from.
 *
 * So the pieces live here, and BOTH sheets call them. A sheet cannot drift from a rule it does not
 * own a copy of.
 *
 * 🔴 Pure `.ts` on purpose. `sheet.ts` is reachable from node tests through
 * `renderers/longTextState.ts`, and this module is tested the same way; nothing here may import a
 * `.tsx` or the AG runtime. The filter helper — which needs `gridFilterDef` from a `.tsx` — lives
 * in `filters/sheetFilterFor.ts` for exactly that reason.
 */
import type { CellClassRules } from 'ag-grid-community'

import { lengthCapOf, lengthValidation, selectValidation, sheetClassRules, type SheetValidation } from './sheet'
import { shapeValidation, type CellShape } from '../renderers/shapeFormat'
import { isMatrixCellKind, matrixCoerceValue } from '../renderers/matrixCells'
import { parseScalarValue } from './scalarValue'

/** The column fields validation needs — the intersection of master's and the channel's `SheetColumn`. */
export interface SheetColumnLike {
  /**
   * The wire kinds (`text · longtext · number · select · boolean`), VT.2's `variationTheme`, and —
   * MX.G, 2026-09-13 — the eight Matrix kinds (`listing · fulfilment · syncMode · syncQty ·
   * syncBuffer · syncState · price · salePrice`, `matrix/contract.ts`), which `sheetValidationFor`
   * routes to `matrixValidation` below. Kept a `string` so a kind that starts arriving cannot arrive
   * without a declared branch failing closed to the length rule.
   */
  kind: string
  options?: string[]
  mode?: 'strict' | 'open'
  requiredBy: string[]
  maxLength?: number | null
  maxBytes?: number | null
  capFrom?: string | null
  /** AM.1 — non-scalar cells. Absent = scalar. `'axes'` is VT.2's projection — see `shapeColumn.ts`. */
  shape?: CellShape | 'axes'
  cardinality?: { min: number; max: number | null }
  unitOptions?: string[]
}

/**
 * The validation a column carries, GATED by whether the column applies to the row at all.
 *
 * 🔴 The gate is the part the channel was missing. A column that does not apply to a row (a
 * per-variant field on the parent, a field another product type owns) has nothing to be wrong
 * about, and validating it anyway paints `⚠ required` on cells the operator cannot fill. Master's
 * `columns.tsx` had this composition inline; the channel had no validation at all, so its cells
 * never showed the invalid tint, the corner triangle or the length warnings master's did.
 *
 * `applies` is the caller's — master answers it through `validationApplies`, the channel through
 * `columnApplies` — because the two row shapes are not the same object and this module knows
 * neither. What it guarantees is that both scopes gate the SAME validation the SAME way.
 */
export function sheetValidationFor<T>(col: SheetColumnLike, applies: (row: T) => boolean): SheetValidation<T> {
  const required = col.requiredBy.length > 0
  /**
   * 🔴 VT.2 — a variation-theme cell has NO cell-level validation, and the reason is not "nothing to
   * check". Its value is an object, so the default branch below would reach `lengthValidation`, which
   * measures `String(value).length` — i.e. the length of `[object Object]`, 15 characters, on every
   * row of every scope. The facts that CAN be wrong about a projection (no theme resolves, an axis
   * binds to nothing, two variants collide) are per-COORDINATE and are served as readiness items
   * (contract §4) with server-stated sentences, because only the server can know them.
   */
  if (col.kind === 'variationTheme' || col.shape === 'axes') {
    return { validate: () => ({ level: null }) }
  }
  /* MX.G — the Matrix kinds carry their own validation; the facts carry none. */
  if (isMatrixCellKind(col.kind)) return matrixValidation<T>(col, required, applies)
  const base: SheetValidation<T> =
    col.shape === 'list' || col.shape === 'measure'
      ? /* AM.1: an array or a {value, unit} — length rules would read `String(array).length`. */
        shapeValidation<T>(col, required)
      : col.kind === 'select'
      ? selectValidation<T>(col.options ?? [], col.mode ?? 'open', required)
      : col.kind === 'boolean'
      ? { validate: v => {
          const value = parseScalarValue(col, v)
          if (value === null) return required ? { level: 'error', message: 'Required' } : { level: null }
          return typeof value === 'boolean' ? { level: null } : { level: 'error', message: 'Choose Yes or No' }
        } }
      : /* No invented cap: an absent `maxLength` on the wire means UNCAPPED (BE-10). */
        lengthValidation<T>(lengthCapOf(col), required)
  return {
    validate: (v, d, key) => (applies(d) ? base.validate(v, d, key) : { level: null }),
  }
}

/**
 * MX.G — what can be WRONG about a Matrix cell's typed value, per kind.
 *
 * `syncQty` / `syncBuffer`: a whole number, zero or more. `price`: zero or more. `syncMode`: the
 * closed pair. `fulfilment`: the coordinate's own vocabulary (strict when the column declares it,
 * open when it does not — the server refuses the rest). `listing`, `syncState` and `salePrice`
 * carry none: the first two are facts, and a sale's only rule (a price ≥ 0) is applied by the
 * coercion the setter and the writer both run, so a wrong compound never lands in the row.
 *
 * Every sentence names the RULE, not the word "invalid" — an operator cutting a value to fit needs
 * to know what would fit.
 */
function matrixValidation<T>(col: SheetColumnLike, required: boolean, applies: (row: T) => boolean): SheetValidation<T> {
  const blank = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '')
  const numberRule = (kind: 'syncQty' | 'syncBuffer' | 'price', message: string): SheetValidation<T> => ({
    validate: (v) => {
      if (blank(v)) return required ? { level: 'error', message: 'Required' } : { level: null }
      return matrixCoerceValue(kind, v) === undefined ? { level: 'error', message } : { level: null }
    },
  })
  const base: SheetValidation<T> =
    col.kind === 'syncQty' ? numberRule('syncQty', 'A quantity is a whole number, zero or more')
    : col.kind === 'syncBuffer' ? numberRule('syncBuffer', 'A buffer is a whole number, zero or more')
    : col.kind === 'price' ? numberRule('price', 'A price is zero or more')
    : col.kind === 'syncMode' ? selectValidation<T>(['FOLLOW', 'PINNED'], 'strict', required)
    : col.kind === 'fulfilment' ? selectValidation<T>(col.options ?? [], col.options?.length ? 'strict' : 'open', required)
    : { validate: () => ({ level: null }) }
  return { validate: (v, d, key) => (applies(d) ? base.validate(v, d, key) : { level: null }) }
}

/**
 * The cell class rules a sheet column carries, in THE order.
 *
 * 🔴 ORDER IS BEHAVIOUR when two rule sets share a key: the later spread wins silently. Master
 * spread `sheet → provenance → round-trip` and the channel spread `round-trip → … → provenance`,
 * and a key present in two sets therefore resolved differently per scope — `nds-cell-is-refused`
 * did exactly that on 2026-09-04 and cost an afternoon. The sets are now asserted disjoint
 * (`classRuleKeys.vitest.test.ts`), so the order no longer decides anything — and it is still
 * fixed here, once, so that it never can again.
 */
export function composeSheetCellClassRules<T>(parts: {
  validation: SheetValidation<T>
  provenance: CellClassRules<T>
  roundTrip: CellClassRules<T>
  /** Sheet-specific rules (the chip hit, editable/locked on the channel). Never a provenance or
   *  validation key — the disjointness test would catch a collision with those, but not with
   *  these, so name them distinctly. */
  extra?: CellClassRules<T>
}): CellClassRules<T> {
  return {
    ...sheetClassRules<T>(parts.validation),
    ...parts.provenance,
    ...parts.roundTrip,
    ...(parts.extra ?? {}),
  }
}

/**
 * The footer's keyboard hint — the sheet's editing model in one line, the SAME line on every
 * scope. It was a literal inside master's JSX and the channels had none.
 */
export const SHEET_SHORTCUT_HINT = 'Enter to edit · Enter again to save · ↓↑ to move · Tab → · drag the corner to fill · ⌘Z'
