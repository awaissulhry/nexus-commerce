import type { Permission } from '../../core/permissions'
import { definePartnerPermissions } from '../../auth/partners/permissions'

/**
 * Customer orders in the portal (B-W2b-175; SAL-075, SAL-076, SAL-080, SAL-081; design portal.customer.orders, the record
 * tabs Status & progress, Lines and Shipments & tracking, portal.customer.home "Your next deliveries" and "At a glance").
 *
 * The PARTNER's (area `portal`, flagged `partner`: held only by partner roles, never by an office or floor role):
 *   salesOrders.view   see the organisation's orders with the factory: the status in customer words with its dates, the
 *                      promise date with every move and its reason in customer words, the lines and sizes with what is
 *                      still open, the shipments with their parcels and tracking, the parcels on the way; and the
 *                      production progress per line and size (cut, sewn, inspected, packed) only while the factory shares
 *                      it with that customer (its share level PROGRESS or more, PortalSettings.productionLevel; Owner answer
 *                      C1; B-PR-40: the old progressShared switch dropped). Prices only with the price
 *                      grain of the role (customer Buyer, Finance, Admin).
 *
 * Given to the customer Buyer, Finance, Quality, Designer and Viewer (../../auth/roles/templates PARTNER_ADDS); the customer
 * Admin follows by itself. owb-b7 (Owner yes 2026-11-28): the Designer reads the orders sheet and the order page too — without
 * a price (its role has no price grain: the money fields drop, the Money tab and the price check answer 403) and without Send
 * (that stays portal.orderRequests.manage). Never a supplier, subcontractor or guest role.
 */
export const PORTAL_SALES_ORDERS_DEFINITIONS = definePartnerPermissions('portal', {
  'salesOrders.view': {
    risk: 'read',
    description:
      "See your organisation's orders: where each one is and when, the promised date and why it moved, what is still to ship, the shipments and their tracking, and the production progress when the factory shares it (prices only for roles that show prices).",
  },
})

export const PORTAL_SALES_ORDERS_VIEW = 'portal.salesOrders.view' satisfies Permission
export const PORTAL_SALES_ORDERS_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_SALES_ORDERS_VIEW])

/** The customer roles that see the orders (template keys; the Admin follows). owb-b7: + the Designer (no price grain, no Send). */
export const SALES_ORDER_READER_TEMPLATES: readonly string[] = Object.freeze(['customer-buyer', 'customer-finance', 'customer-quality', 'customer-designer', 'customer-viewer'])

/**
 * "I paid" (owb- order workflow, plan.md § 5 D "the customer's buyer: I paid"; PL-schema § 5A row 4 `PaymentNotice`; PL-split
 * S1 po2). The PARTNER's (area `portal`, flagged `partner`): tell the factory that a payment of an order was made (how much,
 * when, how, a note or a receipt file). It is a notice, never a payment: the factory records it or dismisses it in the office
 * (S2's Money tab), and nothing is marked paid until then. Checked against the order's party (a partner session's own).
 *
 *   payments.notify   tell the factory you paid an order's deposit, a payment step or an amount (the money on it only with the
 *                     price grain of the role)
 *
 * Given to the customer Buyer (../../auth/roles/templates PARTNER_ADDS); the customer Admin follows by itself.
 */
export const PORTAL_PAYMENT_NOTICES_DEFINITIONS = definePartnerPermissions('portal', {
  'payments.notify': {
    risk: 'write',
    description: 'Tell the factory you paid for an order: how much, on which day, how, with a note or the receipt. The factory checks it and records the payment.',
  },
})

export const PORTAL_PAYMENTS_NOTIFY = 'portal.payments.notify' satisfies Permission
export const PORTAL_PAYMENT_NOTICES_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_PAYMENTS_NOTIFY])

/** The partner templates that tell the factory a payment was made (template key → permissions; the customer Admin follows). */
export const PORTAL_PAYMENT_NOTICES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  'customer-buyer': [PORTAL_PAYMENTS_NOTIFY],
})
