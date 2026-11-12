import { UNITS, type Uom } from '../../product/units/units'
import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { quantityText } from '../ledger/moves'
import { numberText, type Language } from '../rolls/rolls'

/**
 * Below the minimum (B-W2b-314; SCM-281 "Low stock alerts"; design warehouse.stock st-metrics "Below minimum"), pure.
 *
 * A material's minimum at a site is its planning parameters' (ItemPlanning, B-W2a-16; per site, for one colour or every
 * colour of the item), by the parameters' method:
 *
 *   MIN_MAX         minStock: below it, order up to the maximum
 *   REORDER_POINT   reorderPoint: at or below it, order the lot size (the minimum here is the point itself)
 *   ORDERS, MANUAL  safetyStock when one is kept; none otherwise
 *
 * What is compared is what the site has and expects, as planning counts it: on hand + still to come on open purchase lines −
 * held by ACTIVE reservations (consumables' levelOf, B-W2b-107, reads the same). It is below the minimum when that is less
 * than the minimum (a reorder point: when it is at or below it). A minimum of 0 is never undercut.
 */

export const MINIMUM_BASES = ['MIN_MAX', 'REORDER_POINT', 'SAFETY_STOCK'] as const
export type MinimumBasis = (typeof MINIMUM_BASES)[number]

export interface PlanningMinimumFacts {
  readonly method: 'ORDERS' | 'REORDER_POINT' | 'MIN_MAX' | 'MANUAL' | string
  readonly minStock: DecimalInput | null
  readonly reorderPoint: DecimalInput | null
  readonly safetyStock: DecimalInput | null
}

/** The minimum a site's parameters keep for a material, with what it comes from; null: none. */
export function minimumOf(planning: PlanningMinimumFacts): { readonly minimum: Decimal; readonly basis: MinimumBasis } | null {
  const value = (input: DecimalInput | null) => (input === null || input === undefined ? null : new Dec(input.toString()))
  if (planning.method === 'MIN_MAX') {
    const min = value(planning.minStock)
    return min === null ? null : { minimum: min, basis: 'MIN_MAX' }
  }
  if (planning.method === 'REORDER_POINT') {
    const point = value(planning.reorderPoint)
    return point === null ? null : { minimum: point, basis: 'REORDER_POINT' }
  }
  const safety = value(planning.safetyStock)
  return safety === null || safety.isZero() ? null : { minimum: safety, basis: 'SAFETY_STOCK' }
}

export interface LowStockFacts {
  readonly onHand: DecimalInput
  readonly onOrder: DecimalInput
  readonly reserved: DecimalInput
  readonly minimum: DecimalInput
  readonly basis: MinimumBasis
}

export interface LowStockVerdict {
  readonly below: boolean
  /** on hand + on order − reserved. */
  readonly position: string
  /** How much is missing to reach the minimum (0 when not below). */
  readonly short: string
}

export function lowStockOf(facts: LowStockFacts): LowStockVerdict {
  const position = new Dec(facts.onHand.toString()).plus(facts.onOrder.toString()).minus(facts.reserved.toString())
  const minimum = new Dec(facts.minimum.toString())
  const below = minimum.greaterThan(0) && (facts.basis === 'REORDER_POINT' ? position.lessThanOrEqualTo(minimum) : position.lessThan(minimum))
  const short = below ? Dec.max(ZERO, minimum.minus(position)) : ZERO
  return { below, position: quantityText(position), short: quantityText(short) }
}

/**
 * The verdict in words: "12 m² of a minimum of 20 m² (on hand 15 m² + on order 0 m² − reserved 3 m²)" (it "12 m² su un
 * minimo di 20 m² …").
 */
export function lowStockWords(facts: LowStockFacts & { readonly uom: Uom }, language: Language): string {
  const verdict = lowStockOf(facts)
  const amount = (value: DecimalInput) => `${numberText(value, language)} ${UNITS[facts.uom].symbol}`
  const parts =
    language === 'it'
      ? `giacenza ${amount(facts.onHand)} + in arrivo ${amount(facts.onOrder)} − riservato ${amount(facts.reserved)}`
      : `on hand ${amount(facts.onHand)} + on order ${amount(facts.onOrder)} − reserved ${amount(facts.reserved)}`
  const minimum = facts.basis === 'REORDER_POINT' ? (language === 'it' ? 'un punto di riordino di' : 'a reorder point of') : language === 'it' ? 'un minimo di' : 'a minimum of'
  return language === 'it' ? `${amount(verdict.position)} su ${minimum} ${amount(facts.minimum)} (${parts})` : `${amount(verdict.position)} against ${minimum} ${amount(facts.minimum)} (${parts})`
}
