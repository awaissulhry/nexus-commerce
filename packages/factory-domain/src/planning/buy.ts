import { Decimal } from 'decimal.js'
import { isBusinessDate, type BusinessDate } from '../core/time'
import { baseFactor, decimalOf, dimensionOf, QUANTITY_SCALE, roundTo, type DecimalInput, type ItemUnits, type Uom } from '../product/units/units'

/**
 * From a shortage to a suggestion (PLN-066; PRD-030), pure: how much to buy, in what unit, by when.
 *
 *   buy        the net need (base unit) in the item's PURCHASE unit (units module, exact), then, in this order:
 *              a whole number for a unit that comes whole (pieces, pairs, and the item's own units: hides, sides,
 *              rolls, cones, boxes, sets), else up to four decimals; the supplier's minimum order quantity; its order
 *              multiple. Always rounded UP: a suggestion never buys less than the need.
 *   make       a MAKE line suggests the net need in the base unit, whole when the base unit comes whole.
 *   hides      leather planned in area gets "about N hides": the suggestion in hides when it is bought by the hide,
 *              else the area over the item's hide factor (its purchase or consumption unit HIDE), rounded up; none
 *              when the item has no hide factor.
 *   order by   the need date less the supplier's lead time in calendar days (closed days are W2a); without a lead
 *              time on record, the need date itself, and the answer says so.
 *
 * The terms come from the item (Item.leadTimeDays, minOrderQty, orderMultiple: its default supplier's) and the supplier
 * (Party.leadTimeDays), through ONE function, `supplyRulesFor`; the run reads them through `SupplyRulesOf`.
 */

/** What a supplier's terms say for an item. Every field optional: null when none is on record. */
export interface SupplyRules {
  /** Calendar days from the order to the goods at the site. */
  readonly leadTimeDays: number | null
  /** The least it sells, in the item's purchase unit. */
  readonly minOrderQuantity: string | null
  /** It sells in steps of this, in the item's purchase unit. */
  readonly orderMultiple: string | null
}

export const NO_SUPPLY_RULES: SupplyRules = Object.freeze({ leadTimeDays: null, minOrderQuantity: null, orderMultiple: null })

/** The one lookup of a supplier's terms for an item (supplier null: none chosen). */
export type SupplyRulesOf = (itemId: string, supplierId: string | null) => SupplyRules

/** An item's buying terms as stored (Item.leadTimeDays, minOrderQty, orderMultiple: its default supplier's terms). */
export interface ItemTerms {
  readonly defaultSupplierId: string | null
  readonly leadTimeDays: number | null
  /** In the purchase unit. */
  readonly minOrderQty: string | null
  readonly orderMultiple: string | null
}

/** A supplier's own usual lead time (Party.leadTimeDays). */
export interface SupplierTerms {
  readonly id: string
  readonly leadTimeDays: number | null
}

const days = (value: number | null | undefined): number | null => (value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null)
const positive = (value: string | null | undefined): string | null => (value !== null && value !== undefined && /^\d+(\.\d+)?$/.test(value) && decimalOf(value).gt(0) ? value : null)

/**
 * The terms that apply when the item is bought from `supplier` (PLN-066): from its default supplier (or none named),
 * the item's lead time (else the supplier's usual one), minimum and multiple; from another supplier (a BOM line's), that
 * supplier's usual lead time and no minimum or multiple (the item's are its default supplier's). A value that is not a
 * lead time of 0 days or more, or a minimum or multiple above 0, counts as none.
 */
export function supplyRulesFor(item: ItemTerms, supplier: SupplierTerms | null): SupplyRules {
  const fromDefault = supplier === null || supplier.id === item.defaultSupplierId
  if (!fromDefault) return { leadTimeDays: days(supplier.leadTimeDays), minOrderQuantity: null, orderMultiple: null }
  return {
    leadTimeDays: days(item.leadTimeDays) ?? days(supplier?.leadTimeDays),
    minOrderQuantity: positive(item.minOrderQty),
    orderMultiple: positive(item.orderMultiple),
  }
}

const UP = { scale: QUANTITY_SCALE, rounding: 'UP' } as const
const HALF_UP = { scale: QUANTITY_SCALE, rounding: 'HALF_UP' } as const

/** A unit that is bought, counted or made whole: pieces, pairs, and the item's own units (hide, side, roll, cone, box, set). */
export const comesWhole = (uom: Uom): boolean => dimensionOf(uom) === 'COUNT' || dimensionOf(uom) === 'ITEM'

const whole = (value: Decimal): Decimal => value.toDecimalPlaces(0, Decimal.ROUND_UP)

/** One step of the rounding, for the Bridge ("+12.5 ft² to whole hides"). */
export interface RoundingStep {
  readonly rule: 'WHOLE_UNITS' | 'MINIMUM' | 'MULTIPLE'
  /** The quantity after the step, in the suggestion's unit. */
  readonly quantity: string
}

export interface Suggestion {
  /** In `uom`, four decimals. */
  readonly quantity: string
  readonly uom: Uom
  /** The same in the base unit (four decimals, half up): what the suggestion brings. */
  readonly baseQuantity: string
  /** What the rounding adds on top of the net need, in the base unit (four decimals; 0 when it adds nothing). */
  readonly roundingBase: string
  readonly steps: readonly RoundingStep[]
}

const text = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)

/**
 * The suggestion for a net need (base unit): a BUY in the purchase unit after whole units, minimum and multiple; a MAKE
 * in the base unit, whole when it comes whole. A need of 0 suggests 0.
 */
export function suggestionFor(net: DecimalInput, action: 'BUY' | 'MAKE', units: ItemUnits, rules: SupplyRules = NO_SUPPLY_RULES): Suggestion {
  const need = decimalOf(net)
  const uom: Uom = action === 'BUY' ? units.purchaseUom : units.baseUom
  const factor = baseFactor(uom, units)
  if (factor === null || factor.lte(0)) throw new RangeError(`the item cannot convert ${uom} to its base unit ${units.baseUom}`)
  if (need.lte(0)) return { quantity: text(decimalOf('0')), uom, baseQuantity: text(decimalOf('0')), roundingBase: text(decimalOf('0')), steps: [] }
  const steps: RoundingStep[] = []
  let quantity = need.div(factor)
  if (comesWhole(uom)) {
    const rounded = whole(quantity)
    if (!rounded.eq(quantity)) steps.push({ rule: 'WHOLE_UNITS', quantity: text(rounded) })
    quantity = rounded
  } else {
    quantity = roundTo(quantity, UP)
  }
  if (action === 'BUY') {
    const minimum = rules.minOrderQuantity === null ? null : decimalOf(rules.minOrderQuantity, 'minOrderQuantity')
    if (minimum && quantity.lt(minimum)) {
      quantity = minimum
      steps.push({ rule: 'MINIMUM', quantity: text(quantity) })
    }
    const multiple = rules.orderMultiple === null ? null : decimalOf(rules.orderMultiple, 'orderMultiple')
    if (multiple && multiple.gt(0)) {
      const stepped = whole(quantity.div(multiple)).times(multiple)
      if (!stepped.eq(quantity)) {
        quantity = stepped
        steps.push({ rule: 'MULTIPLE', quantity: text(quantity) })
      }
    }
  }
  quantity = roundTo(quantity, UP)
  const base = roundTo(quantity.times(factor), HALF_UP)
  const extra = base.minus(need)
  return { quantity: text(quantity), uom, baseQuantity: text(base), roundingBase: text(extra.isNegative() ? decimalOf('0') : extra), steps }
}

/** About how many hides a quantity in the base unit is, rounded up; null when the item has no hide factor. */
export function hidesFor(baseQuantity: DecimalInput, units: ItemUnits): number | null {
  const factor = baseFactor('HIDE', units)
  if (factor === null || factor.lte(0)) return null
  const hides = whole(decimalOf(baseQuantity).div(factor))
  return Number.parseInt(hides.toFixed(0), 10)
}

/** A calendar day `days` later (negative: earlier), YYYY-MM-DD. */
export function addDays(date: BusinessDate, days: number): BusinessDate {
  if (!isBusinessDate(date)) throw new RangeError(`not a calendar day: ${String(date)}`)
  if (!Number.isSafeInteger(days)) throw new RangeError(`not a whole number of days: ${String(days)}`)
  const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

export interface OrderBy {
  /** The day to order by, YYYY-MM-DD. */
  readonly date: BusinessDate
  /** null: no lead time on record (the date is the need date). */
  readonly leadTimeDays: number | null
  /** The day is before today: the order is late already. */
  readonly passed: boolean
}

/** The order-by day: the need date less the lead time (the need date when none is on record). */
export function orderByOf(needDate: BusinessDate, rules: SupplyRules, today: BusinessDate): OrderBy {
  const lead = rules.leadTimeDays
  const date = lead === null ? needDate : addDays(needDate, -lead)
  return { date, leadTimeDays: lead, passed: date < today }
}
