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
  validation?: Record<string, unknown>
  /** Effective Master template facts, keyed by the row's assigned family. */
  familyRules?: Record<string, { required: boolean; sortOrder: number }>
  slot?: { index: number }
  channels?: Record<string, { requirement?: string; byCategory?: Record<string, {
    requirement: string
    maxLength?: number
    maxBytes?: number
    options?: string[]
    mode?: 'strict' | 'open'
    cardinality: { min: number; max: number | null }
  }> }>
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
  values?: Record<string, unknown>
  familyId?: string | null
  isParent: boolean
  productType: string | null
}

/** Dictionary conditions use canonical option codes and preserve explicit false and zero. */
export function dictionaryCondition(condition: unknown, values: Record<string, unknown> = {}): boolean {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return false
  const rule = condition as { field?: unknown; equals?: unknown; in?: unknown[] }
  if (typeof rule.field !== 'string') return false
  const key = rule.field.replace(/^attr_/, '')
  const raw = values[key] ?? values[`attr_${key}`]
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw ? (raw as { value: unknown }).value : raw
  return Array.isArray(rule.in) ? rule.in.some(v => JSON.stringify(v) === JSON.stringify(value))
    : Object.prototype.hasOwnProperty.call(rule, 'equals') && JSON.stringify(rule.equals) === JSON.stringify(value)
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
  if (column.familyRules && !column.familyRules[row.familyId ?? '']) return false
  if (column.slot) {
    for (const coordinate of Object.values(column.channels ?? {})) {
      const max = coordinate.byCategory?.[row.productType ?? '']?.cardinality.max
      if (max != null && column.slot.index > max) return false
    }
  }
  return matchesType(column.applicableProductTypes, row.productType)
}

/**
 * Does `coordinate` require this column ON THIS ROW? Required-ness is per coordinate AND per product
 * type; collapsing either one makes the sheet demand fields a channel never asked for.
 */
export function columnRequiredHere(column: SheetColumnRule, coordinateLabel: string, productType: string | null, familyId?: string | null, values?: Record<string, unknown>): boolean {
  if (coordinateLabel === 'Master' && column.familyRules?.[familyId ?? ''] && dictionaryCondition(column.validation?.requiredWhen, values)) return true
  if (coordinateLabel === 'Master' && column.familyRules) return column.requiredBy.includes('Master') && column.familyRules[familyId ?? '']?.required === true
  const category = column.channels?.[coordinateLabel]?.byCategory?.[productType ?? '']
  if (category) return category.requirement === 'required' && column.requiredBy.includes(coordinateLabel)
  if (!column.requiredBy.includes(coordinateLabel)) return false
  return matchesType(column.requiredForProductTypes, productType)
}

/** Project a union header onto the selected row's category before editing or validating. */
export function columnForCategory<T extends SheetColumnRule>(column: T, coordinate: string, category: string | null): T {
  const facts = column.channels?.[coordinate]?.byCategory?.[category ?? '']
  if (!facts) return column
  return {
    ...column, maxLength: facts.maxLength, maxBytes: facts.maxBytes,
    options: facts.options, mode: facts.mode,
    requiredBy: columnRequiredHere(column, coordinate, category) ? [coordinate] : [],
    ...('cardinality' in column && column.cardinality ? { cardinality: facts.cardinality } : {}),
    channels: { ...column.channels, [coordinate]: facts },
  } as T
}

/** Required by ANY coordinate on this row — what the cell's `⚠ required` placeholder reads. */
export function columnRequiredByAny(column: SheetColumnRule, row: SheetRowRule): boolean {
  if (!columnApplies(column, row)) return false
  return (column.familyRules?.[row.familyId ?? ''] && dictionaryCondition(column.validation?.requiredWhen, row.values)) === true || column.requiredBy.some((label) => columnRequiredHere(column, label, row.productType, row.familyId, row.values))
}
/** Product relationships belong to the shared catalog, independently of listing aliases. */
export type ProductRole = 'standalone' | 'parent' | 'child'
export const PRODUCT_ROLE_LABELS: Record<ProductRole, string> = {
  standalone: 'Standalone', parent: 'Parent', child: 'Child',
}

export function productRoleOf(product: { parentId?: string | null; isParent?: boolean; childCount?: number }): ProductRole {
  if (product.parentId) return 'child'
  return product.isParent || (product.childCount ?? 0) > 0 ? 'parent' : 'standalone'
}

// Reserved presentation keys cannot collide with a family attribute or marketplace field.
export const PRODUCT_ROLE_COLUMN = '__productRole'
export const PARENT_SKU_COLUMN = '__parentSku'
export const isProductRelationshipColumn = (key: string) => key === PRODUCT_ROLE_COLUMN || key === PARENT_SKU_COLUMN
