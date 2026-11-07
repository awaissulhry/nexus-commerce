import type { Permission } from '../../core/permissions'
import { definePartnerPermissions } from '../../auth/partners/permissions'

/**
 * Ship notices in the portal (B-W2b-182; SCM-106, SCM-107; design portal.supplier.asn "Deliveries"). The PARTNER's (area
 * `portal`, flagged `partner`: held only by partner roles; given to the supplier's Orders role, its Admin follows):
 *
 *   shipNotices.view   see the deliveries you announced and how each was received, the open lines of our confirmed orders
 *                      you may ship, and the packing-list template; never a price, cost or amount (Owner answer C2).
 *                      Announcing a delivery, its packing list, sending and cancelling it also need the person's capability
 *                      `portal.upload` (B-W2b-162: a portal write checks its page's permission AND the capability its verb
 *                      takes: a ship notice and its packing list are what the supplier sends us).
 *
 * The office reads ship notices on Warehouse › Receipts with inventory.stock.view (the inbound board) and receives from them
 * with inventory.receive: no new office permission.
 */
export const PORTAL_SHIP_NOTICES_DEFINITIONS = definePartnerPermissions('portal', {
  'shipNotices.view': {
    risk: 'read',
    description: 'See the deliveries you announced and how each was received, and the lines of our confirmed orders you may ship; announce them when you may upload.',
  },
})

export const PORTAL_SHIP_NOTICES_VIEW = 'portal.shipNotices.view' satisfies Permission
export const PORTAL_SHIP_NOTICES_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_SHIP_NOTICES_VIEW])
