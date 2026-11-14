import { minorPlaces } from '../../core/money'
import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'

/**
 * Cost of goods sold at shipment (B-W2b-407; FIN-043; design finance.accounting "cost of goods sold and variances"),
 * pure. When a shipment leaves (SHIPPED: the goods leave, not on delivery), each of its lines posts ONE entry: its
 * garments at their cost layers, split by category (material, labour, subcontract, overhead adding up to the amount):
 *
 *   from stock     the garments its SHIPMENT moves took out of finished goods cost what the stock ledger valued those
 *                  moves at (StockValuation, never recomputed)
 *   straight from  the garments that never went into stock cost what they would have come in at: the FROZEN standard of
 *   the release    the cell's finished item in force on the day it left (B-W2a-F7's rule for a finished garment)
 *   the split      by the FROZEN standard's parts of that item and day (largest remainder: the parts add up to the amount
 *                  to the cent); with no standard to split by, the whole cost is material
 *
 * A customer's own material is never in it (FIN-045): a cost sheet leaves it out of the standard (B-W2b-228) and the
 * stock ledger never values it (B-W2b-309). Written only while the company's figures for the accountant are on
 * (GATE-ACCOUNTANT); a garment with no value (no standard, a move not valued yet) waits, in words.
 *
 * UNVERIFIED (GATE-ACCOUNTANT): cost of goods sold at shipment only (never at the invoice: every garment leaves on a
 * shipment); a carrier's return takes the shipment's entries back (the garments are in finished goods again); the split
 * of a stock move valued without a standard is all material.
 */

export interface CogsAmounts {
  readonly materialAmount: number
  readonly labourAmount: number
  readonly subcontractAmount: number
  readonly overheadAmount: number
  readonly amount: number
}

/** A standard's parts per unit (decimal strings, any scale). */
export interface StandardParts {
  readonly materialCost: DecimalInput
  readonly labourCost: DecimalInput
  readonly subcontractCost: DecimalInput
  readonly overheadCost: DecimalInput
}

/** One entry per source event: the line's key, `:<n>` from the second one on (after a reversal); a reversal's own key. */
export const cogsKeys = Object.freeze({
  shipmentLine: (lineId: string, n = 1): string => (n <= 1 ? `cogs:shipment-line:${lineId}` : `cogs:shipment-line:${lineId}:${n}`),
  reversal: (entryId: string): string => `cogs:reversal:${entryId}`,
})

/** quantity × unit cost in minor units, one half-up rounding. */
export function amountOf(quantity: DecimalInput, unitCost: DecimalInput, currency: string): number {
  return Number.parseInt(new Dec(quantity).times(new Dec(unitCost)).times(new Dec(10).pow(minorPlaces(currency))).toDecimalPlaces(0, Dec.ROUND_HALF_UP).toFixed(0), 10)
}

/**
 * An amount (0 or more) split by a standard's parts, largest remainder (ties in the parts' order): the parts add up to the
 * amount exactly. No standard, or one whose parts are all 0: the whole amount is material.
 */
export function splitByStandard(amount: number, parts: StandardParts | null): CogsAmounts {
  if (!Number.isInteger(amount) || amount < 0) throw new RangeError(`a cost of goods sold of 0 or more minor units, not ${amount}`)
  const weights: Decimal[] = parts ? [parts.materialCost, parts.labourCost, parts.subcontractCost, parts.overheadCost].map((part) => Dec.max(ZERO, new Dec(part))) : []
  const whole = weights.reduce((sum, weight) => sum.plus(weight), ZERO)
  if (!parts || !whole.greaterThan(0)) return { materialAmount: amount, labourAmount: 0, subcontractAmount: 0, overheadAmount: 0, amount }
  const exact = weights.map((weight) => weight.times(amount).dividedBy(whole))
  const floors = exact.map((value) => Number(value.floor().toFixed(0)))
  let left = amount - floors.reduce((sum, value) => sum + value, 0)
  const order = exact.map((value, index) => ({ index, remainder: value.minus(value.floor()) })).sort((a, b) => b.remainder.comparedTo(a.remainder) || a.index - b.index)
  for (const { index } of order) {
    if (left === 0) break
    floors[index]! += 1
    left -= 1
  }
  return { materialAmount: floors[0]!, labourAmount: floors[1]!, subcontractAmount: floors[2]!, overheadAmount: floors[3]!, amount }
}

/** The opposite of an entry's amounts (its reversal). */
export const negated = (amounts: CogsAmounts): CogsAmounts => ({
  materialAmount: -amounts.materialAmount,
  labourAmount: -amounts.labourAmount,
  subcontractAmount: -amounts.subcontractAmount,
  overheadAmount: -amounts.overheadAmount,
  amount: -amounts.amount,
})

/** Why a shipment line has no entry yet (or will have none), in words beside the code. */
export const COGS_WAITS = ['NOT_LEFT', 'NOT_VALUED', 'NO_STANDARD', 'NO_ITEM', 'CURRENCY', 'TAKEN'] as const
export type CogsWait = (typeof COGS_WAITS)[number]

export const COGS_WAIT_WORDS: Readonly<Record<CogsWait, string>> = Object.freeze({
  NOT_LEFT: 'The shipment has not left (SHIPPED or DELIVERED): its cost of goods sold posts when it leaves.',
  NOT_VALUED: 'Garments it took out of finished goods have no value yet: their cost posts once the stock ledger values them.',
  NO_STANDARD: "The finished garment has no FROZEN standard on the day it left: its cost posts once finance freezes one (Costing › Standards).",
  NO_ITEM: 'The size it ships has no finished item (it never went into stock and has no standard): its cost posts once one exists with a FROZEN standard.',
  CURRENCY: "A value is in another currency than the company's: its cost posts once it is converted (no exchange rate kept).",
  TAKEN: 'Its cost of goods sold is posted already.',
})

/** The cost per garment of an entry (amount ÷ quantity), in major units, six places; null for 0 garments. */
export function perUnit(amount: number, quantity: DecimalInput, currency: string): string | null {
  const count = new Dec(quantity)
  if (count.isZero()) return null
  return new Dec(amount).dividedBy(new Dec(10).pow(minorPlaces(currency))).dividedBy(count).toDecimalPlaces(6, Dec.ROUND_HALF_UP).toFixed(6)
}

/** Why a cost of goods sold write is refused, as the issue path `refusal/<code>` (the screens word each code). */
export const COGS_REFUSALS = ['WAITS_FOR_ACCOUNTANT', 'NOT_LEFT', 'LOCKED', 'IS_REVERSAL', 'REVERSED_ALREADY'] as const
export type CogsRefusal = (typeof COGS_REFUSALS)[number]
