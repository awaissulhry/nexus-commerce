import type { Permission } from '../../core/permissions'
import { definePartnerPermissions } from '../../auth/partners/permissions'

/**
 * Supplier orders in the portal (B-W2b-174; SCM-094 "PO list and detail", SCM-086 "Supplier proposes a change"; design
 * portal.supplier.orders). The PARTNER's (area `portal`, flagged `partner`: held only by partner roles; given to the
 * supplier's Orders role, its Admin follows):
 *
 *   purchaseOrders.view   see our purchase orders to your organisation: the lines in your terms, the dates, every version
 *                         and what changed in it, your answers so far and ours, and a copy of the order without prices; never
 *                         a price, cost or amount (Owner answer C2: the partner role cannot read them, PO_CONFIRM holds no
 *                         grain). Answering an order (confirm all as asked, line by line, propose a change or a substitute,
 *                         decline) also needs the person's capability `portal.approve` (B-W2b-162: a portal write checks
 *                         its page's permission AND the capability its verb takes; the CONFIRM_PO task asks for the same).
 */
export const PORTAL_PURCHASE_ORDERS_DEFINITIONS = definePartnerPermissions('portal', {
  'purchaseOrders.view': {
    risk: 'read',
    description: 'See our purchase orders to your organisation: lines, dates, versions and what changed, your answers and ours, a copy without prices; answer them when you may approve.',
  },
})

export const PORTAL_PURCHASE_ORDERS_VIEW = 'portal.purchaseOrders.view' satisfies Permission
export const PORTAL_PURCHASE_ORDERS_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_PURCHASE_ORDERS_VIEW])
