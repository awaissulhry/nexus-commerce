import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The material library's permissions (apps/factory-api modules/product/materials; features PRD-028, GAP-006), in the
 * product area. Each is checked with can() against the material's company; a tenant-wide material (no company) is
 * written only by a grant that reaches every company. The standard purchase price also needs the cost money grain, to
 * see it and to send it (money.cost): `product.materials.cost` is who may change it.
 */
export const PRODUCT_MATERIALS_DEFINITIONS = definePermissions('product', {
  'materials.view': { risk: 'read', description: 'See the material library: materials, their units, colours, make or buy and Cr VI settings (the standard cost only with the cost grain).' },
  'materials.manage': { risk: 'write', description: 'Add materials, edit them, archive and reactivate them, and keep their colours; import them from a sheet.' },
  'materials.cost': { risk: 'write', description: "Set a material's standard purchase price, which quotes and cost sheets use (needs the cost grain)." },
})

export const PRODUCT_MATERIALS_VIEW = 'product.materials.view' satisfies Permission
export const PRODUCT_MATERIALS_MANAGE = 'product.materials.manage' satisfies Permission
export const PRODUCT_MATERIALS_COST = 'product.materials.cost' satisfies Permission
export const PRODUCT_MATERIALS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCT_MATERIALS_VIEW, PRODUCT_MATERIALS_MANAGE, PRODUCT_MATERIALS_COST])
