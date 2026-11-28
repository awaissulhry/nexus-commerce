import { Decimal } from 'decimal.js'
import type { SheetCategory } from '../sheet-components/components'
import type { StandardParts } from '../standards/rules'

/**
 * owb-pd3 (S4; design plan § 5zh; S4 settle 9; plan § 5 I, R59) — the product's cost against its agreed prices, and Keep, pure:
 *
 *   margin       a share of the PRICE, never of the cost: (price − cost) ÷ price, one decimal
 *   flag         UNDER_COST below 0 · UNDER_TARGET below the target (SalesSettings.marginFloorPct) · OK
 *   floor price  the lowest price that keeps the target: cost ÷ (1 − target), up to the cent
 *   Keep         the cost now kept as the standard cost: refused when it is the kept one already (SAME_AS_KEPT), when the cost
 *                moved since the person read it (TOTAL_MOVED), when parts are missing (MISSING_PARTS), and when a standard was
 *                kept today already (KEPT_TODAY: a frozen standard runs from a day, two never start the same day)
 *   parts        a kept cost sheet's 9 categories in the 4 parts of a standard cost (factory-db StandardCost)
 *
 * EUR only (R58 a): an agreed price in another currency is listed without a cost. No database, no I/O.
 */

/** The currency every figure here is in. */
export const PRICE_AGAINST_COST_CURRENCY = 'EUR' as const
export const KEEP_REASON_MAX = 500

const dec = (value: string | number | Decimal): Decimal => new Decimal(value)
const cents = (value: Decimal): string => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)

/** The margin at a price, a share of the PRICE, one decimal ("40.6"); null without a price above 0 or a cost. */
export function marginPctOf(price: string, cost: string | null): string | null {
  if (cost === null) return null
  const p = dec(price)
  if (p.lte(0)) return null
  return p.minus(cost).dividedBy(p).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1)
}

export type PriceFlag = 'OK' | 'UNDER_TARGET' | 'UNDER_COST'

/** Against the target: under the cost, under the target, or keeps it; null without a margin. */
export function flagOf(marginPct: string | null, targetPct: string): PriceFlag | null {
  if (marginPct === null) return null
  const margin = dec(marginPct)
  if (margin.lt(0)) return 'UNDER_COST'
  return margin.lt(targetPct) ? 'UNDER_TARGET' : 'OK'
}

/** What a price earns over the cost, two decimals ("130.00", "-12.50"); null without a cost. */
export const earnedOf = (price: string, cost: string | null): string | null => (cost === null ? null : cents(dec(price).minus(cost)))

/** The lowest price that keeps the target margin, up to the cent (rounded up); null without a cost, or a target of 100 % or more. */
export function floorPriceOf(cost: string | null, targetPct: string): string | null {
  if (cost === null) return null
  const target = dec(targetPct)
  if (target.gte(100) || dec(cost).lte(0)) return null
  return dec(cost).dividedBy(dec(1).minus(target.dividedBy(100))).toDecimalPlaces(2, Decimal.ROUND_UP).toFixed(2)
}

/** Two amounts that are the same to the cent (the person reads the cost to the cent). */
export const sameCents = (a: string, b: string): boolean => cents(dec(a)) === cents(dec(b))

// ---- Keep ---------------------------------------------------------------------------------------------------------------

export const KEEP_REFUSALS = ['SAME_AS_KEPT', 'TOTAL_MOVED', 'MISSING_PARTS', 'KEPT_TODAY', 'NO_COST_GRAIN'] as const
export type KeepRefusal = (typeof KEEP_REFUSALS)[number]

export const KEEP_REFUSAL_WORDS: Readonly<Record<KeepRefusal, string>> = Object.freeze({
  SAME_AS_KEPT: 'This cost is kept already.',
  TOTAL_MOVED: 'The cost moved since you read it: look at the cost now again, then keep it.',
  MISSING_PARTS: 'Parts of the cost are missing: add them first, then keep the cost.',
  KEPT_TODAY: 'A standard cost of this product was kept today already: a new one can be kept from tomorrow.',
  NO_COST_GRAIN: 'Keeping a cost needs the cost right.',
})

/**
 * Why Keep is refused before anything is written, or null: the parts missing, the cost read by the person moved, the same as
 * the kept one. `total` is the live cost now (null while a part is missing).
 */
export function keepRefusalOf(input: { readonly total: string | null; readonly missing: number; readonly expectedTotal: string; readonly kept: string | null }): KeepRefusal | null {
  if (input.missing > 0 || input.total === null) return 'MISSING_PARTS'
  if (!sameCents(input.total, input.expectedTotal)) return 'TOTAL_MOVED'
  if (input.kept !== null && sameCents(input.total, input.kept)) return 'SAME_AS_KEPT'
  return null
}

/** Keep's reason as stored: trimmed; null when blank or too long (the command refuses it in words, 400). */
export function keepReasonOf(text: string): string | null {
  const reason = text.trim()
  return reason.length === 0 || reason.length > KEEP_REASON_MAX ? null : reason
}

// ---- the 9 categories in the 4 parts of a standard cost ------------------------------------------------------------------

/**
 * A kept sheet's category in a standard cost's parts: the materials with what lands on them (leather, the BOM's materials,
 * packaging, freight, duty) · the labour · the outside work · the overhead and the commission. The parts add up to the sheet's
 * total of the size, so the standard's unit cost is the cost that was kept.
 */
export const STANDARD_PART_OF: Readonly<Record<SheetCategory, keyof StandardParts>> = Object.freeze({
  MATERIAL: 'materialCost',
  LEATHER: 'materialCost',
  PACKAGING: 'materialCost',
  FREIGHT: 'materialCost',
  DUTY: 'materialCost',
  LABOUR: 'labourCost',
  SUBCONTRACT: 'subcontractCost',
  OVERHEAD: 'overheadCost',
  COMMISSION: 'overheadCost',
})

/** The parts of a size from a sheet's lines (every-size lines and the size's own), six decimals as a standard cost keeps them. */
export function standardPartsOf(lines: readonly { readonly category: SheetCategory; readonly size: string | null; readonly cost: string }[], size: string): StandardParts {
  const sums: Record<keyof StandardParts, Decimal> = { materialCost: dec(0), labourCost: dec(0), subcontractCost: dec(0), overheadCost: dec(0) }
  for (const line of lines) if (line.size === null || line.size === size) sums[STANDARD_PART_OF[line.category]] = sums[STANDARD_PART_OF[line.category]].plus(line.cost)
  const six = (value: Decimal) => value.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6)
  return { materialCost: six(sums.materialCost), labourCost: six(sums.labourCost), subcontractCost: six(sums.subcontractCost), overheadCost: six(sums.overheadCost) }
}
