import type { Issue } from '../../core/errors'
import { fitsDecimal, QUANTITY } from '../../core/money'
import { Dec, type Decimal } from '../../tax/decimal'

/**
 * How a site plans one item (PLN-005) and its reorder rules (PLN-099; B-W2a-16; ItemPlanning, W2a wave 4), pure.
 *
 *   method       ORDERS (the default): what the orders need, plus the safety stock. REORDER_POINT: when the stock
 *                position falls to the reorder point, order the lot size (as many lots as bring it above). MIN_MAX:
 *                when it falls below the minimum, order up to the maximum. MANUAL: shown, never suggested.
 *   exactness    a reorder point and lot size exactly for REORDER_POINT, a minimum and maximum stock exactly for
 *                MIN_MAX; a supplier only for a BUY, a make site only for a MAKE (the …_stock_plan_w2a_guards trigger
 *                holds the same for every login; these say it first, in words, with the field).
 *   one row      per site, item and colour (a null colour: every colour of the item); a colour's row wins over the
 *                null one, whole (fields are not mixed between rows). The planning module keeps it with a lock.
 *   quantities   every one in the item's BASE unit, four decimals at most (the item's own minimum and step, on the
 *                Item, are its default supplier's, in its purchase unit: the run's buy rounding, planning/buy.ts).
 *
 * The position a reorder rule reads (on hand + on order − reserved) and the order it suggests are the daily run's
 * (B-W2a-22); `reorderNeed` and `orderQuantities` are the rule it counts with.
 */

export const ITEM_PLANNING_METHODS = ['ORDERS', 'REORDER_POINT', 'MIN_MAX', 'MANUAL'] as const
export type ItemPlanningMethod = (typeof ITEM_PLANNING_METHODS)[number]
export const ITEM_PLANNING_SOURCES = ['BUY', 'MAKE'] as const
export type ItemPlanningSource = (typeof ITEM_PLANNING_SOURCES)[number]
/** The methods the "Reorder rules" grid lists. */
export const REORDER_METHODS = ['REORDER_POINT', 'MIN_MAX'] as const satisfies readonly ItemPlanningMethod[]

export const ITEM_PLANNING_LIMITS = Object.freeze({ days: { min: 0, max: 366 }, note: 500 })

export const LEAD_TIME_FIELDS = ['buyLeadTimeDays', 'makeLeadTimeDays', 'safetyLeadTimeDays'] as const
/** Quantities that may be 0 (a stock level) and those that must be above 0 (a size). */
export const STOCK_FIELDS = ['safetyStock', 'reorderPoint', 'minStock'] as const
export const SIZE_FIELDS = ['lotSize', 'maxStock', 'minOrderQty', 'orderMultiple', 'maxOrderQty'] as const
export const QUANTITY_FIELDS = [...STOCK_FIELDS, ...SIZE_FIELDS] as const
type LeadTimeField = (typeof LEAD_TIME_FIELDS)[number]
type QuantityField = (typeof QUANTITY_FIELDS)[number]

export interface ItemPlanningValues {
  readonly method: ItemPlanningMethod
  /** Null: the item's own sourcing. */
  readonly source: ItemPlanningSource | null
  readonly supplierId: string | null
  readonly makeSiteId: string | null
  readonly buyLeadTimeDays: number | null
  readonly makeLeadTimeDays: number | null
  readonly safetyLeadTimeDays: number | null
  /** Decimal strings in the item's base unit. */
  readonly safetyStock: string | null
  readonly reorderPoint: string | null
  readonly lotSize: string | null
  readonly minStock: string | null
  readonly maxStock: string | null
  readonly minOrderQty: string | null
  readonly orderMultiple: string | null
  readonly maxOrderQty: string | null
  readonly note: string | null
}

export const EMPTY_ITEM_PLANNING: ItemPlanningValues = Object.freeze({
  method: 'ORDERS',
  source: null,
  supplierId: null,
  makeSiteId: null,
  buyLeadTimeDays: null,
  makeLeadTimeDays: null,
  safetyLeadTimeDays: null,
  safetyStock: null,
  reorderPoint: null,
  lotSize: null,
  minStock: null,
  maxStock: null,
  minOrderQty: null,
  orderMultiple: null,
  maxOrderQty: null,
  note: null,
})

export type ItemPlanningPatch = { readonly [Key in keyof ItemPlanningValues]?: ItemPlanningValues[Key] | undefined }

/** The fields only one method carries. */
const METHOD_FIELDS: Readonly<Record<'REORDER_POINT' | 'MIN_MAX', readonly QuantityField[]>> = Object.freeze({ REORDER_POINT: ['reorderPoint', 'lotSize'], MIN_MAX: ['minStock', 'maxStock'] })

/**
 * The row after a change: the current values (or the empty row) with the fields the change names. A change of method
 * clears the old method's own fields it does not name (REORDER_POINT's reorder point and lot size, MIN_MAX's minimum
 * and maximum stock), and a change of source the supplier (from BUY) or make site (from MAKE): `cleared` lists them,
 * so the screen can say so. Nothing else is cleared without being named.
 */
export function mergeItemPlanning(current: ItemPlanningValues | null, patch: ItemPlanningPatch): { values: ItemPlanningValues; cleared: (keyof ItemPlanningValues)[] } {
  const base = current ?? EMPTY_ITEM_PLANNING
  const values: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) values[key] = value
  const cleared: (keyof ItemPlanningValues)[] = []
  const clear = (key: keyof ItemPlanningValues): void => {
    if (key in patch && patch[key] !== undefined) return
    if (values[key] !== null) cleared.push(key)
    values[key] = null
  }
  const method = values.method as ItemPlanningMethod
  for (const [owner, fields] of Object.entries(METHOD_FIELDS)) if (method !== owner && base.method === owner) fields.forEach(clear)
  const source = values.source as ItemPlanningSource | null
  if (source !== 'BUY' && base.source === 'BUY') clear('supplierId')
  if (source !== 'MAKE' && base.source === 'MAKE') clear('makeSiteId')
  return { values: values as unknown as ItemPlanningValues, cleared }
}

const DECIMAL = /^\d+(\.\d+)?$/
const isQuantity = (value: string): boolean => DECIMAL.test(value) && fitsDecimal(value, QUANTITY.precision, QUANTITY.scale)

const FIELD_WORDS: Readonly<Record<QuantityField | LeadTimeField, string>> = Object.freeze({
  safetyStock: 'The safety stock',
  reorderPoint: 'The reorder point',
  minStock: 'The minimum stock',
  lotSize: 'The lot size',
  maxStock: 'The maximum stock',
  minOrderQty: 'The order minimum',
  orderMultiple: 'The order step',
  maxOrderQty: 'The order maximum',
  buyLeadTimeDays: 'The buying lead time',
  makeLeadTimeDays: 'The making lead time',
  safetyLeadTimeDays: 'The safety time',
})

/** What is wrong with a row's values (empty when nothing is); `base` is the body's path. */
export function itemPlanningProblems(values: ItemPlanningValues, base = 'body'): Issue[] {
  const problems: Issue[] = []
  const at = (field: string, message: string) => problems.push({ path: `${base}/${field}`, message })
  if (!(ITEM_PLANNING_METHODS as readonly string[]).includes(values.method)) at('method', `Plan the item by ${ITEM_PLANNING_METHODS.join(', ')}.`)
  if (values.source !== null && !(ITEM_PLANNING_SOURCES as readonly string[]).includes(values.source)) at('source', 'The item is bought (BUY) or made (MAKE) here, or follows its own sourcing (none).')
  const { min, max } = ITEM_PLANNING_LIMITS.days
  for (const field of LEAD_TIME_FIELDS) {
    const value = values[field]
    if (value !== null && (!Number.isSafeInteger(value) || value < min || value > max)) at(field, `${FIELD_WORDS[field]} is ${min} to ${max} calendar days.`)
  }
  const amounts = new Map<QuantityField, Decimal>()
  for (const field of QUANTITY_FIELDS) {
    const value = values[field]
    if (value === null) continue
    if (!isQuantity(value)) {
      at(field, `${FIELD_WORDS[field]} is a quantity in the item's base unit, with at most four decimals.`)
      continue
    }
    const amount = new Dec(value)
    if ((SIZE_FIELDS as readonly string[]).includes(field) && amount.lte(0)) at(field, `${FIELD_WORDS[field]} is above 0.`)
    else amounts.set(field, amount)
  }
  const minStock = amounts.get('minStock')
  const maxStock = amounts.get('maxStock')
  if (minStock && maxStock && maxStock.lte(minStock)) at('maxStock', `The maximum stock (${values.maxStock}) is above the minimum (${values.minStock}).`)
  const minOrder = amounts.get('minOrderQty')
  const maxOrder = amounts.get('maxOrderQty')
  if (minOrder && maxOrder && maxOrder.lt(minOrder)) at('maxOrderQty', `The order maximum (${values.maxOrderQty}) is not below the order minimum (${values.minOrderQty}).`)
  const rop = values.method === 'REORDER_POINT'
  if (rop && values.reorderPoint === null) at('reorderPoint', 'A reorder-point rule needs the reorder point: the stock at which to order.')
  if (rop && values.lotSize === null) at('lotSize', 'A reorder-point rule needs the lot size: how much to order each time.')
  if (!rop && values.reorderPoint !== null) at('reorderPoint', 'A reorder point belongs to the reorder-point method; clear it or plan the item by REORDER_POINT.')
  if (!rop && values.lotSize !== null) at('lotSize', 'A lot size belongs to the reorder-point method; clear it or plan the item by REORDER_POINT.')
  const minMax = values.method === 'MIN_MAX'
  if (minMax && values.minStock === null) at('minStock', 'A min/max rule needs the minimum stock: below it, the plan orders.')
  if (minMax && values.maxStock === null) at('maxStock', 'A min/max rule needs the maximum stock: the plan orders up to it.')
  if (!minMax && values.minStock !== null) at('minStock', 'A minimum stock belongs to the min/max method; clear it or plan the item by MIN_MAX.')
  if (!minMax && values.maxStock !== null) at('maxStock', 'A maximum stock belongs to the min/max method; clear it or plan the item by MIN_MAX.')
  if (values.supplierId !== null && values.source !== 'BUY') at('supplierId', 'A preferred supplier goes with an item bought here (source BUY).')
  if (values.makeSiteId !== null && values.source !== 'MAKE') at('makeSiteId', 'A make site goes with an item made (source MAKE).')
  if (values.note !== null && values.note.length > ITEM_PLANNING_LIMITS.note) at('note', `A note has at most ${ITEM_PLANNING_LIMITS.note} characters.`)
  return problems
}

/** The row that plans an item's colour: the colour's own, else the one for every colour (null), else none. */
export function itemPlanningFor<Row extends { readonly itemColourId: string | null }>(rows: readonly Row[], itemColourId: string | null): Row | null {
  return (itemColourId !== null ? rows.find((row) => row.itemColourId === itemColourId) : undefined) ?? rows.find((row) => row.itemColourId === null) ?? null
}

const text = (value: Decimal): string => value.toFixed(4)

/**
 * The orders a need (base unit) becomes under a row's order rules: at least the minimum, in steps of the step (rounded
 * up, never less than the need), and none above the maximum: a need above it is split into orders of the maximum (each
 * kept in steps, so the step decides when they disagree) and the rest. A need of 0 or less orders nothing.
 */
export function orderQuantities(need: string, rules: Pick<ItemPlanningValues, 'minOrderQty' | 'orderMultiple' | 'maxOrderQty'>): string[] {
  let left = new Dec(need)
  if (left.lte(0)) return []
  const minimum = rules.minOrderQty === null ? null : new Dec(rules.minOrderQty)
  const step = rules.orderMultiple === null ? null : new Dec(rules.orderMultiple)
  let maximum = rules.maxOrderQty === null ? null : new Dec(rules.maxOrderQty)
  // The largest order in whole steps that the maximum allows (one step when the step itself is larger).
  if (maximum && step) maximum = Dec.max(step, maximum.div(step).floor().times(step))
  const shaped = (quantity: Decimal): Decimal => {
    let value = minimum && quantity.lt(minimum) ? minimum : quantity
    if (step) value = value.div(step).ceil().times(step)
    return value
  }
  const orders: string[] = []
  while (left.gt(0) && orders.length < 1000) {
    const order = maximum && left.gt(maximum) ? maximum : shaped(left)
    orders.push(text(order))
    left = left.minus(order)
  }
  return orders
}

/** The stock position a reorder rule reads, base unit: on hand (usable) + on order − reserved. */
export interface StockPosition {
  readonly onHand: string
  readonly onOrder: string
  readonly reserved: string
}

export interface ReorderNeed {
  readonly triggered: boolean
  /** The position: on hand + on order − reserved. */
  readonly position: string
  /** What to order (base unit, four decimals) before the order rules; 0 when not triggered. */
  readonly quantity: string
  /** Why, in words. */
  readonly words: string
}

/**
 * What a reorder rule asks for (PLN-099). REORDER_POINT: at or below the reorder point, as many lots as bring the
 * position above it (one at least). MIN_MAX: below the minimum, up to the maximum. Any other method: never.
 */
export function reorderNeed(values: Pick<ItemPlanningValues, 'method' | 'reorderPoint' | 'lotSize' | 'minStock' | 'maxStock'>, stock: StockPosition): ReorderNeed {
  const position = new Dec(stock.onHand).plus(stock.onOrder).minus(stock.reserved)
  const none = (words: string): ReorderNeed => ({ triggered: false, position: text(position), quantity: text(new Dec(0)), words })
  if (values.method === 'REORDER_POINT' && values.reorderPoint !== null && values.lotSize !== null) {
    const point = new Dec(values.reorderPoint)
    const lot = new Dec(values.lotSize)
    if (position.gt(point)) return none(`The stock position ${text(position)} is above the reorder point ${values.reorderPoint}: nothing to order.`)
    const lots = point.minus(position).div(lot).floor().plus(1)
    return { triggered: true, position: text(position), quantity: text(lots.times(lot)), words: `The stock position ${text(position)} is at or below the reorder point ${values.reorderPoint}: order ${lots.toFixed(0)} lot${lots.eq(1) ? '' : 's'} of ${values.lotSize}.` }
  }
  if (values.method === 'MIN_MAX' && values.minStock !== null && values.maxStock !== null) {
    if (position.gte(values.minStock)) return none(`The stock position ${text(position)} is not below the minimum ${values.minStock}: nothing to order.`)
    const quantity = new Dec(values.maxStock).minus(position)
    return { triggered: true, position: text(position), quantity: text(quantity), words: `The stock position ${text(position)} is below the minimum ${values.minStock}: order up to the maximum ${values.maxStock}.` }
  }
  return none('The item is not planned by a reorder rule.')
}
