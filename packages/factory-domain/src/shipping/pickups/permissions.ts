import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Carrier pickups (B-W2b-395; LOG-048): book one through the company's Sendcloud connection or keep one booked by phone, then
 * confirm it by hand, mark it failed or call it off. A carrier sends a driver for it and may charge for the visit, so it is
 * its own permission beside shipping.manage. Checked with can() against the site's company and the site. Office only.
 * Reading pickups is shipping.view; the day's close and the customer's collection are shipping.manage. Declared in
 * `auth/permissions/catalogue.ts`.
 */
export const SHIPPING_PICKUPS_DEFINITIONS = definePermissions('shipping', {
  'pickups.book': {
    risk: 'write',
    description:
      "Book a carrier pickup for a site (through the company's Sendcloud connection, or noted after booking it by phone, a recurring round too), confirm it by hand, mark it failed with why, or call it off. The carrier sends a driver and may charge for the visit.",
  },
})

export const SHIPPING_PICKUPS_BOOK = 'shipping.pickups.book' satisfies Permission

export const SHIPPING_PICKUPS_PERMISSIONS: readonly Permission[] = Object.freeze([SHIPPING_PICKUPS_BOOK])

/** Who holds it (auth/roles/templates; the owner from every(), the read-only role none: a write): the dispatch desk. */
export const SHIPPING_PICKUPS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  warehouse: [SHIPPING_PICKUPS_BOOK],
})
