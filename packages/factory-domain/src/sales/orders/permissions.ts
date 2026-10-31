import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The sales orders' permissions (apps/factory-api modules/sales/orders; B-W1-25; SAL-200, SAL-203, SAL-204, SAL-206,
 * SAL-214; A2 SCR-038 "Orders", SCR-039 "Order record"), in the orders area. Each is checked with can() against the
 * order's company AND its party, so a role limited to some customers sees and acts on only their orders. Office only:
 * the floor reads work orders, never orders; a portal sees its own orders through its own screens (W2b).
 *
 *   view     the orders list, the board's counts by state and the tiles, and the record: lines with their size grids and
 *            per-size progress (ordered, in work orders, made, released, shipped, invoiced), dates, the record chain (quote
 *            → order → deposit → work orders → shipments → invoices) and whether the order is settled; prices only with
 *            the price grain, costs with the cost grain
 *   manage   make the order of an accepted quote version when the acceptance could not (no number series then), change
 *            the promise date (a reason; the first promise stays), mark it ready by hand (a reason, while quality release
 *            is not in use), cancel it (a reason, only before any work order is released), close a SETTLED order
 *   close    close an order that is shipped but not settled (not every line invoiced and paid): with a reason, kept in its
 *            history. A settled order closes by itself when the money module says so (order.fully_settled)
 *   waive    B-W2b-16 (design orders.depositRequest "Waive… (Owner)", quote.docs.deposit "Waive (Owner, reason)"): waive
 *            an order's deposit or a payment step before shipping (its deposit request too, while nothing is paid on
 *            it): the customer need not pay it in advance (a waived deposit lets production start; a waived balance is
 *            billed on the goods' invoice). A reason and a fresh step-up; no role template holds it (the owner holds
 *            every permission)
 */
export const ORDERS_DEFINITIONS = definePermissions('orders', {
  view: { risk: 'read', description: 'See sales orders: lines and size grids with per-size progress, dates and promises, the record chain and whether an order is settled (prices and costs only with their grains).' },
  manage: { risk: 'write', description: "Work on sales orders: make an accepted quote's order, change a promise date with a reason, mark an order ready, cancel one before production starts, close a settled one." },
  close: { risk: 'write', description: 'Close a shipped order that is not settled (not every line invoiced and paid), with a reason kept in its history.' },
  waive: { risk: 'stepUp', description: "Waive an order's deposit or a payment step before shipping (and its deposit request while nothing is paid on it), with a reason and a fresh step-up." },
})

export const ORDERS_VIEW = 'orders.view' satisfies Permission
export const ORDERS_MANAGE = 'orders.manage' satisfies Permission
export const ORDERS_CLOSE = 'orders.close' satisfies Permission
export const ORDERS_WAIVE = 'orders.waive' satisfies Permission

export const ORDERS_PERMISSIONS: readonly Permission[] = Object.freeze([ORDERS_VIEW, ORDERS_MANAGE, ORDERS_CLOSE, ORDERS_WAIVE])
