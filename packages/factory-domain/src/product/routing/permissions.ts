import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The routing's permissions (apps/factory-api modules/product/routing and modules/product/operations; features PRD-109,
 * PRD-110), in the product area. Each is checked with can() against the record's company (the style's, the
 * operation's); a tenant-wide style or operation (no company) is written only by a grant that reaches every company.
 *
 * The operation library has its own write permission: its standard minutes are the base of every new routing, of
 * capacity and, later, of piece rates (PRD-111, PRD-113; c.c. art. 2100), so the Owner can let a product developer edit a
 * style's routing without letting them change the library's minutes. Reading the library comes with reading routings.
 */
export const PRODUCT_ROUTING_DEFINITIONS = definePermissions('product', {
  'routing.view': {
    risk: 'read',
    description: "See a style revision's routing with its standard minutes per garment, per size and per kind of work centre, compare two revisions' routings, and see the operation library and where each operation is used.",
  },
  'routing.manage': {
    risk: 'write',
    description: "Edit a draft revision's routing: add operations from the library, change their minutes, scan point and instructions, remove and reorder them, and copy the steps of a released routing.",
  },
  'operations.manage': {
    risk: 'write',
    description: 'Keep the operation library: create operations, change their names, kind of work centre, machine, skill, standard minutes and instructions, archive and reactivate them.',
  },
})

export const PRODUCT_ROUTING_VIEW = 'product.routing.view' satisfies Permission
export const PRODUCT_ROUTING_MANAGE = 'product.routing.manage' satisfies Permission
export const PRODUCT_OPERATIONS_MANAGE = 'product.operations.manage' satisfies Permission
export const PRODUCT_ROUTING_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCT_ROUTING_VIEW, PRODUCT_ROUTING_MANAGE, PRODUCT_OPERATIONS_MANAGE])
