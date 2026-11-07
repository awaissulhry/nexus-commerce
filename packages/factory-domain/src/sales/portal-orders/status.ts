import type { BusinessDate } from '../../core/time'
import type { SalesOrderStatus } from '../orders/orders'

/**
 * An order's status in the customer's words (B-W2b-175, SAL-075; design portal.customer.orders "Which orders" chips and
 * Status & progress › "Where your order is": "MilestoneTracker: Requested · Confirmed · In production · Ready · Shipped ·
 * Delivered, each with its date or 'expected'"). Pure: the API reads the facts (the partner's own rows, and the dates the
 * office's audit rows hold), this says what the customer sees.
 *
 *   status      the office's SalesOrderStatus said the customer's way: CLOSED is never shown (an order closed after it left
 *               is SHIPPED, or DELIVERED once every shipment that left arrived); a SENT portal order request that has no
 *               order yet is REQUESTED
 *   chips       the list's saved filters: Open (default: everything not delivered or cancelled, requests included),
 *               Requested, In production, Ready, Shipped (partly or all), Delivered, Cancelled, All, and Date moved
 *               (the promise changed in the last 14 days)
 *   milestones  the six steps, each DONE (with the day it happened when known), PARTLY (shipped in part), TODO (with the
 *               day expected when one is promised) or SKIPPED (a cancelled order's steps it never reached)
 */

export const CUSTOMER_ORDER_STATUSES = ['REQUESTED', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const
export type CustomerOrderStatus = (typeof CUSTOMER_ORDER_STATUSES)[number]

export interface Words {
  readonly it: string
  readonly en: string
}

export const CUSTOMER_STATUS_WORDS: Readonly<Record<CustomerOrderStatus, Words>> = Object.freeze({
  REQUESTED: { it: 'Richiesto', en: 'Requested' },
  CONFIRMED: { it: 'Confermato', en: 'Confirmed' },
  IN_PRODUCTION: { it: 'In produzione', en: 'In production' },
  READY: { it: 'Pronto per la spedizione', en: 'Ready to ship' },
  PARTLY_SHIPPED: { it: 'Spedito in parte', en: 'Partly shipped' },
  SHIPPED: { it: 'Spedito', en: 'Shipped' },
  DELIVERED: { it: 'Consegnato', en: 'Delivered' },
  CANCELLED: { it: 'Annullato', en: 'Cancelled' },
})

/** The shipments of an order that count for its status: those that left, and of them those the carrier delivered. */
export interface LeftShipments {
  readonly left: number
  readonly delivered: number
}

/** The customer's status of an order. */
export function customerStatusOf(status: SalesOrderStatus, shipments: LeftShipments): CustomerOrderStatus {
  switch (status) {
    case 'CONFIRMED':
    case 'IN_PRODUCTION':
    case 'READY':
    case 'PARTLY_SHIPPED':
    case 'CANCELLED':
      return status
    case 'SHIPPED':
    case 'CLOSED':
      return shipments.left > 0 && shipments.delivered >= shipments.left ? 'DELIVERED' : 'SHIPPED'
  }
}

// ---- the list's chips ------------------------------------------------------------------------------------------------------

export const ORDER_CHIPS = ['OPEN', 'REQUESTED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'ALL', 'DATE_MOVED'] as const
export type OrderChip = (typeof ORDER_CHIPS)[number]

export const CHIP_WORDS: Readonly<Record<OrderChip, Words>> = Object.freeze({
  OPEN: { it: 'Aperti', en: 'Open' },
  REQUESTED: { it: 'Richiesti', en: 'Requested' },
  IN_PRODUCTION: { it: 'In produzione', en: 'In production' },
  READY: { it: 'Pronti', en: 'Ready' },
  SHIPPED: { it: 'Spediti', en: 'Shipped' },
  DELIVERED: { it: 'Consegnati', en: 'Delivered' },
  CANCELLED: { it: 'Annullati', en: 'Cancelled' },
  ALL: { it: 'Tutti', en: 'All' },
  DATE_MOVED: { it: 'Data spostata', en: 'Date moved' },
})

/** "Date moved": the promise changed within these days. */
export const DATE_MOVED_DAYS = 14

const OPEN: readonly CustomerOrderStatus[] = ['REQUESTED', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED']

/** Whether a row with this status (and whether its promise moved lately) is in a chip. */
export function inChip(chip: OrderChip, status: CustomerOrderStatus, movedLately: boolean): boolean {
  switch (chip) {
    case 'OPEN':
      return OPEN.includes(status)
    case 'SHIPPED':
      return status === 'PARTLY_SHIPPED' || status === 'SHIPPED'
    case 'ALL':
      return true
    case 'DATE_MOVED':
      return movedLately
    default:
      return status === chip
  }
}

/** Every chip's count over the rows, in the chips' order. */
export function chipCounts(rows: readonly { readonly status: CustomerOrderStatus; readonly movedLately: boolean }[]): { chip: OrderChip; count: number; words: Words }[] {
  return ORDER_CHIPS.map((chip) => ({ chip, count: rows.filter((row) => inChip(chip, row.status, row.movedLately)).length, words: CHIP_WORDS[chip] }))
}

/** An order the customer still waits for (Home's "Open orders", the next deliveries). */
export const isOpenForCustomer = (status: CustomerOrderStatus): boolean => OPEN.includes(status)

/** An order with pieces still to leave (Home's "Shipping this week" counts these by their promise date). */
export const isStillToShip = (status: CustomerOrderStatus): boolean => ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'].includes(status)

const DAY_MS = 86_400_000
const dayText = (ms: number): BusinessDate => new Date(ms).toISOString().slice(0, 10)

/** The week (Monday to Sunday) a day falls in. */
export function weekOf(day: BusinessDate): { readonly from: BusinessDate; readonly to: BusinessDate } {
  const at = Date.parse(`${day}T00:00:00.000Z`)
  const monday = at - ((new Date(at).getUTCDay() + 6) % 7) * DAY_MS
  return { from: dayText(monday), to: dayText(monday + 6 * DAY_MS) }
}

// ---- the milestones ----------------------------------------------------------------------------------------------------------

export const MILESTONES = ['REQUESTED', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DELIVERED'] as const
export type Milestone = (typeof MILESTONES)[number]

export const MILESTONE_WORDS: Readonly<Record<Milestone, Words>> = Object.freeze({
  REQUESTED: { it: 'Richiesto', en: 'Requested' },
  CONFIRMED: { it: 'Confermato', en: 'Confirmed' },
  IN_PRODUCTION: { it: 'In produzione', en: 'In production' },
  READY: { it: 'Pronto', en: 'Ready' },
  SHIPPED: { it: 'Spedito', en: 'Shipped' },
  DELIVERED: { it: 'Consegnato', en: 'Delivered' },
})

export const MILESTONE_STATES = ['DONE', 'PARTLY', 'TODO', 'SKIPPED'] as const
export type MilestoneState = (typeof MILESTONE_STATES)[number]

/** When each step happened, as far as the records say (null: not reached, or the day is not known). */
export interface MilestoneFacts {
  readonly status: CustomerOrderStatus
  /** The day the customer asked: the portal request's send, else the order's date. */
  readonly requestedOn: BusinessDate | null
  readonly confirmedOn: BusinessDate | null
  /** The first work order released, or the day the order moved to IN_PRODUCTION. */
  readonly productionOn: BusinessDate | null
  /** The day the order moved to READY (quality released everything, or the office said so). */
  readonly readyOn: BusinessDate | null
  /** The first shipment that left (PARTLY), and the day everything had left (DONE). */
  readonly firstShippedOn: BusinessDate | null
  readonly allShippedOn: BusinessDate | null
  /** The day the last shipment that left was delivered, once every one was. */
  readonly deliveredOn: BusinessDate | null
  /** The promise now (the expected day of SHIPPED while it is not done). */
  readonly promiseDate: BusinessDate | null
}

export interface MilestoneView {
  readonly key: Milestone
  readonly words: Words
  readonly state: MilestoneState
  /** The day it happened (DONE or PARTLY), when known. */
  readonly date: BusinessDate | null
  /** The day it is expected (TODO), when promised. */
  readonly expected: BusinessDate | null
  /** The step the order stands at now (the furthest DONE or PARTLY one). */
  readonly current: boolean
}

const REACHED: Readonly<Record<CustomerOrderStatus, number>> = {
  REQUESTED: 0,
  CONFIRMED: 1,
  IN_PRODUCTION: 2,
  READY: 3,
  PARTLY_SHIPPED: 4,
  SHIPPED: 4,
  DELIVERED: 5,
  CANCELLED: -1,
}

/**
 * The six steps of an order. A step at or before the status is DONE (an order that left early passed Ready without a day:
 * DONE, no date); SHIPPED is PARTLY while only part left; later steps are TODO (SHIPPED expected on the promise date). A
 * cancelled order: the steps with a day stay DONE, the others SKIPPED.
 */
export function milestonesOf(facts: MilestoneFacts): MilestoneView[] {
  const dayOf: Readonly<Record<Milestone, BusinessDate | null>> = {
    REQUESTED: facts.requestedOn,
    CONFIRMED: facts.confirmedOn,
    IN_PRODUCTION: facts.productionOn,
    READY: facts.readyOn,
    SHIPPED: facts.status === 'PARTLY_SHIPPED' ? facts.firstShippedOn : (facts.allShippedOn ?? facts.firstShippedOn),
    DELIVERED: facts.deliveredOn,
  }
  const cancelled = facts.status === 'CANCELLED'
  const reached = cancelled ? Math.max(-1, ...MILESTONES.map((key, rank) => (dayOf[key] !== null ? rank : -1))) : REACHED[facts.status]
  const views = MILESTONES.map((key, rank): Omit<MilestoneView, 'current'> => {
    if (cancelled) {
      if (dayOf[key] !== null && rank <= reached) return { key, words: MILESTONE_WORDS[key], state: 'DONE', date: dayOf[key], expected: null }
      return { key, words: MILESTONE_WORDS[key], state: 'SKIPPED', date: null, expected: null }
    }
    if (key === 'SHIPPED' && facts.status === 'PARTLY_SHIPPED') return { key, words: MILESTONE_WORDS[key], state: 'PARTLY', date: dayOf[key], expected: facts.promiseDate }
    if (rank <= reached) return { key, words: MILESTONE_WORDS[key], state: 'DONE', date: dayOf[key], expected: null }
    return { key, words: MILESTONE_WORDS[key], state: 'TODO', date: null, expected: key === 'SHIPPED' ? facts.promiseDate : null }
  })
  const currentIndex = views.reduce((at, view, index) => (view.state === 'DONE' || view.state === 'PARTLY' ? index : at), -1)
  return views.map((view, index) => ({ ...view, current: index === currentIndex }))
}
