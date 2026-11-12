import type { Issue } from '../../core/errors'
import { isBusinessDate } from '../../core/time'
import { QUANTITY_SCALE } from '../../product/units/units'
import { Dec, parseDecimal, type Decimal } from '../../tax/decimal'
import type { DepthCheck } from './codes'

/**
 * A delivery schedule per purchase order line (B-W2b-296; SCM-052; design purchasing.orders record tab "Delivery schedule";
 * factory-db buying-depth.prisma PurchaseOrderLineDelivery), pure. apps/factory-api's modules/purchasing/po-depth writes it
 * through command(); the …_buying_depth_w2b_guards triggers hold the same rules for every login.
 *
 *   split      a line of a DRAFT order is split into 2 to MAX_DELIVERIES deliveries, each a day asked (today or later, one
 *              delivery per day) and a quantity in the line's unit (above 0, four places); together they are the line's
 *              quantity exactly. The schedule is written whole (it replaces the one before); none = one delivery on the
 *              line's need date.
 *   base       each delivery's base quantity is its share of the line's base quantity (four places, rounded down), the
 *              last one taking the rest, so the deliveries add up to the line in both units (planning and receipts count
 *              in the base unit).
 *   order      the deliveries are numbered 1, 2, 3 … by their day; the first one's day is the line's need date (the line
 *              moves to it: the day the material must first be at the site).
 *   send       a schedule that no longer adds up to its line, or a delivery asked for a past day, stops the send.
 *
 * The confirmed day of each delivery is the supplier's (./dates.ts): kept apart from the day asked, never overwriting it.
 */

/** At most this many deliveries per line (a weekly call-off over a year). */
export const MAX_DELIVERIES = 52
/** A delivery's note, printed for the supplier. */
export const MAX_DELIVERY_NOTE = 2000

export interface DeliveryInput {
  readonly quantity: string
  readonly needDate: string
  readonly note?: string | null | undefined
}

export interface ScheduledLine {
  readonly seq: number
  readonly quantity: string
  readonly baseQuantity: string
}

export interface PlannedDelivery {
  readonly seq: number
  readonly quantity: string
  readonly baseQuantity: string
  readonly needDate: string
  readonly note: string | null
}

const fixed = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)
const plain = (value: string): string => new Dec(value).toString()
const noteOf = (note: string | null | undefined): string | null => (note === undefined || note === null || note.trim() === '' ? null : note.trim())

/** A quantity in a line's unit: a plain decimal above 0 with at most four places. */
function quantityOf(value: string): Decimal | null {
  const parsed = parseDecimal(value)
  if (parsed === null || !parsed.greaterThan(0) || parsed.decimalPlaces() > QUANTITY_SCALE || parsed.greaterThanOrEqualTo(new Dec(10).pow(14))) return null
  return parsed
}

/** What is wrong with a schedule for a line, today; none: it can be written. */
export function scheduleProblems(line: ScheduledLine, deliveries: readonly DeliveryInput[], today: string): Issue[] {
  const problems: Issue[] = []
  if (deliveries.length < 2) problems.push({ path: 'body/deliveries', message: 'A schedule splits the line into two deliveries or more; one delivery is the line itself (clear the schedule).' })
  if (deliveries.length > MAX_DELIVERIES) problems.push({ path: 'body/deliveries', message: `A line is split into at most ${MAX_DELIVERIES} deliveries.` })
  let total = new Dec(0)
  const days = new Set<string>()
  deliveries.forEach((delivery, index) => {
    const path = `body/deliveries/${index}`
    const quantity = quantityOf(delivery.quantity)
    if (quantity === null) problems.push({ path: `${path}/quantity`, message: 'A quantity above 0, with at most four decimals.' })
    else total = total.plus(quantity)
    if (!isBusinessDate(delivery.needDate)) problems.push({ path: `${path}/needDate`, message: 'A day (YYYY-MM-DD).' })
    else {
      if (delivery.needDate < today) problems.push({ path: `${path}/needDate`, message: `${delivery.needDate} is past: a delivery is asked for today or later.` })
      if (days.has(delivery.needDate)) problems.push({ path: `${path}/needDate`, message: `Two deliveries on ${delivery.needDate}: make them one.` })
      days.add(delivery.needDate)
    }
    const note = noteOf(delivery.note)
    if (note !== null && note.length > MAX_DELIVERY_NOTE) problems.push({ path: `${path}/note`, message: `At most ${MAX_DELIVERY_NOTE} characters.` })
  })
  if (problems.length === 0 && !total.equals(new Dec(line.quantity))) {
    problems.push({ path: 'body/deliveries', message: `The deliveries add up to ${plain(fixed(total))}; line ${line.seq} is ${plain(line.quantity)}. Together they are the line's quantity.` })
  }
  if (problems.length === 0) {
    const planned = planSchedule(line, deliveries)
    const tiny = planned.find((delivery) => !new Dec(delivery.baseQuantity).greaterThan(0))
    if (tiny) problems.push({ path: 'body/deliveries', message: `Delivery ${tiny.seq} is too small to count in the material's base unit: make it larger.` })
  }
  return problems
}

/**
 * The deliveries as they are written (after scheduleProblems found nothing): by day, numbered from 1, each with its
 * share of the line's base quantity (rounded down to four places, the last one taking the rest).
 */
export function planSchedule(line: ScheduledLine, deliveries: readonly DeliveryInput[]): PlannedDelivery[] {
  const sorted = [...deliveries].sort((a, b) => (a.needDate < b.needDate ? -1 : a.needDate > b.needDate ? 1 : 0))
  const quantity = new Dec(line.quantity)
  const base = new Dec(line.baseQuantity)
  let given = new Dec(0)
  return sorted.map((delivery, index) => {
    const own = new Dec(delivery.quantity)
    const share = index === sorted.length - 1 ? base.minus(given) : own.times(base).dividedBy(quantity).toDecimalPlaces(QUANTITY_SCALE, Dec.ROUND_DOWN)
    given = given.plus(share)
    return { seq: index + 1, quantity: fixed(own), baseQuantity: fixed(share), needDate: delivery.needDate, note: noteOf(delivery.note) }
  })
}

export interface LineSchedule {
  readonly seq: number
  readonly itemCode: string
  readonly quantity: string
  readonly baseQuantity: string
  readonly needDate: string
  readonly deliveries: readonly { readonly seq: number; readonly quantity: string; readonly baseQuantity: string; readonly needDate: string }[]
}

/** What the send checks of the schedules of the order's live lines (the triggers refuse the same at the send). */
export function scheduleChecks(lines: readonly LineSchedule[], today: string): DepthCheck[] {
  const checks: DepthCheck[] = []
  for (const line of lines) {
    if (line.deliveries.length === 0) continue
    const path = `lines/${line.seq}/deliveries`
    const quantity = line.deliveries.reduce((sum, delivery) => sum.plus(delivery.quantity), new Dec(0))
    const base = line.deliveries.reduce((sum, delivery) => sum.plus(delivery.baseQuantity), new Dec(0))
    const first = line.deliveries.map((delivery) => delivery.needDate).sort()[0]!
    if (!quantity.equals(new Dec(line.quantity)) || !base.equals(new Dec(line.baseQuantity)) || first !== line.needDate) {
      checks.push({ code: 'SCHEDULE_NOT_THE_LINE', severity: 'BLOCKS', path, message: `The deliveries of line ${line.seq} (${line.itemCode}) are not the line any more (${plain(fixed(quantity))} of ${plain(line.quantity)}, the first on ${first}, the line on ${line.needDate}): write its schedule again.` })
    }
    for (const delivery of line.deliveries) {
      if (delivery.needDate < today) checks.push({ code: 'DELIVERY_DATE_PAST', severity: 'BLOCKS', path: `${path}/${delivery.seq}`, message: `Delivery ${delivery.seq} of line ${line.seq} (${line.itemCode}) is asked for ${delivery.needDate}, which is past: move it.` })
    }
  }
  return checks
}

/**
 * Why a DRAFT line's quantity, unit or need date may not be edited on its own while it has a schedule (the deliveries are
 * the line: change the schedule, or clear it first), or null.
 */
export function scheduledEditProblem(line: { readonly seq: number; readonly deliveries: number }, change: { readonly quantity: boolean; readonly uom: boolean; readonly needDate: boolean }): string | null {
  if (line.deliveries === 0 || !(change.quantity || change.uom || change.needDate)) return null
  return `Line ${line.seq} is split into ${line.deliveries} deliveries: its quantity, unit and need date are theirs. Change the delivery schedule, or clear it first.`
}
