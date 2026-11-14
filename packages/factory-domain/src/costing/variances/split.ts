import type { Decimal } from 'decimal.js'
import { fromMinorUnits, toMinorUnits } from '../../core/money'
import { COST_SCALE, decimalOf, decimalText, QUANTITY_SCALE, roundTo } from '../../product/units/units'
import type { CostEntryKind } from '../ledger/entries'
import type { ExactParts } from '../ledger/variance'

/**
 * The variance split of a work order's close (B-W2b-411; FIN-029, FIN-030, FIN-034; design production.workorders "Labour &
 * cost" › "Cost" (variance at close), finance.costing's bridge), pure. At the close, what is left on the work order's cost
 * ledger (its entries add up to the balance: actual in, the garments' value out to stock) is explained by category against
 * the standard of the garments made good (a flexible standard: the frozen standard of each cell's finished item × the
 * garments it made; without one for every cell, the estimate at release in proportion to the garments made). Each category
 * is worked out exactly and rounded once; what the split does not explain (hand adjustments, the value moved to stock
 * against the standard of the garments made, a cent of rounding) is the closing entry's (factory-db WorkOrderCostEntry
 * CLOSE: after it the work order's entries add up to 0).
 *
 *   MATERIAL_PRICE     per material: each issue at what it cost against its standard unit cost
 *   MATERIAL_USAGE     per material: the base quantity used for the good garments (issued less returned, less the leather
 *                      of scrapped garments) against the work order's frozen need for the garments made, at standard; and
 *                      one line without a material: the standard's material against the work order's own material list
 *   SCRAP              per material: the leather of garments scrapped at an operation or in a rework (at standard) and
 *                      material scrapped from stock for the work order (at its stock value)
 *   LABOUR_EFFICIENCY  the standard minutes earned on the work order (scans, unplanned operations and garments later
 *                      scrapped included) against the standard minutes of the garments made, at the standard's cost per
 *                      minute: work-order totals, never a person's
 *   LABOUR_RATE        what the minutes earned cost against the standard's cost per minute (the rest of labour)
 *   SUBCONTRACT_PRICE  the workshops' fees against the standard subcontract cost of the garments made
 *   OVERHEAD           overhead applied against the standard overhead of the garments made
 *   REWORK, LOT_SIZE   not split from the ledger today (NOT_SPLIT below): rework time is not costed on a work order (its
 *                      labour comes from the floor's scans; FIN-029's read prices its minutes apart), and neither the
 *                      standard nor the work order carries a set-up time to spread over a lot
 * Amounts are minor units of the company's currency: above 0 the work order cost more than its standard (unfavourable).
 * A line of 0 is left out (the database refuses one). UNVERIFIED (GATE-ACCOUNTANT): the categories, the flexible standard
 * and what the closing entry takes are the build's reading until the accountant confirms them.
 */

export const VARIANCE_CATEGORIES = ['MATERIAL_PRICE', 'MATERIAL_USAGE', 'LABOUR_EFFICIENCY', 'LABOUR_RATE', 'SCRAP', 'REWORK', 'SUBCONTRACT_PRICE', 'LOT_SIZE', 'OVERHEAD'] as const
export type VarianceCategory = (typeof VARIANCE_CATEGORIES)[number]

/** The categories in words (the API's; the screens keep their own it/en words by code). */
export const VARIANCE_CATEGORY_WORDS: Readonly<Record<VarianceCategory, string>> = Object.freeze({
  MATERIAL_PRICE: 'Material price: what the material cost against its standard price.',
  MATERIAL_USAGE: 'Material usage (yield): more or less material used than the standard for the garments made.',
  LABOUR_EFFICIENCY: 'Labour efficiency: standard minutes earned against the standard minutes of the garments made.',
  LABOUR_RATE: 'Labour rate: what the minutes cost against the standard cost per minute.',
  SCRAP: 'Scrap: the material of scrapped garments, and material scrapped from stock for the work order.',
  REWORK: 'Rework: what rework cost on the work order.',
  SUBCONTRACT_PRICE: "Subcontract price: the workshops' fees against the standard subcontract cost.",
  LOT_SIZE: 'Lot size: set-up spread over fewer (or more) garments than the standard lot.',
  OVERHEAD: 'Overhead: overhead applied against the standard overhead.',
})

/** Why a category gives no line from the ledger today, as `notSplit[].code`. */
export const NOT_SPLIT_CODES = ['NOT_ON_LEDGER', 'NO_SET_UP', 'NO_BASIS'] as const
export type NotSplitCode = (typeof NOT_SPLIT_CODES)[number]

/** The categories the ledger cannot give today, with their words. */
export const NOT_SPLIT: readonly { readonly category: VarianceCategory; readonly code: NotSplitCode; readonly words: string }[] = Object.freeze([
  {
    category: 'REWORK',
    code: 'NOT_ON_LEDGER',
    words: "Rework is not split: rework time is not costed on the work order (its labour comes from the floor's scans). Its minutes are priced apart in Scrap and rework cost.",
  },
  {
    category: 'LOT_SIZE',
    code: 'NO_SET_UP',
    words: "Lot size is not split: neither the standard nor the work order carries a set-up time to spread over a lot (the routing's set-up minutes are for planning).",
  },
])

/** The words when nothing is compared (no standard for every garment and no complete estimate). */
export const NO_BASIS_WORDS =
  'No frozen standard for every garment and no complete estimate at release: nothing is split, and the closing entry takes off everything left on the work order.'

/** An entry of the work order's ledger as the split reads it (the cost read's facts; reversals included). */
export interface SplitEntry {
  readonly kind: CostEntryKind
  readonly amount: number
  readonly itemId: string | null
  /** Base units, signed as the amount (4 places). */
  readonly quantity: string | null
  /** LABOUR: standard minutes earned, signed. */
  readonly minutes: string | null
  readonly unitCost: string | null
  /** The standard unit cost it is compared with (the entry's, or the frozen one of its day): null when none. */
  readonly standardUnitCost: string | null
  /** A SCRAP record of scrapped garments (amount 0), not a SCRAP move from stock. */
  readonly scrapRecord: boolean
}

export interface SplitFacts {
  readonly currency: string
  readonly basis: 'STANDARD' | 'ESTIMATE' | null
  /** The standard of the garments made good (exact, major units): `outputStandard`. Null without a basis. */
  readonly output: ExactParts | null
  readonly plannedGarments: number
  readonly madeGarments: number
  /** The work order's frozen need per material for the planned garments, and the price it is compared at (null: none). */
  readonly needs: readonly { readonly itemId: string; readonly baseQuantity: string; readonly unitCost: string | null }[]
  /** Standard minutes per garment of the routing (unplanned operations aside). */
  readonly minutesPerGarment: string
  readonly entries: readonly SplitEntry[]
}

/** One line of the split, as WorkOrderVariance keeps it. */
export interface VarianceLine {
  readonly category: VarianceCategory
  readonly itemId: string | null
  readonly standardQuantity: string | null
  readonly actualQuantity: string | null
  readonly standardUnitCost: string | null
  readonly actualUnitCost: string | null
  /** Minor units, never 0. */
  readonly amount: number
  readonly note: string | null
}

export interface Split {
  readonly basis: 'STANDARD' | 'ESTIMATE' | null
  readonly lines: readonly VarianceLine[]
  /** Σ the entries before the close: what is left on the work order. */
  readonly balance: number
  /** Σ the lines. */
  readonly explained: number
  /** The closing entry: what is left after the lines' variance entries, taken off (balance − explained, negated). */
  readonly closing: number
  readonly notSplit: readonly { readonly category: VarianceCategory | null; readonly code: NotSplitCode; readonly words: string }[]
}

const ZERO = (): Decimal => decimalOf('0')
const quantityText = (value: Decimal): string => decimalText(roundTo(value, { scale: QUANTITY_SCALE, rounding: 'HALF_UP' }))
const costText = (value: Decimal): string => decimalText(roundTo(value, { scale: COST_SCALE, rounding: 'HALF_UP' }))
const nonNegative = (value: Decimal | null): value is Decimal => value !== null && !value.isNegative()

/**
 * The standard of the garments made good: STANDARD Σ each cell's garments made × its frozen standard per garment;
 * ESTIMATE the estimate at release × made ÷ planned. Null without a basis (or with no garments planned for an estimate).
 */
export function outputStandard(
  basis: 'STANDARD' | 'ESTIMATE' | null,
  cells: readonly { readonly made: number; readonly standard: { readonly materialCost: string; readonly labourCost: string; readonly subcontractCost: string; readonly overheadCost: string } | null }[],
  estimate: ExactParts | null,
  plannedGarments: number,
  madeGarments: number,
): ExactParts | null {
  if (basis === 'STANDARD') {
    if (cells.some((cell) => cell.standard === null)) return null
    return cells.reduce<ExactParts>(
      (sum, cell) => ({
        material: sum.material.plus(decimalOf(cell.standard!.materialCost).times(cell.made)),
        labour: sum.labour.plus(decimalOf(cell.standard!.labourCost).times(cell.made)),
        subcontract: sum.subcontract.plus(decimalOf(cell.standard!.subcontractCost).times(cell.made)),
        overhead: sum.overhead.plus(decimalOf(cell.standard!.overheadCost).times(cell.made)),
      }),
      { material: ZERO(), labour: ZERO(), subcontract: ZERO(), overhead: ZERO() },
    )
  }
  if (basis === 'ESTIMATE' && estimate !== null && plannedGarments > 0) {
    const share = (part: Decimal) => part.times(madeGarments).div(plannedGarments)
    return { material: share(estimate.material), labour: share(estimate.labour), subcontract: share(estimate.subcontract), overhead: share(estimate.overhead) }
  }
  return null
}

interface MaterialFacts {
  /** Σ base quantity of MATERIAL entries (issued less returned). */
  issued: Decimal
  /** Σ their amounts, major units. */
  cost: Decimal
  /** The first standard unit cost an entry names. */
  standard: Decimal | null
  /** Σ base quantity × the unit cost each issue is compared with. */
  atStandard: Decimal
  /** Scrap records: base quantity and its value at standard. */
  scrapQuantity: Decimal
  scrapValue: Decimal
  /** SCRAP from stock: base quantity and value (major units). */
  stockQuantity: Decimal
  stockValue: Decimal
}

/** The split of a close (see the file's header). */
export function splitVariances(facts: SplitFacts): Split {
  const { currency } = facts
  const major = (minor: number): Decimal => fromMinorUnits(minor, currency)
  const minor = (value: Decimal): number => {
    const rounded = toMinorUnits(value.toFixed(), currency)
    return rounded === 0 ? 0 : rounded
  }
  const balance = facts.entries.reduce((sum, entry) => sum + entry.amount, 0)
  if (facts.basis === null || facts.output === null) {
    return { basis: null, lines: [], balance, explained: 0, closing: balance === 0 ? 0 : -balance, notSplit: [{ category: null, code: 'NO_BASIS', words: NO_BASIS_WORDS }] }
  }
  const output = facts.output
  const lines: VarianceLine[] = []
  const add = (line: Omit<VarianceLine, 'amount'> & { readonly amount: number }) => {
    if (line.amount !== 0) lines.push(line)
  }
  const sumOf = (kinds: readonly CostEntryKind[], filter: (entry: SplitEntry) => boolean = () => true) =>
    facts.entries.filter((entry) => kinds.includes(entry.kind) && filter(entry)).reduce((sum, entry) => sum + entry.amount, 0)

  // ---- material, per item ---------------------------------------------------------------------------------------------
  const needOf = new Map(facts.needs.map((need) => [need.itemId, need]))
  const items = new Map<string, MaterialFacts>()
  const factsOf = (itemId: string): MaterialFacts => {
    let row = items.get(itemId)
    if (!row) {
      row = { issued: ZERO(), cost: ZERO(), standard: null, atStandard: ZERO(), scrapQuantity: ZERO(), scrapValue: ZERO(), stockQuantity: ZERO(), stockValue: ZERO() }
      items.set(itemId, row)
    }
    return row
  }
  for (const need of facts.needs) factsOf(need.itemId)
  const material = facts.entries.filter((entry) => entry.itemId !== null && (entry.kind === 'MATERIAL' || entry.kind === 'SCRAP'))
  for (const entry of material) {
    const row = factsOf(entry.itemId!)
    if (row.standard === null && entry.standardUnitCost !== null) row.standard = decimalOf(entry.standardUnitCost)
    if (entry.kind === 'MATERIAL' && entry.quantity !== null) {
      row.issued = row.issued.plus(decimalOf(entry.quantity))
      row.cost = row.cost.plus(major(entry.amount))
    }
  }
  // The unit cost each material is compared at: the first standard an entry names, else the need's price, else (no standard
  // anywhere) what it cost, so it has no price variance.
  const unitOf = new Map<string, Decimal | null>()
  for (const [itemId, row] of items) {
    const price = needOf.get(itemId)?.unitCost ?? null
    unitOf.set(itemId, row.standard ?? (price !== null ? decimalOf(price) : row.issued.isZero() ? null : row.cost.div(row.issued)))
  }
  for (const entry of material) {
    const row = factsOf(entry.itemId!)
    const unit = unitOf.get(entry.itemId!) ?? null
    const quantity = entry.quantity === null ? null : decimalOf(entry.quantity)
    if (entry.kind === 'MATERIAL' && quantity !== null) {
      const standard = entry.standardUnitCost !== null ? decimalOf(entry.standardUnitCost) : unit
      row.atStandard = row.atStandard.plus(standard === null ? major(entry.amount) : quantity.times(standard))
    } else if (entry.kind === 'SCRAP' && entry.scrapRecord && quantity !== null) {
      const standard = entry.standardUnitCost !== null ? decimalOf(entry.standardUnitCost) : (unit ?? (entry.unitCost !== null ? decimalOf(entry.unitCost) : null))
      row.scrapQuantity = row.scrapQuantity.plus(quantity)
      if (standard !== null) row.scrapValue = row.scrapValue.plus(quantity.times(standard))
    } else if (entry.kind === 'SCRAP' && !entry.scrapRecord) {
      if (quantity !== null) row.stockQuantity = row.stockQuantity.plus(quantity)
      row.stockValue = row.stockValue.plus(major(entry.amount))
    }
  }
  const share = facts.plannedGarments > 0 ? decimalOf(String(facts.madeGarments)).div(facts.plannedGarments) : ZERO()
  let materialLines = 0
  for (const [itemId, row] of [...items.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const unit = unitOf.get(itemId) ?? null
    const issued = row.issued.gt(0)
    // Price: each issue at what it cost against the unit cost it is compared with.
    const price = minor(row.cost.minus(row.atStandard))
    add({
      category: 'MATERIAL_PRICE',
      itemId,
      standardQuantity: issued ? quantityText(row.issued) : null,
      actualQuantity: issued ? quantityText(row.issued) : null,
      standardUnitCost: issued ? costText(row.atStandard.div(row.issued)) : null,
      actualUnitCost: issued ? costText(row.cost.div(row.issued)) : null,
      amount: price,
      note: null,
    })
    // Scrap: the leather of scrapped garments at standard, and material scrapped from stock at its value.
    const scrapExact = row.scrapValue.plus(row.stockValue)
    const scrapped = row.scrapQuantity.plus(row.stockQuantity)
    const scrap = minor(scrapExact)
    add({
      category: 'SCRAP',
      itemId,
      standardQuantity: scrapped.gt(0) ? '0' : null,
      actualQuantity: scrapped.gt(0) ? quantityText(scrapped) : null,
      standardUnitCost: scrapped.gt(0) ? costText(unit ?? scrapExact.div(scrapped)) : null,
      actualUnitCost: scrapped.gt(0) ? costText(scrapExact.div(scrapped)) : null,
      amount: scrap,
      note: null,
    })
    // Usage: issued for the good garments (less the leather of the scrapped ones) against the need of the garments made.
    const need = needOf.get(itemId)
    const standardQuantity = need ? decimalOf(need.baseQuantity).times(share) : ZERO()
    const used = row.issued.minus(row.scrapQuantity)
    const usage = minor(row.atStandard.minus(row.scrapValue).minus(unit === null ? ZERO() : standardQuantity.times(unit)))
    const paired = unit !== null && nonNegative(standardQuantity) && nonNegative(used) && (standardQuantity.gt(0) || used.gt(0))
    add({
      category: 'MATERIAL_USAGE',
      itemId,
      standardQuantity: paired ? quantityText(standardQuantity) : null,
      actualQuantity: paired ? quantityText(used) : null,
      standardUnitCost: paired ? costText(unit) : null,
      actualUnitCost: paired ? costText(unit) : null,
      amount: usage,
      note: null,
    })
    materialLines += price + scrap + usage
  }
  // The material variance exactly, rounded once; the line without a material takes the standard's material against the
  // work order's own list (and the cents of rounding the lines by material left).
  const materialActual = sumOf(['MATERIAL']) + sumOf(['SCRAP'], (entry) => !entry.scrapRecord)
  const materialVariance = minor(major(materialActual).minus(output.material))
  add({
    category: 'MATERIAL_USAGE',
    itemId: null,
    standardQuantity: null,
    actualQuantity: null,
    standardUnitCost: null,
    actualUnitCost: null,
    amount: materialVariance - materialLines,
    note: "The standard's material against the work order's own material list, and the rounding of the lines by material.",
  })

  // ---- labour ---------------------------------------------------------------------------------------------------------
  const labourActual = major(sumOf(['LABOUR']))
  const earned = facts.entries.filter((entry) => entry.kind === 'LABOUR' && entry.minutes !== null).reduce((sum, entry) => sum.plus(decimalOf(entry.minutes!)), ZERO())
  const standardMinutes = decimalOf(facts.minutesPerGarment).times(facts.madeGarments)
  const labourVariance = minor(labourActual.minus(output.labour))
  if (standardMinutes.gt(0)) {
    const perMinute = output.labour.div(standardMinutes)
    const efficiency = minor(earned.minus(standardMinutes).times(perMinute))
    add({
      category: 'LABOUR_EFFICIENCY',
      itemId: null,
      standardQuantity: quantityText(standardMinutes),
      actualQuantity: nonNegative(earned) ? quantityText(earned) : null,
      standardUnitCost: costText(perMinute),
      actualUnitCost: nonNegative(earned) ? costText(perMinute) : null,
      amount: efficiency,
      note: null,
    })
    add({
      category: 'LABOUR_RATE',
      itemId: null,
      standardQuantity: earned.gt(0) ? quantityText(earned) : null,
      actualQuantity: earned.gt(0) ? quantityText(earned) : null,
      standardUnitCost: earned.gt(0) ? costText(perMinute) : null,
      actualUnitCost: earned.gt(0) ? costText(labourActual.div(earned)) : null,
      amount: labourVariance - efficiency,
      note: null,
    })
  } else {
    add({ category: 'LABOUR_EFFICIENCY', itemId: null, standardQuantity: null, actualQuantity: null, standardUnitCost: null, actualUnitCost: null, amount: labourVariance, note: 'The routing has no standard minutes for the garments made: all labour is against the standard.' })
  }

  // ---- subcontract and overhead, per garment made ------------------------------------------------------------------
  const perGarmentLine = (category: 'SUBCONTRACT_PRICE' | 'OVERHEAD', actual: Decimal, standard: Decimal) => {
    const made = facts.madeGarments
    const paired = made > 0 && !standard.isNegative() && !actual.isNegative()
    add({
      category,
      itemId: null,
      standardQuantity: paired ? String(made) : null,
      actualQuantity: paired ? String(made) : null,
      standardUnitCost: paired ? costText(standard.div(made)) : null,
      actualUnitCost: paired ? costText(actual.div(made)) : null,
      amount: minor(actual.minus(standard)),
      note: null,
    })
  }
  perGarmentLine('SUBCONTRACT_PRICE', major(sumOf(['SUBCONTRACT'])), output.subcontract)
  perGarmentLine('OVERHEAD', major(sumOf(['OVERHEAD'])), output.overhead)

  const explained = lines.reduce((sum, line) => sum + line.amount, 0)
  const closing = explained - balance
  return { basis: facts.basis, lines, balance, explained, closing: closing === 0 ? 0 : closing, notSplit: NOT_SPLIT }
}
