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
 *                      it with that customer (PortalSettings.progressShared, Owner answer C1). Prices only with the price
 *                      grain of the role (customer Buyer, Finance, Admin).
 *
 * Given to the customer Buyer, Finance, Quality and Viewer (../../auth/roles/templates PARTNER_ADDS); the customer Admin
 * follows by itself. Not the Designer (samples, tech packs and proofs), never a supplier, subcontractor or guest role.
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

/** The customer roles that see the orders (template keys; the Admin follows). */
export const SALES_ORDER_READER_TEMPLATES: readonly string[] = Object.freeze(['customer-buyer', 'customer-finance', 'customer-quality', 'customer-viewer'])
