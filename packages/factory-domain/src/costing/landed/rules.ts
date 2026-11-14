import { minorPlaces } from '../../core/money'
import type { ValuedQuantity } from '../../inventory/ledger/valuation'
import { COST_SCALE } from '../../inventory/ledger/valuation'
import type { Uom } from '../../product/units/units'
import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'

/**
 * Landed cost over the received lots (B-W2b-407; FIN-044, with SCM-126's receipt extra costs and SCM-127's allocation by
 * leather area; finance owns it), pure. A supplier invoice's CHARGE line (freight, duty, a broker's fee …) is spread over
 * the lots its goods came in, on one basis:
 *
 *   VALUE     the lots' purchase value: what the stock ledger valued their receipt at (minor units)
 *   WEIGHT    the lots' kilograms: their received quantity when the material is counted in KG or G, else the weight the
 *             person types per lot (nothing in the factory records a lot's weight)
 *   QUANTITY  the lots' received quantity in their base unit (leather: its area, SCM-127)
 *
 * The shares add up to the line's net amount exactly (largest remainder, ties in the lots' order). Prepared as a DRAFT,
 * POSTED once (only while the company's figures for the accountant are on: GATE-ACCOUNTANT), reversed once with why.
 * A customer's own lot never takes a share (FIN-045: never valued).
 *
 * The lots' cost moves: a POSTED share is part of its lot's cost from then on. Stock leaving the lot is valued at the
 * lot's cost with the landed cost in it (lotUnitCostWithLanded), and the stock valuation adds it to the lot's value.
 * UNVERIFIED (GATE-ACCOUNTANT): the whole share lands on what is left of the lot when it is posted (moving average);
 * the part of a lot already used keeps its old cost, and a lot used up keeps the share as value left on gone stock (the
 * valuation's residue) until the accountant says where it goes.
 */

export const LANDED_BASES = ['VALUE', 'WEIGHT', 'QUANTITY'] as const
export type LandedBasis = (typeof LANDED_BASES)[number]

export const LANDED_STATUSES = ['DRAFT', 'POSTED', 'REVERSED'] as const
export type LandedStatus = (typeof LANDED_STATUSES)[number]

export const LANDED_BASIS_WORDS: Readonly<Record<LandedBasis, string>> = Object.freeze({
  VALUE: "By the lots' purchase value.",
  WEIGHT: "By the lots' weight in kilograms.",
  QUANTITY: "By the lots' quantity received, in their base unit (leather: its area).",
})

/** One share per allocation and lot. */
export const landedShareKey = (allocationId: string, lotId: string): string => `share:${allocationId}:${lotId}`

/** A lot's figure on the basis: above 0 to take a share. */
export interface BasisFigure {
  readonly lotId: string
  readonly basisAmount: DecimalInput
}

/**
 * The amount (above 0, minor units) spread over the lots by their basis figures, largest remainder: the shares add up
 * to the amount exactly; ties go to the lot listed first. Every figure is above 0.
 */
export function allocateShares(amount: number, figures: readonly BasisFigure[]): { readonly lotId: string; readonly amount: number }[] {
  if (!Number.isInteger(amount) || amount <= 0) throw new RangeError(`a landed cost of more than 0 minor units, not ${amount}`)
  if (figures.length === 0) throw new RangeError('a landed cost lands on one lot at least')
  const weights = figures.map((figure) => new Dec(figure.basisAmount))
  if (weights.some((weight) => !weight.greaterThan(0))) throw new RangeError("every lot's basis figure is above 0")
  const whole = weights.reduce((sum, weight) => sum.plus(weight), ZERO)
  const exact = weights.map((weight) => weight.times(amount).dividedBy(whole))
  const shares = exact.map((value) => Number(value.floor().toFixed(0)))
  let left = amount - shares.reduce((sum, value) => sum + value, 0)
  const order = exact.map((value, index) => ({ index, remainder: value.minus(value.floor()) })).sort((a, b) => b.remainder.comparedTo(a.remainder) || a.index - b.index)
  for (const { index } of order) {
    if (left === 0) break
    shares[index]! += 1
    left -= 1
  }
  return figures.map((figure, index) => ({ lotId: figure.lotId, amount: shares[index]! }))
}

/** A lot's kilograms from its received quantity, when its base unit is a mass (KG, G); else null (typed by the person). */
export function kilogramsOf(quantity: DecimalInput, uom: Uom): string | null {
  if (uom === 'KG') return new Dec(quantity).toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)
  if (uom === 'G') return new Dec(quantity).dividedBy(1000).toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)
  return null
}

/**
 * A lot's cost per base unit with its POSTED landed cost in it (inventory/ledger valuation's lotUnitCost, plus the landed
 * value in major units): what is left of the lot carries the whole landed cost (moving average); a lot with nothing left
 * spreads it over what came in. Null when nothing came in.
 */
export function lotUnitCostWithLanded(valuations: Iterable<ValuedQuantity>, landed: DecimalInput | null): Decimal | null {
  let net = ZERO
  let netValue = landed === null ? ZERO : new Dec(landed)
  let inQuantity = ZERO
  let inValue = netValue
  for (const valuation of valuations) {
    const q = new Dec(valuation.quantity)
    const value = q.times(valuation.unitCost)
    net = net.plus(q)
    netValue = netValue.plus(value)
    if (q.greaterThan(0)) {
      inQuantity = inQuantity.plus(q)
      inValue = inValue.plus(value)
    }
  }
  const round = (value: Decimal) => value.toDecimalPlaces(COST_SCALE, Dec.ROUND_HALF_UP)
  if (net.greaterThan(0) && !netValue.isNegative()) return round(netValue.dividedBy(net))
  return inQuantity.isZero() ? null : round(inValue.dividedBy(inQuantity))
}

/** Minor units to major units of a currency (a landed value for the lot cost). */
export const majorOf = (minor: number, currency: string): string => new Dec(minor).dividedBy(new Dec(10).pow(minorPlaces(currency))).toFixed(minorPlaces(currency))

/** Why an allocation cannot be prepared or posted, as the issue path `refusal/<code>`. */
export const LANDED_REFUSALS = [
  'NOT_A_CHARGE',
  'INVOICE_VOIDED',
  'CURRENCY',
  'DRAFT_EXISTS',
  'POSTED_ALREADY',
  'NO_LOTS',
  'CUSTOMER_OWNED',
  'OTHER_COMPANY',
  'NOT_RECEIVED',
  'NO_WEIGHT',
  'NO_VALUE',
  'NOT_DRAFT',
  'NOT_POSTED',
  'WAITS_FOR_ACCOUNTANT',
  'LOCKED',
] as const
export type LandedRefusal = (typeof LANDED_REFUSALS)[number]
