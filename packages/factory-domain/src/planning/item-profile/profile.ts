import type { Decimal } from 'decimal.js'
import type { BusinessDate } from '../../core/time'
import { decimalOf, QUANTITY_SCALE } from '../../product/units/units'
import { bucketKeyOf, demandHorizon, LATER, PAST } from '../demand/rules'

/**
 * The item's requirement profile (B-W2b-318; PLN-084; design planning.mrp pop-up "Projected stock — <material>"), pure:
 * one material in one colour, week by week from this week's Monday, as the plan sees it now.
 *
 *   on hand      the usable stock the plan counts for it (free stock and what its own reservations hold: planning/mrp/net)
 *   demand       what its orders still need (less what is issued to their work orders), on the day each needs it
 *   receipts     open purchase order lines on their due day (all of them, also those the netting could not count in time)
 *                and the firm planned order on its date
 *   planned      the plan's orders still to place, by lot sizing (../lot-sizing/lots), on the day each is needed
 *   projected    on hand + receipts − demand, cumulative (what the stock will be if nothing more is ordered); with the
 *                plan: + planned as well
 *   atp          available to promise in the week: on hand (the first row) and the week's receipts less its demand, a
 *                shortfall taken from the weeks before (what can still be promised then without taking what later
 *                orders need); a first row below 0 means the orders already take more than what is coming
 *
 * Days before this week are one row PAST (late demand, overdue receipts), days after the horizon one row LATER. Each row
 * names what is in it (the screen links each cell to its orders). Quantities in the base unit, four decimals. No money.
 */

export interface ProfileDemandRef {
  readonly orderId: string
  readonly orderNumber: string
  readonly orderLineId: string
  readonly lineSeq: number
  readonly size: string | null
  readonly workOrderId: string | null
  readonly workOrderNumber: string | null
  /** The order's backlog rank (PLN-088); null: not ranked. */
  readonly rank: number | null
}

export interface ProfileDemand {
  readonly day: BusinessDate
  readonly quantity: string
  readonly ref: ProfileDemandRef
}

export interface ProfileReceipt {
  readonly kind: 'PURCHASE_ORDER' | 'FIRM'
  readonly day: BusinessDate
  readonly quantity: string
  /** PURCHASE_ORDER: the line, its order's number and the line's seq. */
  readonly purchaseOrderLineId?: string
  readonly purchaseOrderId?: string
  readonly purchaseOrderNumber?: string
  readonly lineSeq?: number
  /** FIRM: the line of the latest plan it is carried on. */
  readonly requirementId?: string
}

export interface ProfilePlanned {
  readonly seq: number
  readonly day: BusinessDate
  readonly quantity: string
}

export interface ProfileRow {
  /** An ISO week (2026-W47), PAST or LATER. */
  readonly key: string
  readonly from: BusinessDate | null
  readonly to: BusinessDate | null
  readonly demand: string
  readonly receipts: string
  readonly planned: string
  readonly projected: string
  readonly projectedWithPlan: string
  readonly atp: string
  /** The projected stock (without the plan) is below 0 / below the safety stock at the row's end. */
  readonly short: boolean
  readonly belowSafety: boolean
  readonly demandRefs: readonly (ProfileDemandRef & { readonly quantity: string; readonly day: BusinessDate })[]
  readonly receiptRefs: readonly ProfileReceipt[]
  readonly plannedRefs: readonly ProfilePlanned[]
}

export interface ItemProfile {
  readonly from: BusinessDate
  readonly to: BusinessDate
  readonly weeks: number
  readonly onHand: string
  readonly safetyStock: string | null
  readonly totals: { readonly demand: string; readonly receipts: string; readonly planned: string }
  readonly rows: readonly ProfileRow[]
  /** The first row whose projected stock (without the plan) falls below 0, and below the safety stock. */
  readonly firstShort: string | null
  readonly firstBelowSafety: string | null
}

const ZERO = decimalOf('0')
const q = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)
const sumOf = (values: readonly string[]): Decimal => values.reduce((sum, value) => sum.plus(decimalOf(value)), ZERO)

export function itemProfile(input: {
  readonly today: BusinessDate
  readonly weeks: number
  readonly onHand: string
  readonly safetyStock: string | null
  readonly demand: readonly ProfileDemand[]
  readonly receipts: readonly ProfileReceipt[]
  readonly planned: readonly ProfilePlanned[]
}): ItemProfile {
  const horizon = demandHorizon(input.today, input.weeks, 'WEEK')
  const keyOf = (day: BusinessDate) => bucketKeyOf(horizon, day)
  const used = new Set([...input.demand.map((entry) => keyOf(entry.day)), ...input.receipts.map((entry) => keyOf(entry.day)), ...input.planned.map((entry) => keyOf(entry.day))])
  const frames: { key: string; from: BusinessDate | null; to: BusinessDate | null }[] = [
    ...(used.has(PAST) ? [{ key: PAST, from: null, to: null }] : []),
    ...horizon.buckets.map((bucket) => ({ key: bucket.key, from: bucket.from, to: bucket.to })),
    ...(used.has(LATER) ? [{ key: LATER, from: null, to: null }] : []),
  ]
  const safety = input.safetyStock === null ? null : decimalOf(input.safetyStock)
  let projected = decimalOf(input.onHand)
  let withPlan = projected
  let firstShort: string | null = null
  let firstBelowSafety: string | null = null
  const drafts = frames.map((frame, index) => {
    const demandIn = input.demand.filter((entry) => keyOf(entry.day) === frame.key)
    const receiptsIn = input.receipts.filter((entry) => keyOf(entry.day) === frame.key)
    const plannedIn = input.planned.filter((entry) => keyOf(entry.day) === frame.key)
    const demand = sumOf(demandIn.map((entry) => entry.quantity))
    const receipts = sumOf(receiptsIn.map((entry) => entry.quantity))
    const planned = sumOf(plannedIn.map((entry) => entry.quantity))
    projected = projected.plus(receipts).minus(demand)
    withPlan = withPlan.plus(receipts).plus(planned).minus(demand)
    const short = projected.lt(0)
    const belowSafety = safety !== null && projected.lt(safety)
    if (short) firstShort ??= frame.key
    if (belowSafety) firstBelowSafety ??= frame.key
    // Demand per part of an order line (summed), in day order.
    const refs = new Map<string, ProfileDemandRef & { quantity: Decimal; day: BusinessDate }>()
    for (const entry of [...demandIn].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
      const key = [entry.ref.orderLineId, entry.ref.size ?? '-', entry.ref.workOrderId ?? '-', entry.day].join('|')
      const found = refs.get(key)
      if (found) found.quantity = found.quantity.plus(decimalOf(entry.quantity))
      else refs.set(key, { ...entry.ref, quantity: decimalOf(entry.quantity), day: entry.day })
    }
    return {
      frame,
      atpBase: receipts.minus(demand).plus(index === 0 ? decimalOf(input.onHand) : ZERO),
      row: {
        key: frame.key,
        from: frame.from,
        to: frame.to,
        demand: q(demand),
        receipts: q(receipts),
        planned: q(planned),
        projected: q(projected),
        projectedWithPlan: q(withPlan),
        short,
        belowSafety,
        demandRefs: [...refs.values()].map((ref) => ({ ...ref, quantity: q(ref.quantity) })),
        receiptRefs: [...receiptsIn].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
        plannedRefs: plannedIn,
      },
    }
  })
  // Available to promise: a week's shortfall is taken from the weeks before it.
  const atp = drafts.map((draft) => draft.atpBase)
  for (let index = atp.length - 1; index > 0; index -= 1) {
    if (atp[index]!.lt(0)) {
      atp[index - 1] = atp[index - 1]!.plus(atp[index]!)
      atp[index] = ZERO
    }
  }
  return {
    from: horizon.from,
    to: horizon.to,
    weeks: horizon.weeks,
    onHand: q(decimalOf(input.onHand)),
    safetyStock: safety === null ? null : q(safety),
    totals: { demand: q(sumOf(input.demand.map((entry) => entry.quantity))), receipts: q(sumOf(input.receipts.map((entry) => entry.quantity))), planned: q(sumOf(input.planned.map((entry) => entry.quantity))) },
    rows: drafts.map((draft, index) => ({ ...draft.row, atp: q(atp[index]!) })),
    firstShort,
    firstBelowSafety,
  }
}
