import type { PurchaseOrderStatus } from '../orders'

/**
 * How a purchase order reads in the supplier's portal (B-W2b-174; SCM-094; design portal.supplier.orders "Which orders"
 * chips, "Your purchase orders" status pill and delivery status), pure: the order's state in the supplier's words, the
 * chips and the statuses each finds, what the supplier may do now, the request key of the CONFIRM_PO task. No price, cost
 * or amount anywhere (Owner answer C2).
 *
 * An order is the supplier's once we sent it: a draft never sent is not shown; a sent order we are changing (a DRAFT of
 * revision 2 or later) is shown as "being changed" with the revision the supplier holds; a cancelled one stays in the list.
 */

export const SUPPLIER_STATES = ['TO_CONFIRM', 'CONFIRMED', 'CHANGE_PROPOSED', 'DECLINED', 'BEING_CHANGED', 'PARTLY_DELIVERED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const
export type SupplierState = (typeof SUPPLIER_STATES)[number]

export interface Words {
  readonly it: string
  readonly en: string
}

export const SUPPLIER_STATE_WORDS: Readonly<Record<SupplierState, Words>> = Object.freeze({
  TO_CONFIRM: { it: 'Da confermare', en: 'To confirm' },
  CONFIRMED: { it: 'Confermato', en: 'Confirmed' },
  CHANGE_PROPOSED: { it: 'Modifica proposta', en: 'Change proposed' },
  DECLINED: { it: 'Rifiutato da voi', en: 'Declined by you' },
  BEING_CHANGED: { it: 'In modifica da parte nostra', en: 'Being changed by us' },
  PARTLY_DELIVERED: { it: 'Consegnato in parte', en: 'Partly delivered' },
  DELIVERED: { it: 'Consegnato', en: 'Delivered' },
  CLOSED: { it: 'Chiuso', en: 'Closed' },
  CANCELLED: { it: 'Annullato', en: 'Cancelled' },
})

/** The state of an order the supplier holds (a DRAFT is "being changed": the supplier holds an earlier revision). */
export function supplierStateOf(status: PurchaseOrderStatus | string): SupplierState {
  switch (status) {
    case 'SENT':
      return 'TO_CONFIRM'
    case 'CONFIRMED':
      return 'CONFIRMED'
    case 'CHANGES_PROPOSED':
      return 'CHANGE_PROPOSED'
    case 'DECLINED':
      return 'DECLINED'
    case 'DRAFT':
    // B-W2b-305: waiting for its yes is still being changed (a revision 1 waiting is never shown: it was never sent).
    case 'PENDING_APPROVAL':
      return 'BEING_CHANGED'
    case 'PARTLY_RECEIVED':
      return 'PARTLY_DELIVERED'
    case 'RECEIVED':
      return 'DELIVERED'
    case 'CLOSED':
      return 'CLOSED'
    default:
      return 'CANCELLED'
  }
}

/** The design's chips ("To confirm (default when any) · Confirmed · Change proposed · Partly delivered · Delivered · Closed · All"). */
export const ORDER_CHIPS = ['TO_CONFIRM', 'CONFIRMED', 'CHANGE_PROPOSED', 'PARTLY_DELIVERED', 'DELIVERED', 'CLOSED', 'ALL'] as const
export type OrderChip = (typeof ORDER_CHIPS)[number]

/** The statuses a chip finds (ALL: every order the supplier holds). Declined and cancelled orders are closed for the supplier. */
export const CHIP_STATUSES: Readonly<Record<Exclude<OrderChip, 'ALL'>, readonly PurchaseOrderStatus[]>> = Object.freeze({
  TO_CONFIRM: ['SENT'],
  CONFIRMED: ['CONFIRMED'],
  CHANGE_PROPOSED: ['CHANGES_PROPOSED'],
  PARTLY_DELIVERED: ['PARTLY_RECEIVED'],
  DELIVERED: ['RECEIVED'],
  CLOSED: ['CLOSED', 'CANCELLED', 'DECLINED'],
})

export const CHIP_WORDS: Readonly<Record<OrderChip, Words>> = Object.freeze({
  TO_CONFIRM: SUPPLIER_STATE_WORDS.TO_CONFIRM,
  CONFIRMED: SUPPLIER_STATE_WORDS.CONFIRMED,
  CHANGE_PROPOSED: SUPPLIER_STATE_WORDS.CHANGE_PROPOSED,
  PARTLY_DELIVERED: SUPPLIER_STATE_WORDS.PARTLY_DELIVERED,
  DELIVERED: SUPPLIER_STATE_WORDS.DELIVERED,
  CLOSED: { it: 'Chiusi', en: 'Closed' },
  ALL: { it: 'Tutti', en: 'All' },
})

/** The chip a list opens on: "To confirm" while any order waits for the supplier, else every order. */
export const defaultChipOf = (toConfirm: number): OrderChip => (toConfirm > 0 ? 'TO_CONFIRM' : 'ALL')

/** Why the supplier cannot answer the order now, in the portal's words, or null (only a SENT order waits for its answer). */
export function portalAnswerProblem(status: PurchaseOrderStatus | string): string | null {
  switch (status) {
    case 'SENT':
      return null
    case 'CONFIRMED':
      return 'This order is confirmed: there is nothing more to answer. Write in its messages to ask for a change.'
    case 'CHANGES_PROPOSED':
      return 'Your changes are with the buyer, who accepts or refuses them: you will see the answer here.'
    case 'DECLINED':
      return 'You declined this order: the buyer changes it or cancels it.'
    case 'DRAFT':
    case 'PENDING_APPROVAL':
      return 'We are changing this order: its new version comes to you to confirm.'
    case 'PARTLY_RECEIVED':
    case 'RECEIVED':
      return 'Goods of this order were received already: it needs no confirmation any more.'
    default:
      return 'This order is closed: it needs no answer.'
  }
}

/** The CONFIRM_PO request of one revision of an order (the task source's key: a new revision is a new request). */
export const confirmTaskKey = (orderId: string, revision: number): string => `PurchaseOrder:${orderId}:r${revision}`

/** "PO-2026-0101" or "PO-2026-0101 rev. 2": what a task names. */
export const PO_RECORD_TYPE = 'PurchaseOrder'

/** A line's delivery state for the supplier, from what was received of it (in its base unit) and whether it is still open. */
export const LINE_DELIVERY_STATES = ['OPEN', 'PARTLY_DELIVERED', 'DELIVERED', 'CANCELLED', 'CLOSED_SHORT'] as const
export type LineDeliveryState = (typeof LINE_DELIVERY_STATES)[number]
