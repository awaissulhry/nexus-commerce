import type { TaskSource } from './index'

/**
 * B-W2b-174 (SCM-085, SCM-094; design portal.supplier.home "To do", portal.supplier.orders "Confirm waiting orders"): the
 * supplier's request to confirm a purchase order, one per revision we send (sourceKey `PurchaseOrder:<id>:r<revision>`).
 * The send opens it; the supplier's answer (portal or link) closes it as done; a cancel, a change into a new revision or
 * goods received close it as withdrawn; the buyer's refusal of a proposal opens it again (modules/purchasing/portal-orders/
 * tasks.ts). It has its own answer, so the partner never marks it done by hand.
 */
export const PURCHASE_ORDERS_SOURCE: TaskSource = Object.freeze<TaskSource>({ name: 'purchasing.confirm', prefix: 'PurchaseOrder', kinds: ['CONFIRM_PO'], partnerDone: false })
