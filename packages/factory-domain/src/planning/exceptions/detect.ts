import type { Decimal } from 'decimal.js'
import { daysFrom } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { decimalOf, QUANTITY_SCALE, type Uom } from '../../product/units/units'
import { addDays } from '../buy'
import type { MaterialPegging } from '../mrp/net'

/**
 * The exception list of a planning run (B-W2a-22; PLN-193 "exception list per MRP run"; design planning.exceptions
 * "what the last planning run could not solve"), pure: what the run found, one condition per thing to act on, each with
 * a key the next run finds again (`<KIND>:<id>[:<more>]`), its facts as decimal strings and dates (never a cost, never a
 * person), the orders it touches and how many days the latest is late.
 *
 *   SHORT               a material still short after stock, reservations, purchase orders and the firm planned order:
 *                       nothing is ordered for it yet (per material and colour; a MAKE line apart)
 *   SUPPLY_LATE         an open purchase order line that arrives after the need it would cover, or is past its date and
 *                       not received (per purchase order line)
 *   PAST_DUE            an order line past its date that still needs material (per order line)
 *   EXCESS, CANCEL      an open purchase order line, or the firm planned order, the plan needs only in part (EXCESS) or
 *                       not at all (CANCEL); not for a material kept in stock by a reorder point, min/max or safety stock
 *   MOVE_EARLIER        the firm planned order is dated after a need it covers
 *   BELOW_SAFETY_STOCK  the material's projected stock falls below its safety stock (the site's item parameters)
 *   NEGATIVE_STOCK      more is reserved for the plan's work orders and order lines than usable stock holds
 *   LANE_OVERLOADED     a line or work centre is booked above its capacity in a week of the next four (B-W2a-16)
 *
 * Not evaluated in W2a (their thresholds are PLN-194, W3): LANE_UNDERUSED, MOVE_LATER. The run clears only the kinds it
 * evaluates (EVALUATED_KINDS), so another step's kinds are never cleared by it.
 */

export const EXCEPTION_KINDS = [
  'SHORT',
  'SUPPLY_LATE',
  'LANE_OVERLOADED',
  'LANE_UNDERUSED',
  'PAST_DUE',
  'EXCESS',
  'BELOW_SAFETY_STOCK',
  'MOVE_EARLIER',
  'MOVE_LATER',
  'CANCEL',
  'NEGATIVE_STOCK',
] as const
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number]

export const EVALUATED_KINDS: readonly ExceptionKind[] = Object.freeze(['SHORT', 'SUPPLY_LATE', 'PAST_DUE', 'EXCESS', 'CANCEL', 'MOVE_EARLIER', 'BELOW_SAFETY_STOCK', 'NEGATIVE_STOCK', 'LANE_OVERLOADED'])

export const EXCEPTION_LABELS: Readonly<Record<ExceptionKind, string>> = Object.freeze({
  SHORT: 'Short',
  SUPPLY_LATE: 'Supply too late',
  LANE_OVERLOADED: 'Lane overloaded',
  LANE_UNDERUSED: 'Lane underused',
  PAST_DUE: 'Past due',
  EXCESS: 'Excess',
  BELOW_SAFETY_STOCK: 'Below safety stock',
  MOVE_EARLIER: 'Move earlier',
  MOVE_LATER: 'Move later',
  CANCEL: 'Cancel',
  NEGATIVE_STOCK: 'Negative stock',
})

export type FactValue = string | number | boolean | null
export type Facts = Readonly<Record<string, FactValue>>

/** One condition the run found. */
export interface ExceptionCondition {
  readonly kind: ExceptionKind
  readonly key: string
  readonly itemId: string | null
  readonly itemColourId: string | null
  /** The run's requirement it comes from (its seq in the run); null: none. */
  readonly requirementSeq: number | null
  /** The record it is about, set when first found ("SalesOrderLine", "WorkOrder", "PurchaseOrder", "Line", "WorkCentre"). */
  readonly record: { readonly type: string; readonly id: string } | null
  readonly facts: Facts
  readonly ordersAffected: number
  readonly daysLate: number | null
  /** The condition in one sentence (built from the facts; the screens say it in their language from the facts). */
  readonly sentence: string
}

/** One requirement of the run with what detection reads of it. */
export interface DetectMaterial {
  readonly seq: number
  readonly itemId: string
  readonly itemColourId: string | null
  readonly action: 'BUY' | 'MAKE'
  readonly label: string
  readonly uom: Uom
  readonly pegging: MaterialPegging
  /** The lead time a buy or make takes from today (days); null: none on record. */
  readonly leadTimeDays: number | null
  /** The site keeps the material in stock: a reorder point, min/max or a safety stock above 0. */
  readonly keptInStock: boolean
  /** The site's safety stock for it (base unit); null: none. */
  readonly safetyStock: string | null
}

/** A material with a safety stock that the run has no demand for, with its stock and arrivals. */
export interface SafetyOnly {
  readonly itemId: string
  readonly itemColourId: string | null
  readonly label: string
  readonly uom: Uom
  readonly safetyStock: string
  readonly usable: string
  readonly arrivals: readonly { readonly date: BusinessDate; readonly quantity: string }[]
}

export interface LaneOverload {
  readonly laneKind: 'LINE' | 'WORK_CENTRE'
  readonly laneId: string
  readonly laneCode: string
  readonly bucketKey: string
  readonly from: BusinessDate
  readonly to: BusinessDate
  readonly loadPct: string
  readonly availableMinutes: string
  readonly bookedMinutes: string
}

export interface DetectInput {
  readonly runDate: BusinessDate
  readonly materials: readonly DetectMaterial[]
  /** Facts of the open purchase order lines the materials count on. */
  readonly purchaseOf: (purchaseOrderLineId: string) => { readonly purchaseOrderId: string; readonly purchaseOrderNumber: string } | undefined
  readonly safetyOnly?: readonly SafetyOnly[]
  readonly overloads?: readonly LaneOverload[]
}

const ZERO = decimalOf('0')
const q = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)
const n = (value: Decimal | string): string => decimalOf(value).toFixed()
const refOf = (itemId: string, itemColourId: string | null): string => itemColourId ?? itemId

/** Everything the run found, in a stable order (kind, then key). */
export function detectExceptions(input: DetectInput): ExceptionCondition[] {
  const found: ExceptionCondition[] = []
  const { runDate } = input
  const pastDue = new Map<string, { orderNumber: string; lineSeq: number; dueDate: BusinessDate; orderId: string }>()
  for (const material of input.materials) {
    const { pegging } = material
    const ref = refOf(material.itemId, material.itemColourId)
    const base = { itemId: material.itemId, itemColourId: material.itemColourId, requirementSeq: material.seq }
    const w = (value: Decimal | string) => `${n(value)} ${material.uom}`
    const walked = pegging.coverage.filter((coverage) => decimalOf(coverage.part.quantity).minus(decimalOf(coverage.part.issued)).gt(0))

    // SHORT: still short after everything, nothing ordered.
    const uncovered = walked.filter((coverage) => decimalOf(coverage.uncovered).gt(0))
    if (uncovered.length > 0) {
      const first = uncovered[0]!
      const quantity = uncovered.reduce((sum, coverage) => sum.plus(decimalOf(coverage.uncovered)), ZERO)
      const orders = new Set(uncovered.map((coverage) => coverage.part.orderId))
      const arrival = material.leadTimeDays === null ? null : addDays(runDate, material.leadTimeDays)
      const daysLate = arrival !== null && arrival > first.day ? daysFrom(first.day, arrival) : arrival === null ? null : 0
      found.push({
        ...base,
        kind: 'SHORT',
        key: `SHORT:${ref}${material.action === 'MAKE' ? ':MAKE' : ''}`,
        record: first.part.workOrderId ? { type: 'WorkOrder', id: first.part.workOrderId } : { type: 'SalesOrderLine', id: first.part.orderLineId },
        facts: { action: material.action, quantity: q(quantity), uom: material.uom, needDate: first.day, orderNumber: first.part.orderNumber, workOrderNumber: first.part.workOrderNumber, earliestArrival: arrival },
        ordersAffected: orders.size,
        daysLate,
        sentence: `${material.label}: ${w(quantity)} short for ${orders.size === 1 ? first.part.orderNumber : `${orders.size} orders`}, needed ${first.day}; nothing is ordered for it yet.${daysLate ? ` Ordered today it would be ${daysLate} days late.` : ''}`,
      })
    }

    // SUPPLY_LATE: purchase lines that come after the need, or past their date.
    for (const purchase of pegging.purchases) {
      const facts = input.purchaseOf(purchase.line.purchaseOrderLineId)
      const record = facts ? { type: 'PurchaseOrder', id: facts.purchaseOrderId } : null
      const number = facts?.purchaseOrderNumber ?? purchase.line.purchaseOrderNumber
      if (purchase.why === 'TOO_LATE' && decimalOf(purchase.notCounted).gt(0)) {
        const waiting = walked.filter((coverage) => decimalOf(coverage.short).gt(0) && coverage.day < purchase.line.dueDate)
        if (waiting.length === 0) continue
        const neededBy = waiting[0]!.day
        const daysLate = daysFrom(neededBy, purchase.line.dueDate)
        found.push({
          ...base,
          kind: 'SUPPLY_LATE',
          key: `SUPPLY_LATE:${purchase.line.purchaseOrderLineId}`,
          record,
          facts: { purchaseOrderNumber: number, supplyDate: purchase.line.dueDate, needDate: neededBy, quantity: purchase.notCounted, uom: material.uom, overdue: false },
          ordersAffected: new Set(waiting.map((coverage) => coverage.part.orderId)).size,
          daysLate,
          sentence: `${material.label}: ${number} arrives ${purchase.line.dueDate}; it is needed ${neededBy} (${daysLate} days late).`,
        })
      } else if (decimalOf(purchase.counted).gt(0) && purchase.line.dueDate < runDate) {
        const relying = walked.filter((coverage) => coverage.supplies.some((supply) => supply.purchaseOrderLineId === purchase.line.purchaseOrderLineId))
        const daysLate = daysFrom(purchase.line.dueDate, runDate)
        found.push({
          ...base,
          kind: 'SUPPLY_LATE',
          key: `SUPPLY_LATE:${purchase.line.purchaseOrderLineId}`,
          record,
          facts: { purchaseOrderNumber: number, supplyDate: purchase.line.dueDate, needDate: relying[0]?.day ?? null, quantity: purchase.counted, uom: material.uom, overdue: true },
          ordersAffected: new Set(relying.map((coverage) => coverage.part.orderId)).size,
          daysLate,
          sentence: `${material.label}: ${number} was due ${purchase.line.dueDate} and ${w(purchase.counted)} of it is not received yet.`,
        })
      }
    }

    // EXCESS, CANCEL: supply the plan does not need (not for stock kept by a rule).
    if (!material.keptInStock) {
      for (const purchase of pegging.purchases) {
        if (purchase.why !== 'NOT_NEEDED' || !decimalOf(purchase.notCounted).gt(0)) continue
        const facts = input.purchaseOf(purchase.line.purchaseOrderLineId)
        const number = facts?.purchaseOrderNumber ?? purchase.line.purchaseOrderNumber
        const none = decimalOf(purchase.counted).isZero()
        found.push({
          ...base,
          kind: none ? 'CANCEL' : 'EXCESS',
          key: `${none ? 'CANCEL' : 'EXCESS'}:${purchase.line.purchaseOrderLineId}`,
          record: facts ? { type: 'PurchaseOrder', id: facts.purchaseOrderId } : null,
          facts: { purchaseOrderNumber: number, supplyDate: purchase.line.dueDate, quantity: purchase.notCounted, uom: material.uom, needed: purchase.counted },
          ordersAffected: 0,
          daysLate: null,
          sentence: none ? `${material.label}: no order needs ${number}'s ${w(purchase.notCounted)} any more.` : `${material.label}: ${w(purchase.notCounted)} of ${number} is more than the orders need.`,
        })
      }
      const firm = pegging.firm
      if (firm && decimalOf(firm.unused).gt(0)) {
        const none = decimalOf(firm.inTime).plus(decimalOf(firm.late)).isZero()
        found.push({
          ...base,
          kind: none ? 'CANCEL' : 'EXCESS',
          key: `${none ? 'CANCEL' : 'EXCESS'}:${ref}${material.action === 'MAKE' ? ':MAKE' : ''}`,
          record: null,
          facts: { firm: true, supplyDate: firm.date, quantity: firm.unused, uom: material.uom, needed: q(decimalOf(firm.inTime).plus(decimalOf(firm.late))) },
          ordersAffected: 0,
          daysLate: null,
          sentence: none ? `${material.label}: no order needs the firm planned order of ${w(firm.baseQuantity)} any more.` : `${material.label}: ${w(firm.unused)} of the firm planned order is more than the orders need.`,
        })
      }
    }

    // MOVE_EARLIER: the firm planned order comes after a need it covers.
    if (pegging.firm && decimalOf(pegging.firm.late).gt(0) && pegging.firm.firstLateDay) {
      const firm = pegging.firm
      const lateFor = walked.filter((coverage) => coverage.supplies.some((supply) => supply.kind === 'FIRM' && supply.late))
      const daysLate = daysFrom(firm.firstLateDay!, firm.date)
      found.push({
        ...base,
        kind: 'MOVE_EARLIER',
        key: `MOVE_EARLIER:${ref}${material.action === 'MAKE' ? ':MAKE' : ''}`,
        record: null,
        facts: { firm: true, supplyDate: firm.date, needDate: firm.firstLateDay, quantity: firm.late, uom: material.uom },
        ordersAffected: new Set(lateFor.map((coverage) => coverage.part.orderId)).size,
        daysLate,
        sentence: `${material.label}: the firm planned order is dated ${firm.date}; ${w(firm.late)} of it is needed from ${firm.firstLateDay}. Move it ${daysLate} days earlier.`,
      })
    }

    // BELOW_SAFETY_STOCK: the projected stock dips below the safety stock (only when nothing is short: SHORT says it).
    if (material.safetyStock !== null && decimalOf(material.safetyStock).gt(0) && uncovered.length === 0) {
      const arrivals = [
        ...pegging.purchases.map((purchase) => ({ date: purchase.line.dueDate, quantity: decimalOf(purchase.line.openQuantity) })),
        ...(pegging.firm ? [{ date: pegging.firm.date, quantity: decimalOf(pegging.firm.baseQuantity) }] : []),
      ]
      const needs = walked.map((coverage) => ({ date: coverage.day, quantity: decimalOf(coverage.part.quantity).minus(decimalOf(coverage.part.issued)) }))
      const dip = projectedDip(decimalOf(pegging.usable), arrivals, needs, decimalOf(material.safetyStock), runDate)
      if (dip) found.push(safetyCondition(base, ref, material.label, material.uom, material.safetyStock, dip))
    }
  }

  // NEGATIVE_STOCK: what reservations of the plan's demand hold beyond the usable stock that backs them.
  for (const material of input.materials) {
    const missing = reservedBeyondStock(material.pegging)
    if (!missing.gt(0)) continue
    found.push({
      itemId: material.itemId,
      itemColourId: material.itemColourId,
      requirementSeq: material.seq,
      kind: 'NEGATIVE_STOCK',
      key: `NEGATIVE_STOCK:${refOf(material.itemId, material.itemColourId)}`,
      record: null,
      facts: { quantity: q(missing), uom: material.uom },
      ordersAffected: 0,
      daysLate: null,
      sentence: `${material.label}: ${n(missing)} ${material.uom} more is reserved than the usable stock holds (a receipt not posted, or stock moved since).`,
    })
  }

  // PAST_DUE: order lines past their date that still need material.
  for (const material of input.materials) {
    for (const coverage of material.pegging.coverage) {
      const { part } = coverage
      if (part.dueDate === null || part.dueDate >= runDate) continue
      if (!decimalOf(part.quantity).minus(decimalOf(part.issued)).gt(0)) continue
      pastDue.set(part.orderLineId, { orderNumber: part.orderNumber, lineSeq: part.lineSeq, dueDate: part.dueDate, orderId: part.orderId })
    }
  }
  for (const [orderLineId, line] of pastDue) {
    const daysLate = daysFrom(line.dueDate, runDate)
    found.push({
      kind: 'PAST_DUE',
      key: `PAST_DUE:${orderLineId}`,
      itemId: null,
      itemColourId: null,
      requirementSeq: null,
      record: { type: 'SalesOrderLine', id: orderLineId },
      facts: { orderNumber: line.orderNumber, lineSeq: line.lineSeq, dueDate: line.dueDate },
      ordersAffected: 1,
      daysLate,
      sentence: `${line.orderNumber} line ${line.lineSeq} was due ${line.dueDate} (${daysLate} days ago) and still needs material.`,
    })
  }

  for (const material of input.safetyOnly ?? []) {
    const ref = refOf(material.itemId, material.itemColourId)
    const dip = projectedDip(
      decimalOf(material.usable),
      material.arrivals.map((arrival) => ({ date: arrival.date, quantity: decimalOf(arrival.quantity) })),
      [],
      decimalOf(material.safetyStock),
      runDate,
    )
    if (dip) found.push(safetyCondition({ itemId: material.itemId, itemColourId: material.itemColourId, requirementSeq: null }, ref, material.label, material.uom, material.safetyStock, dip))
  }

  for (const lane of input.overloads ?? []) {
    found.push({
      kind: 'LANE_OVERLOADED',
      key: `LANE_OVERLOADED:${lane.laneId}:${lane.bucketKey}`,
      itemId: null,
      itemColourId: null,
      requirementSeq: null,
      record: { type: lane.laneKind === 'LINE' ? 'Line' : 'WorkCentre', id: lane.laneId },
      facts: { laneKind: lane.laneKind, laneCode: lane.laneCode, bucket: lane.bucketKey, from: lane.from, to: lane.to, loadPct: lane.loadPct, availableMinutes: lane.availableMinutes, bookedMinutes: lane.bookedMinutes },
      ordersAffected: 0,
      daysLate: null,
      sentence: `${lane.laneCode} is booked ${lane.loadPct} % in ${lane.bucketKey} (${lane.bookedMinutes} of ${lane.availableMinutes} minutes).`,
    })
  }

  const order = new Map(EXCEPTION_KINDS.map((kind, index) => [kind, index]))
  const unique = new Map<string, ExceptionCondition>()
  for (const condition of found) if (!unique.has(condition.key)) unique.set(condition.key, condition)
  return [...unique.values()].sort((a, b) => order.get(a.kind)! - order.get(b.kind)! || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** What the plan's reservations hold beyond the usable stock that backs them (a reservation of stock that is gone). */
function reservedBeyondStock(pegging: MaterialPegging): Decimal {
  return pegging.reservations.filter((use) => use.forPlan).reduce((sum, use) => sum.plus(decimalOf(use.open).minus(decimalOf(use.backed))), ZERO)
}

/** The first day the projected stock is below the safety stock: the balance walked by day (arrivals first). */
function projectedDip(start: Decimal, arrivals: readonly { date: BusinessDate; quantity: Decimal }[], needs: readonly { date: BusinessDate; quantity: Decimal }[], safety: Decimal, runDate: BusinessDate): { date: BusinessDate; projected: Decimal } | null {
  if (start.lt(safety)) return { date: runDate, projected: start }
  const days = [...new Set([...arrivals.map((entry) => entry.date), ...needs.map((entry) => entry.date)])].sort()
  let balance = start
  for (const day of days) {
    for (const arrival of arrivals) if (arrival.date === day) balance = balance.plus(arrival.quantity)
    for (const need of needs) if (need.date === day) balance = balance.minus(need.quantity)
    if (balance.lt(safety)) return { date: day < runDate ? runDate : day, projected: balance }
  }
  return null
}

function safetyCondition(base: { itemId: string; itemColourId: string | null; requirementSeq: number | null }, ref: string, label: string, uom: Uom, safetyStock: string, dip: { date: BusinessDate; projected: Decimal }): ExceptionCondition {
  return {
    ...base,
    kind: 'BELOW_SAFETY_STOCK',
    key: `BELOW_SAFETY_STOCK:${ref}`,
    record: null,
    facts: { safetyStock: q(decimalOf(safetyStock)), projected: q(dip.projected), uom, date: dip.date },
    ordersAffected: 0,
    daysLate: null,
    sentence: `${label}: the stock falls to ${n(dip.projected)} ${uom} on ${dip.date}, below its safety stock of ${n(safetyStock)} ${uom}.`,
  }
}
