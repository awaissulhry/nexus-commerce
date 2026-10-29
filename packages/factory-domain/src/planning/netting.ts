import type { Decimal } from 'decimal.js'
import type { BusinessDate } from '../core/time'
import type { LotQualityStatus } from '../inventory/stock/overview'
import { decimalOf, QUANTITY_SCALE, roundTo, type DecimalInput } from '../product/units/units'
import { usabilityOf, type CrViStatus, type NotCountedReason } from './usable'

/**
 * Netting one material in one colour (PLN-064, PLN-065; A2 SCR-055 "Why this number"), pure:
 *
 *   short = max(0, need − usable stock − on order)
 *
 * exactly the identity the …_supply_guards trigger checks on MaterialRequirement (net = max(0, gross − usable − on
 * order)), with:
 *
 *   need      the demands (one per order line and size, see ./explode): what the orders still need, less what is
 *             already issued to their work orders;
 *   usable    the site's stock of the material in THIS colour that the plan may use (./usable: a RELEASED lot, or stock
 *             without a lot). Held stock (quarantine, blocked) is summed apart and never netted; rejected stock and
 *             other colours are only listed;
 *   on order  what open purchase orders of the site still bring in this colour AND arrive in time: the demands are
 *             walked by due date, each takes usable stock first, then the open purchase lines due on or before its
 *             date (earliest first). A purchase line due after every short demand is "too late — not counted"; one the
 *             stock and earlier lines already cover is "not needed". `onOrder` is what the walk used, so the trigger's
 *             identity holds with the walk's shortage (whenever the walk leaves stock over, every demand was covered).
 *
 * Quantities are the item's base unit, four decimals, exact (decimal.js), never a float. A demand without a date is
 * needed on the run's day.
 */

export const QUANTITY_DIGITS = QUANTITY_SCALE
const DOWN = { scale: QUANTITY_SCALE, rounding: 'DOWN' } as const
const ZERO = decimalOf('0')
const q = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)
const min = (a: Decimal, b: Decimal): Decimal => (a.lt(b) ? a : b)

/**
 * The purchase order states whose open lines still bring goods: a DRAFT one too (ordered, not sent yet), and one whose
 * supplier proposed changes (B-W1-31: still on order at the quantity and need date asked until the buyer accepts them).
 */
export const OPEN_PURCHASE_STATUSES = ['DRAFT', 'SENT', 'CHANGES_PROPOSED', 'CONFIRMED', 'PARTLY_RECEIVED'] as const
export type OpenPurchaseStatus = (typeof OPEN_PURCHASE_STATUSES)[number]

/** What a purchase order line still brings, in the base unit: the confirmed quantity (else the ordered one) less what posted receipts brought. */
export function openQuantityOf(line: {
  /** As ordered, in the line's unit, and in the base unit. */
  readonly quantity: DecimalInput
  readonly baseQuantity: DecimalInput
  /** The supplier's confirmation, in the line's unit (0: cannot deliver); null: not confirmed. */
  readonly confirmedQuantity: DecimalInput | null
  /** What posted receipts against the line brought, in the base unit. */
  readonly received: DecimalInput
}): string {
  const ordered = decimalOf(line.baseQuantity)
  const asked = decimalOf(line.quantity)
  // A confirmation in the line's unit, in the base unit at the line's own ratio; rounded down: never expect more.
  const expected = line.confirmedQuantity === null || asked.lte(0) ? ordered : roundTo(ordered.times(decimalOf(line.confirmedQuantity)).div(asked), DOWN)
  const open = expected.minus(decimalOf(line.received))
  return q(open.isNegative() ? ZERO : open)
}

/** One demand on the material: an order line in one size (./explode RequirementSource). */
export interface Demand {
  readonly dueDate: BusinessDate | null
  /** What it still needs, base unit (its quantity less what its work orders already hold). */
  readonly quantity: DecimalInput
}

/** Stock of the material at the site, per lot (null: not traced by lot), any colour. */
export interface StockEntry {
  readonly itemColourId: string | null
  readonly lotId: string | null
  /** On hand at the site, base unit, above 0. */
  readonly quantity: DecimalInput
  /** Hides with stock (an item traced hide by hide); 0 otherwise. */
  readonly hides: number
}

/** What netting reads of a lot. */
export interface LotFacts {
  readonly id: string
  readonly qualityStatus: LotQualityStatus
  readonly requiresCrViTest: boolean
  readonly crViStatus: CrViStatus
}

/** An open purchase order line of the material in this colour, delivered to the site. */
export interface OpenPurchase {
  readonly purchaseOrderLineId: string
  readonly purchaseOrderNumber: string
  /** Still to come, base unit (openQuantityOf). */
  readonly openQuantity: DecimalInput
  /** When it is due at the site: the supplier's confirmed date, else the line's need date. */
  readonly dueDate: BusinessDate
}

export interface StockLine {
  readonly entry: StockEntry
  /** null: counted as usable. */
  readonly notCounted: NotCountedReason | null
  /** Summed in `held` (quarantine, blocked). */
  readonly held: boolean
}

export interface PurchaseLine {
  readonly line: OpenPurchase
  /** What the walk used of it (four decimals). */
  readonly counted: string
  /** What it did not use. */
  readonly notCounted: string
  /** Why some is not counted: it arrives after the short demands, or nothing needs it. null: all counted. */
  readonly why: 'TOO_LATE' | 'NOT_NEEDED' | null
}

export interface MaterialNetting {
  readonly gross: string
  readonly usable: string
  readonly held: string
  readonly onOrder: string
  readonly net: string
  /** The day the first demand is short (net above 0), else the first demand's day; the run's day without demands. */
  readonly needDate: BusinessDate
  readonly stock: readonly StockLine[]
  readonly purchases: readonly PurchaseLine[]
}

const dayOf = (demand: Demand, runDate: BusinessDate): BusinessDate => demand.dueDate ?? runDate

/** Nets one material in one colour (`itemColourId`; null: a material without colours). */
export function netMaterial(input: {
  readonly itemColourId: string | null
  readonly demands: readonly Demand[]
  readonly stock: readonly StockEntry[]
  readonly lotOf: (lotId: string) => LotFacts | undefined
  readonly purchases: readonly OpenPurchase[]
  readonly runDate: BusinessDate
}): MaterialNetting {
  const { runDate } = input
  const stock: StockLine[] = input.stock
    .filter((entry) => decimalOf(entry.quantity).gt(0))
    .map((entry) => {
      if (entry.itemColourId !== input.itemColourId) return { entry, notCounted: 'OTHER_COLOUR' as const, held: false }
      const usability = usabilityOf(entry.lotId ? (input.lotOf(entry.lotId) ?? { qualityStatus: 'QUARANTINE', requiresCrViTest: false, crViStatus: 'NOT_REQUIRED' }) : null)
      return usability.usable ? { entry, notCounted: null, held: false } : { entry, notCounted: usability.reason, held: usability.held }
    })
  const usable = stock.filter((line) => line.notCounted === null).reduce((sum, line) => sum.plus(decimalOf(line.entry.quantity)), ZERO)
  const held = stock.filter((line) => line.held).reduce((sum, line) => sum.plus(decimalOf(line.entry.quantity)), ZERO)

  const demands = input.demands
    .map((demand, index) => ({ day: dayOf(demand, runDate), quantity: decimalOf(demand.quantity), index }))
    .filter((demand) => demand.quantity.gt(0))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.index - b.index))
  const gross = demands.reduce((sum, demand) => sum.plus(demand.quantity), ZERO)

  const lines = input.purchases
    .map((line, index) => ({ line, left: decimalOf(line.openQuantity), index }))
    .filter((entry) => entry.left.gt(0))
    .sort((a, b) =>
      a.line.dueDate !== b.line.dueDate
        ? a.line.dueDate < b.line.dueDate
          ? -1
          : 1
        : a.line.purchaseOrderNumber !== b.line.purchaseOrderNumber
          ? a.line.purchaseOrderNumber < b.line.purchaseOrderNumber
            ? -1
            : 1
          : a.index - b.index,
    )
  const opened = new Map(lines.map((entry) => [entry, entry.left]))

  let stockLeft = usable
  let short = ZERO
  let firstShort: BusinessDate | null = null
  for (const demand of demands) {
    let need = demand.quantity
    const fromStock = min(stockLeft, need)
    stockLeft = stockLeft.minus(fromStock)
    need = need.minus(fromStock)
    for (const entry of lines) {
      if (need.isZero()) break
      if (entry.line.dueDate > demand.day || entry.left.isZero()) continue
      const take = min(entry.left, need)
      entry.left = entry.left.minus(take)
      need = need.minus(take)
    }
    if (need.gt(0)) {
      short = short.plus(need)
      firstShort ??= demand.day
    }
  }
  const onOrder = lines.reduce((sum, entry) => sum.plus(opened.get(entry)!.minus(entry.left)), ZERO)
  const formula = gross.minus(usable).minus(onOrder)
  const net = formula.isNegative() ? ZERO : formula
  // The walk and the trigger's identity agree by construction; a difference is a bug, never a plan.
  if (!net.eq(short)) throw new Error(`netting walk ${q(short)} differs from max(0, gross - usable - on order) ${q(net)}`)

  const purchases: PurchaseLine[] = lines.map((entry) => {
    const open = opened.get(entry)!
    const counted = open.minus(entry.left)
    return {
      line: entry.line,
      counted: q(counted),
      notCounted: q(entry.left),
      why: entry.left.isZero() ? null : net.gt(0) ? 'TOO_LATE' : 'NOT_NEEDED',
    }
  })
  return {
    gross: q(gross),
    usable: q(usable),
    held: q(held),
    onOrder: q(onOrder),
    net: q(net),
    needDate: firstShort ?? demands[0]?.day ?? runDate,
    stock,
    purchases,
  }
}
