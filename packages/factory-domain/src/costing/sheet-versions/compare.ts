import { Decimal } from 'decimal.js'
import type { Uom } from '../../product/units/units'
import { SHEET_CATEGORIES, type LineSource, type SheetCategory } from '../sheet-components/components'
import type { SizeSplit } from '../sheet-components/split'
import { six } from '../sheet-components/rules'

/**
 * Two cost sheet versions side by side (B-W2b-420; FIN-014 "compare two side by side"; design style.cost.versions "Compare two
 * versions", VersionCompare), pure: line by line (a line is the same line in both when its category, where it came from, its
 * source record or words and its size agree), and per size and category. A difference is the second's figure minus the
 * first's; a line in one version only counts 0 in the other.
 */

export interface CompareLine {
  readonly category: SheetCategory
  readonly source: LineSource
  readonly sourceRecordId: string | null
  readonly itemId: string | null
  readonly label: string | null
  readonly size: string | null
  readonly quantity: string
  readonly uom: Uom | null
  readonly unitCost: string
  readonly cost: string
  readonly pct: string | null
}

export const LINE_CHANGES = ['SAME', 'CHANGED', 'ADDED', 'REMOVED'] as const
export type LineChange = (typeof LINE_CHANGES)[number]

export interface CompareSide {
  readonly quantity: string
  readonly uom: Uom | null
  readonly unitCost: string
  readonly cost: string
  readonly pct: string | null
}

export interface CompareRow {
  readonly key: string
  readonly category: SheetCategory
  readonly label: string | null
  readonly size: string | null
  readonly a: CompareSide | null
  readonly b: CompareSide | null
  readonly difference: string
  readonly change: LineChange
}

const keyOf = (line: CompareLine): string => [line.category, line.source, line.sourceRecordId ?? '', line.itemId ?? '', line.label ?? '', line.size ?? '*'].join('|')

/** Keys made unique by their place among the lines that share them. */
function keyed(lines: readonly CompareLine[]): Map<string, CompareLine> {
  const seen = new Map<string, number>()
  const out = new Map<string, CompareLine>()
  for (const line of lines) {
    const key = keyOf(line)
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    out.set(n === 1 ? key : `${key}#${n}`, line)
  }
  return out
}

const sideOf = (line: CompareLine): CompareSide => ({ quantity: line.quantity, uom: line.uom, unitCost: line.unitCost, cost: line.cost, pct: line.pct })

/** The lines of two versions matched: the first's order, then what only the second has. */
export function compareLines(a: readonly CompareLine[], b: readonly CompareLine[]): CompareRow[] {
  const left = keyed(a)
  const right = keyed(b)
  const keys = [...left.keys(), ...[...right.keys()].filter((key) => !left.has(key))]
  return keys.map((key) => {
    const one = left.get(key) ?? null
    const two = right.get(key) ?? null
    const line = (one ?? two)!
    const difference = six(new Decimal(two?.cost ?? 0).minus(one?.cost ?? 0))
    const change: LineChange =
      one === null ? 'ADDED' : two === null ? 'REMOVED' : one.quantity === two.quantity && one.unitCost === two.unitCost && one.cost === two.cost && one.pct === two.pct && one.uom === two.uom ? 'SAME' : 'CHANGED'
    return { key, category: line.category, label: line.label, size: line.size, a: one ? sideOf(one) : null, b: two ? sideOf(two) : null, difference, change }
  })
}

export interface CompareCell {
  readonly a: string | null
  readonly b: string | null
  readonly difference: string | null
}

export interface SizeCompare {
  readonly size: string
  readonly total: CompareCell
  readonly categories: readonly ({ readonly category: SheetCategory } & CompareCell)[]
}

const cell = (a: string | null, b: string | null): CompareCell => ({ a, b, difference: a === null || b === null ? null : six(new Decimal(b).minus(a)) })

/** Each size of the range: the two totals (null while a version misses an input) and each category's amounts. */
export function compareSplits(a: readonly SizeSplit[], b: readonly SizeSplit[], sizes: readonly string[]): SizeCompare[] {
  return sizes.map((size) => {
    const one = a.find((entry) => entry.size === size) ?? null
    const two = b.find((entry) => entry.size === size) ?? null
    const amount = (split: SizeSplit | null, category: SheetCategory): string => split?.categories.find((entry) => entry.category === category)?.amount ?? '0'
    const categories = SHEET_CATEGORIES.filter((category) => [one, two].some((split) => split?.categories.some((entry) => entry.category === category))).map((category) => ({
      category,
      ...cell(amount(one, category), amount(two, category)),
    }))
    return { size, total: cell(one?.total ?? null, two?.total ?? null), categories }
  })
}
