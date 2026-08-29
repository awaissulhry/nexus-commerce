/**
 * The MASTER SHEET's applicability rules — the one place that decides whether a column applies to a
 * row, and whether a channel requires it there.
 *
 * `docs/2026-08-29-master-sheet-design.md`. These live in `packages/shared` because BOTH sides need
 * the same answer and a disagreement is invisible: the API uses them to compute readiness, and the
 * sheet uses them to decide whether a cell is editable, locked, or flagged `⚠ required`. If the two
 * ever drift, the grid tells the operator a cell is required while the server's verdict says it is
 * not applicable — the cell and the readiness pill contradict each other and neither can be trusted.
 * They were duplicated in both apps for exactly one commit; this is that fork closed.
 *
 * Pure, dependency-free, and tested beside this file.
 */

/** The minimal column shape the rules need — both apps' fuller `SheetColumn` satisfies it. */
export interface SheetColumnRule {
  /**
   * `global` lives on the parent and every variation inherits it; `per_variant` belongs to each
   * variation and is LOCKED on the parent row (a parent has no colour, size or EAN of its own).
   */
  scope: 'global' | 'per_variant'
  /** Product types that define this column. Empty/absent = every type. */
  applicableProductTypes?: string[]
  /** Coordinates that require it, by label (`Amazon · IT`). */
  requiredBy: string[]
  /** Types for which it is required — a union sheet must not demand a COAT field from a GLOVE. */
  requiredForProductTypes?: string[]
}

/** The minimal row shape the rules need. */
export interface SheetRowRule {
  isParent: boolean
  productType: string | null
}

const matchesType = (types: string[] | undefined, productType: string | null): boolean => {
  if (!types || types.length === 0) return true
  const pt = (productType ?? '').toUpperCase()
  return !!pt && types.some((t) => t.toUpperCase() === pt)
}

/**
 * Does this column apply to this row at all? A cell that does not apply is LOCKED — never empty and
 * flagged, which would tell an operator to fill something the row cannot hold.
 */
export function columnApplies(column: SheetColumnRule, row: SheetRowRule): boolean {
  if (row.isParent && column.scope === 'per_variant') return false
  return matchesType(column.applicableProductTypes, row.productType)
}

/**
 * Does `coordinate` require this column ON THIS ROW? Required-ness is per coordinate AND per product
 * type; collapsing either one makes the sheet demand fields a channel never asked for.
 */
export function columnRequiredHere(column: SheetColumnRule, coordinateLabel: string, productType: string | null): boolean {
  if (!column.requiredBy.includes(coordinateLabel)) return false
  return matchesType(column.requiredForProductTypes, productType)
}

/** Required by ANY coordinate on this row — what the cell's `⚠ required` placeholder reads. */
export function columnRequiredByAny(column: SheetColumnRule, row: SheetRowRule): boolean {
  if (!columnApplies(column, row)) return false
  return column.requiredBy.some((label) => columnRequiredHere(column, label, row.productType))
}
