import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Packaging and carton marks (B-W2b-384; LOG-008, LOG-013; design warehouse.shipping "Packaging"): the company's packaging
 * types, the default packaging per style or size run, and the shipping-mark templates per customer. Checked with can()
 * against the company (a template for a customer: the company and that customer). Office only; the floor reads the types
 * (without their cost) through the packing bench's carton view. The cost per unit is a cost: the API marks it money.cost,
 * so a person without the cost grain neither reads nor sends it. Reading needs shipping.view. Declared in
 * `auth/permissions/catalogue.ts`.
 */
export const SHIPPING_PACKAGING_DEFINITIONS = definePermissions('shipping', {
  'packaging.manage': {
    risk: 'write',
    description:
      "Keep the company's packaging: carton, box, pallet, polybag and hanger types with their inner size, tare, most weight and cost per unit (the cost needs the cost grain), the default packaging per style or size run, and the carton shipping-mark templates per customer; switch them off.",
  },
})

export const SHIPPING_PACKAGING_MANAGE = 'shipping.packaging.manage' satisfies Permission

export const SHIPPING_PACKAGING_PERMISSIONS: readonly Permission[] = Object.freeze([SHIPPING_PACKAGING_MANAGE])

/**
 * Who holds it (auth/roles/templates; the owner from every(), the read-only role none: a write): the warehouse, which packs
 * and keeps the shipping settings. It sees no money, so it keeps the types without their cost (the cost grain's holders set
 * that).
 */
export const SHIPPING_PACKAGING_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  warehouse: [SHIPPING_PACKAGING_MANAGE],
})
