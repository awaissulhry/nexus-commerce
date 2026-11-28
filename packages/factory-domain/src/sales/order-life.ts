import type { SalesOrderStatus } from './orders/orders'
import type { RequestStatus } from './portal-ordering/rules'
import { customerStatusOf, type LeftShipments } from './portal-orders/status'

/**
 * The order's life — the SAME nine words in every door (owb- order workflow, design plan word table "The states of an order,
 * in every door"; research R-base A; plan.md § 3 BASE "the 9 status words"). One design order is two records: a Draft and a
 * Sent order are a PortalOrderRequest, Confirm makes a SalesOrder. This map says which of the nine an order is, from the
 * facts the API reads; the codes of the API stay as they are, only the word changes. Pure.
 *
 *   DRAFT · SENT · CONFIRMED · IN_PRODUCTION · READY_TO_SHIP · SHIPPED · AT_OUR_WAREHOUSE (the customer reads "At the factory's
 *   warehouse") · DELIVERED · WITHDRAWN
 *
 * A note says more where one word is not the whole truth: "40 of 114" shipped, cancelled (beside withdrawn), refused,
 * accepted as a quote, waiting for the office's yes, waiting for the print, printed. The chip (factory-web lib/order-cells,
 * words in messages/<locale>/order-life.json) draws word + note; inside In production it shows the department.
 *
 *   request  DRAFT → DRAFT · SENT → SENT · REFUSED → WITHDRAWN (note REFUSED) · WITHDRAWN → WITHDRAWN · ACCEPTED as a quote →
 *            SENT (note QUOTE); ACCEPTED as an order → the order's own life (pass the order: its facts win), CONFIRMED alone
 *   order    PENDING_APPROVAL → SENT (note WAITS_FOR_APPROVAL) · CONFIRMED → CONFIRMED (note WAITS_FOR_PRINT before "Print and
 *            start the work", PRINTED after, when the facts say) · IN_PRODUCTION · READY → READY_TO_SHIP · PARTLY_SHIPPED →
 *            SHIPPED (note PARTLY_SHIPPED with the pieces) · SHIPPED and CLOSED → AT_OUR_WAREHOUSE while a warehouse leg
 *            arrived and was not sent on, else DELIVERED or SHIPPED as the customer's status says today (customerStatusOf:
 *            DELIVERED once every shipment that left arrived) · DELIVERED → DELIVERED · CANCELLED → WITHDRAWN (note CANCELLED)
 */

export const ORDER_LIFE = ['DRAFT', 'SENT', 'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'AT_OUR_WAREHOUSE', 'DELIVERED', 'WITHDRAWN'] as const
export type OrderLife = (typeof ORDER_LIFE)[number]

export const LIFE_NOTE_KINDS = ['PARTLY_SHIPPED', 'CANCELLED', 'REFUSED', 'QUOTE', 'WAITS_FOR_APPROVAL', 'WAITS_FOR_PRINT', 'PRINTED'] as const
export type LifeNoteKind = (typeof LIFE_NOTE_KINDS)[number]

export type LifeNote = { readonly kind: 'PARTLY_SHIPPED'; readonly shipped: number; readonly total: number } | { readonly kind: Exclude<LifeNoteKind, 'PARTLY_SHIPPED'> }

export interface OrderLifeAnswer {
  readonly life: OrderLife
  readonly note: LifeNote | null
}

/** A portal order request's facts (Draft and Sent live here). */
export interface RequestLifeFacts {
  readonly status: RequestStatus
  /** What an ACCEPTED request became: an order or a quote (the accept's `as`); null when not known or not accepted. */
  readonly acceptedAs?: 'ORDER' | 'QUOTE' | null
}

/** A sales order's facts. */
export interface OrderStatusFacts {
  readonly status: SalesOrderStatus
  /**
   * "Print and start the work" (an OrderPrint FIRST row): true after it, false before it on a site that prints; null or left
   * out: say nothing (a site without the print, or not read).
   */
  readonly printed?: boolean | null
  /** The pieces shipped of the order's pieces (a PARTLY_SHIPPED note says "shipped of total"). Left out: 0 of 0. */
  readonly pieces?: { readonly shipped: number; readonly total: number } | null
  /** The shipments that left and those the carrier delivered (customerStatusOf). Left out: none. */
  readonly shipments?: LeftShipments | null
  /** A warehouse leg of one of its shipments arrived at our warehouse and was not sent on yet (ShipmentWarehouseLeg). */
  readonly atOurWarehouse?: boolean | null
}

export interface OrderLifeFacts {
  /** The request, while there is no order (Draft, Sent, Refused, Withdrawn, or accepted as a quote). */
  readonly request?: RequestLifeFacts | null
  /** The order, once confirmed: its facts win over the request's. */
  readonly order?: OrderStatusFacts | null
}

const answer = (life: OrderLife, note: LifeNote | null = null): OrderLifeAnswer => ({ life, note })
const NO_SHIPMENTS: LeftShipments = { left: 0, delivered: 0 }

/** Which of the nine words an order is, and its note. An order with neither record (never happens) is a DRAFT. */
export function orderLifeOf(facts: OrderLifeFacts): OrderLifeAnswer {
  const order = facts.order ?? null
  if (order) return orderLife(order)
  const request = facts.request ?? null
  if (!request) return answer('DRAFT')
  switch (request.status) {
    case 'DRAFT':
      return answer('DRAFT')
    case 'SENT':
      return answer('SENT')
    case 'REFUSED':
      return answer('WITHDRAWN', { kind: 'REFUSED' })
    case 'WITHDRAWN':
      return answer('WITHDRAWN')
    case 'ACCEPTED':
      return request.acceptedAs === 'QUOTE' ? answer('SENT', { kind: 'QUOTE' }) : answer('CONFIRMED')
  }
}

function orderLife(order: OrderStatusFacts): OrderLifeAnswer {
  switch (order.status) {
    case 'PENDING_APPROVAL':
      return answer('SENT', { kind: 'WAITS_FOR_APPROVAL' })
    case 'CONFIRMED':
      return answer('CONFIRMED', order.printed === true ? { kind: 'PRINTED' } : order.printed === false ? { kind: 'WAITS_FOR_PRINT' } : null)
    case 'IN_PRODUCTION':
      return answer('IN_PRODUCTION')
    case 'READY':
      return answer('READY_TO_SHIP')
    case 'PARTLY_SHIPPED':
      return answer('SHIPPED', { kind: 'PARTLY_SHIPPED', shipped: order.pieces?.shipped ?? 0, total: order.pieces?.total ?? 0 })
    case 'SHIPPED':
    case 'CLOSED':
      if (order.atOurWarehouse === true) return answer('AT_OUR_WAREHOUSE')
      return answer(customerStatusOf(order.status, order.shipments ?? NO_SHIPMENTS) === 'DELIVERED' ? 'DELIVERED' : 'SHIPPED')
    case 'DELIVERED':
      return answer('DELIVERED')
    case 'CANCELLED':
      return answer('WITHDRAWN', { kind: 'CANCELLED' })
  }
}
