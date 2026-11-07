import type { Permission } from '../../core/permissions'
import { definePartnerPermissions } from '../../auth/partners/permissions'

/**
 * Change and cancel requests from the portal (B-W2b-183; SAL-077, SAL-078; design portal.customer.orders pop-ups "Ask for a
 * change" and "Ask to cancel").
 *
 * The PARTNER's (area `portal`, flagged `partner`: held only by partner roles, never by an office or floor role):
 *   salesOrders.ask   ask the factory to change an order (quantities and sizes, the delivery date, the delivery address)
 *                     or to cancel it (the whole order or some lines), checked against the cut-off rules before the click;
 *                     withdraw the request while it waits. Reading the requests and their answers rides on
 *                     portal.salesOrders.view (B-W2b-175): whoever sees the order sees what was asked of it.
 *
 * Given to the customer Buyer (../../auth/roles/templates PARTNER_ADDS); the customer Admin follows by itself. Not the
 * Finance, Quality, Designer or Viewer roles (they see orders; they do not change them), never a supplier, subcontractor or
 * guest role. The office answers with orders.manage (the amendment's and the cancel's own permission): no new office
 * permission.
 */
export const PORTAL_ORDER_CHANGES_DEFINITIONS = definePartnerPermissions('portal', {
  'salesOrders.ask': {
    risk: 'write',
    description:
      "Ask the factory to change one of your organisation's orders (quantities and sizes, the delivery date, the delivery address) or to cancel it, within the cut-off rules, and withdraw the request while it waits.",
  },
})

export const PORTAL_SALES_ORDERS_ASK = 'portal.salesOrders.ask' satisfies Permission
export const PORTAL_ORDER_CHANGES_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_SALES_ORDERS_ASK])

/** The customer roles that ask for changes (template keys; the Admin follows). */
export const ORDER_CHANGE_ASKER_TEMPLATES: readonly string[] = Object.freeze(['customer-buyer'])
