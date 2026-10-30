import type { Issue } from '../../core/errors'
import { convertibleUnits, dimensionOf, FACTOR_SCALE, type ItemUnits, type Uom } from '../../product/units/units'
import { factorOf } from '../../purchasing/sources/sources'
import { Dec, parseDecimal, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { QUANTITY_SCALE } from '../ledger/moves'

/**
 * Receiving in the supplier's unit (B-W2a-31; SCM-123; no design part: a unit beside the W1 receipt line), pure. The
 * supplier counts in its unit (boxes of 10 protectors, a roll of 50 m, ft² where we keep m²); the receipt line keeps
 * what came in that unit, the unit and the factor (factory-db GoodsReceiptLine receivedQuantity, receivedUom,
 * receivedFactor), and its base quantity — what the ledger and the order count — is round(quantity × factor, 4), half
 * away from zero, exactly as the …_supply_w2a_guards trigger computes it.
 *
 *   the unit     named by the receiver; for the office, a received quantity or factor without a unit takes the
 *                approved source's purchase unit (B-W2a-10: SupplierItem.purchaseUom of this supplier, company, material
 *                and colour); the floor reads no source, so it names the unit. No received field: no conversion (W1).
 *   the factor   the material's own for that unit (factory-domain purchasing/sources factorOf: a source's factor is the
 *                material's), or the one the receiver gives for a unit of the item's own size (a ROLL that measures
 *                48.5 m, a BOX of 12): a unit the material does not convert needs it given.
 *   lots         a lot-tracked line's lots are counted in the same unit; their base quantities add up to the line's
 *                exactly (the remainder of the rounding goes to the largest lot), and their moves post in the base unit.
 *   leather      never: each hide is measured in the area unit it was measured in (W1, Q13 one unit end to end).
 */

/** Base quantity of `quantity` units of `factor` base units each: four decimals, half away from zero (the trigger's round()). */
export function receivedBase(quantity: DecimalInput, factor: DecimalInput): Decimal {
  return new Dec(quantity).times(factor).toDecimalPlaces(QUANTITY_SCALE, Dec.ROUND_HALF_UP)
}

export interface ReceivedUnit {
  readonly uom: Uom
  /** Base units per received unit, at most eight decimals. */
  readonly factor: string
}

/**
 * The received unit's factor: the one given (above 0, at most 8 decimals), else the material's own for that unit; a unit
 * the material does not convert needs a given factor. Paths relative to the line.
 */
export function receivedUnitOf(uom: Uom, givenFactor: string | null | undefined, units: ItemUnits): { readonly unit: ReceivedUnit; readonly problems?: undefined } | { readonly problems: Issue[] } {
  if (givenFactor !== null && givenFactor !== undefined && givenFactor.trim() !== '') {
    const value = parseDecimal(givenFactor)
    if (value === null) return { problems: [{ path: 'receivedFactor', message: 'Expected a plain decimal such as 10 or 48.5.' }] }
    if (value.lessThanOrEqualTo(0)) return { problems: [{ path: 'receivedFactor', message: 'Above 0.' }] }
    if (value.decimalPlaces() > FACTOR_SCALE) return { problems: [{ path: 'receivedFactor', message: `At most ${FACTOR_SCALE} decimals.` }] }
    if (uom === units.baseUom && !value.equals(1)) return { problems: [{ path: 'receivedFactor', message: `${uom} is the material's own unit: its factor is 1.` }] }
    // A unit of a fixed dimension converts by itself: a factor that says otherwise is a mistake.
    const own = dimensionOf(uom) === 'ITEM' ? null : factorOf(uom, units)
    if (own !== null && !new Dec(own).equals(value.toDecimalPlaces(FACTOR_SCALE, Dec.ROUND_HALF_UP))) {
      return { problems: [{ path: 'receivedFactor', message: `One ${uom} is ${plain(own)} ${units.baseUom} for this material; leave the factor out, or receive in a unit of its own size.` }] }
    }
    return { unit: { uom, factor: value.toFixed(FACTOR_SCALE) } }
  }
  const own = factorOf(uom, units)
  if (own === null) {
    return { problems: [{ path: 'receivedFactor', message: `This material does not convert ${uom} to its base unit ${units.baseUom} (it converts ${convertibleUnits(units).join(', ')}): give how many ${units.baseUom} one ${uom} holds.` }] }
  }
  return { unit: { uom, factor: own } }
}

const plain = (value: DecimalInput): string => new Dec(value).toDecimalPlaces(FACTOR_SCALE).toString()

/**
 * Base quantities of lots counted in the received unit whose sum is the line's base quantity exactly: each lot's
 * round(quantity × factor, 4), then the difference to round(Σ quantity × factor, 4) on the largest lot (the first of the
 * largest).
 */
export function lotBasesOf(quantities: readonly DecimalInput[], factor: DecimalInput): { readonly lineBase: Decimal; readonly lots: Decimal[] } {
  const total = quantities.reduce<Decimal>((sum, quantity) => sum.plus(quantity), ZERO)
  const lineBase = receivedBase(total, factor)
  const lots = quantities.map((quantity) => receivedBase(quantity, factor))
  const gap = lineBase.minus(lots.reduce<Decimal>((sum, value) => sum.plus(value), ZERO))
  if (!gap.isZero() && lots.length > 0) {
    let largest = 0
    quantities.forEach((quantity, index) => {
      if (new Dec(quantity).greaterThan(quantities[largest]!)) largest = index
    })
    lots[largest] = lots[largest]!.plus(gap)
  }
  return { lineBase, lots }
}

/**
 * The line's quantity in the order line's unit (what counts against the order beside the base quantity): the received
 * quantity when the units are the same, else the base quantity at the order line's own ratio (quantity ÷ base quantity),
 * four decimals half up.
 */
export function orderQuantityOf(received: { readonly quantity: DecimalInput; readonly uom: Uom; readonly baseQuantity: DecimalInput }, orderLine: { readonly uom: Uom; readonly quantity: DecimalInput; readonly baseQuantity: DecimalInput }): Decimal {
  if (received.uom === orderLine.uom) return new Dec(received.quantity)
  const base = new Dec(orderLine.baseQuantity)
  if (base.isZero()) return new Dec(received.baseQuantity)
  return new Dec(received.baseQuantity).times(orderLine.quantity).dividedBy(base).toDecimalPlaces(QUANTITY_SCALE, Dec.ROUND_HALF_UP)
}

/** Received-unit fields a line sends, against its material's tracking (paths relative to the line). */
export function receivedShapeProblems(line: { readonly receivedQuantity?: string | undefined; readonly receivedUom?: Uom | undefined; readonly receivedFactor?: string | undefined; readonly quantity?: string | undefined; readonly uom?: Uom | undefined; readonly baseQuantity?: string | undefined; readonly lots?: readonly { readonly baseQuantity?: string | undefined }[] | undefined }, tracking: 'NONE' | 'LOT' | 'HIDE' | 'SERIAL'): Issue[] {
  const any = line.receivedQuantity !== undefined || line.receivedUom !== undefined || line.receivedFactor !== undefined
  if (!any) return []
  if (tracking === 'HIDE') return [{ path: 'receivedUom', message: 'Leather is received hide by hide, each in the unit it was measured in: leave the received unit out.' }]
  const problems: Issue[] = []
  if (line.uom !== undefined) problems.push({ path: 'uom', message: 'Received in the supplier\'s unit: give it as receivedUom and leave the line\'s unit out.' })
  if (line.baseQuantity !== undefined) problems.push({ path: 'baseQuantity', message: 'The base quantity follows from the received quantity and its factor: leave it out.' })
  if (tracking === 'LOT') {
    if (line.receivedQuantity !== undefined) problems.push({ path: 'receivedQuantity', message: 'A lot-tracked line is counted by its lots (in the received unit): leave the line\'s received quantity out.' })
    ;(line.lots ?? []).forEach((lot, index) => {
      if (lot.baseQuantity !== undefined) problems.push({ path: `lots/${index}/baseQuantity`, message: 'The lot\'s base quantity follows from the received unit\'s factor: leave it out.' })
    })
  } else {
    if (line.quantity !== undefined) problems.push({ path: 'quantity', message: 'Received in the supplier\'s unit: give the quantity as receivedQuantity, not quantity.' })
    if (line.receivedQuantity === undefined) problems.push({ path: 'receivedQuantity', message: 'How many came, in the supplier\'s unit?' })
    else {
      const value = parseDecimal(line.receivedQuantity)
      if (value === null) problems.push({ path: 'receivedQuantity', message: 'Expected a plain decimal such as 12.5.' })
      else if (value.lessThanOrEqualTo(0)) problems.push({ path: 'receivedQuantity', message: 'Above 0.' })
      else if (value.decimalPlaces() > QUANTITY_SCALE) problems.push({ path: 'receivedQuantity', message: `At most ${QUANTITY_SCALE} decimals.` })
    }
  }
  return problems
}
