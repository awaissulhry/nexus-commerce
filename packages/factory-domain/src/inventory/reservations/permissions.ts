import type { Permission } from '../../core/permissions'

/**
 * The reservations' permission (B-W2a-11; SCM-205, SCM-209, SCM-210). Declared with its description in
 * `auth/permissions/catalogue.ts` (INVENTORY_DEFINITIONS, `reserve`), checked with can() against the site's company and
 * the site. Reading reservations is inventory.stock.view. Office only: the floor never reserves or releases; its issue to
 * a work order counts against the work order's own reservations by itself.
 */

/** Reserve stock of a site (a quantity, an area of leather, named hides) for a work order or an order line, and release it with the reason. */
export const INVENTORY_RESERVE = 'inventory.reserve' satisfies Permission

export const INVENTORY_RESERVATION_PERMISSIONS = [INVENTORY_RESERVE] as const
