import { definePermissions } from '../../auth/permissions/registry'
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

// ---- B-W2b-100: one shade lot per order (SCM-206) -------------------------------------------------------------------------

/**
 * Letting a hide of another shade lot (or of the out-of-shade group) into an order that asks one shade lot (inventory/
 * reservations/shade.ts): a reserve or an issue the shade rule refuses goes through with the reason, audited. Office only;
 * the production manager and the quality inspector decide it (a shade is a quality question), the Owner from every().
 */
export const INVENTORY_SHADE_DEFINITIONS = definePermissions('inventory', {
  'shade.override': {
    risk: 'write',
    description: "Reserve or issue a hide of another shade lot than the order's (or of the out-of-shade group) when the shade rule refuses it, with the reason.",
  },
})

export const INVENTORY_SHADE_OVERRIDE = 'inventory.shade.override' satisfies Permission
export const INVENTORY_SHADE_PERMISSIONS: readonly Permission[] = Object.freeze([INVENTORY_SHADE_OVERRIDE])
