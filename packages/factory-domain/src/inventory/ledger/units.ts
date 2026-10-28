import type { Issue } from '../../core/errors'
import { baseFactor, convertibleUnits, dimensionOf, QUANTITY_SCALE, toBase, type ItemUnits, type Uom } from '../../product/units/units'
import { parseDecimal, type DecimalInput } from '../../tax/decimal'
import { quantityText } from './moves'

/**
 * A move's quantity in its item's base unit (plan A1 §2.1 "Quantities"; SCM-183, SCM-184), pure, with the product
 * module's units (factory-domain product/units):
 *
 *   the base unit itself       the base quantity is the quantity;
 *   a unit of the item's own   HIDE, SIDE, ROLL, CONE, BOX, SET (the ITEM dimension): its size is the item's average
 *   size                       (1 HIDE ≈ 52.5 ft²), never what this hide or roll measures, so the caller gives the base
 *                              quantity (the measured area, the roll's metres);
 *   any other unit the item    a unit of the base unit's fixed dimension (m² for an item counted in ft²: the exact
 *   converts                   ratio) or its purchase or consumption unit (metres of a fabric counted in m²: its
 *                              width): the base quantity is computed, rounded half up to four decimals; one the caller
 *                              gives must be that same quantity;
 *   a unit it cannot convert   refused, naming the units it converts.
 */

export type BaseQuantity = { readonly baseQuantity: string; readonly problem?: undefined } | { readonly baseQuantity?: undefined; readonly problem: Issue }

const ROUND = { scale: QUANTITY_SCALE, rounding: 'HALF_UP' } as const

export function baseQuantityOf(move: { readonly quantity: DecimalInput; readonly uom: Uom; readonly baseQuantity?: DecimalInput | null | undefined }, item: ItemUnits): BaseQuantity {
  const given = move.baseQuantity ?? null
  if (move.uom === item.baseUom) return { baseQuantity: String(given ?? move.quantity) }
  if (dimensionOf(move.uom) === 'ITEM') {
    if (given === null) {
      return { problem: { path: 'baseQuantity', message: `A ${move.uom} has its own size: give the quantity in the item's base unit ${item.baseUom} too (what it measures).` } }
    }
    return { baseQuantity: String(given) }
  }
  if (baseFactor(move.uom, item) === null) {
    return { problem: { path: 'uom', message: `This item does not convert ${move.uom} to its base unit ${item.baseUom}; use ${convertibleUnits(item).join(', ')}.` } }
  }
  const quantity = parseDecimal(move.quantity)
  // A quantity that is not a decimal: the move's own checks say so.
  if (quantity === null) return { baseQuantity: String(given ?? move.quantity) }
  const computed = quantityText(toBase(quantity, move.uom, item, ROUND))
  const sent = given === null ? null : parseDecimal(given)
  if (given !== null && (sent === null || !sent.equals(computed))) {
    return { problem: { path: 'baseQuantity', message: `${quantityText(quantity)} ${move.uom} is ${computed} ${item.baseUom}; the base quantity sent (${String(given)}) does not match it.` } }
  }
  return { baseQuantity: computed }
}
