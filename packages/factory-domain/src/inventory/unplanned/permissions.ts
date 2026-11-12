import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Goods without a purchase order (B-W2b-300; SCM-122; apps/factory-api modules/inventory/unplanned). Area `inventory`, beside the
 * module's own list (inventory/permissions.ts). Checked with can() against the receipt's company and site.
 *
 *   inventory.unplanned.decide   the buyer (or the warehouse) names the purchase order goods without one came for — then they
 *                                post as every receipt posts, into the holding place they wait in — or sends them back to the
 *                                supplier with the reason. Office only.
 *
 * Taking such goods in on the floor is inventory.receive (the goods-in tablet's floor roles hold it); reading them is
 * inventory.stock.view (the office). The buyer's task is made by the system (nobody's permission): it asks for the order.
 */
export const INVENTORY_UNPLANNED_DEFINITIONS = definePermissions('inventory', {
  'unplanned.decide': {
    risk: 'write',
    description: 'Name the purchase order of goods that came without one (they then post into the holding place they wait in), or send them back to the supplier with the reason.',
  },
})

export const INVENTORY_UNPLANNED_DECIDE = 'inventory.unplanned.decide' satisfies Permission
export const INVENTORY_UNPLANNED_PERMISSIONS: readonly Permission[] = Object.freeze([INVENTORY_UNPLANNED_DECIDE])

/**
 * Who holds it (auth/roles/templates): the buyer (whose order it is, or who makes one) and the warehouse (who took the goods in
 * and knows the supplier's delivery note); the owner from every(). Office only.
 */
export const INVENTORY_UNPLANNED_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  buyer: [INVENTORY_UNPLANNED_DECIDE],
  warehouse: [INVENTORY_UNPLANNED_DECIDE],
})
