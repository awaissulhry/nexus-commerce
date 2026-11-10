import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Materials in depth (B-W2b-238; PRD-029, PRD-033, PRD-035, PRD-036; design products.materials), in the product area,
 * office only. Each is checked with can() against the material's company; a material of every company (no company) is
 * decided only by a grant that reaches every company (as W1's writes of the library).
 *
 *   product.materials.approve   decide a material's approval: approve it, approve it on a condition (with the condition),
 *                               block it (with why: no new BOM line takes it, no revision naming it is released) or send
 *                               it back to pending
 *
 * Reading the approval, the properties of its kind and where it is used is product.materials.view; writing the properties
 * is W1's product.materials.manage. Where it is used shows the styles only with product.styles.view and the work orders
 * only with workorders.view, each over their own company and site.
 */
export const PRODUCT_MATERIALS_DEPTH_DEFINITIONS = definePermissions('product', {
  'materials.approve': {
    risk: 'write',
    description: "Decide a material's approval for use: approve it, approve it on a condition, block it (no new BOM line takes it and no revision naming it is released) or send it back to pending, always with why for a condition or a block.",
  },
})

export const PRODUCT_MATERIALS_APPROVE = 'product.materials.approve' satisfies Permission

export const PRODUCT_MATERIALS_DEPTH_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCT_MATERIALS_APPROVE])

/**
 * Who holds it (auth/roles/templates; the owner from every()): the production manager keeps the material library and its
 * BOMs; quality decides whether a material may go into a garment (PRD-035: "stops untested leather going into PPE
 * garments").
 */
export const PRODUCT_MATERIALS_DEPTH_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCT_MATERIALS_APPROVE],
  quality_inspector: [PRODUCT_MATERIALS_APPROVE],
})
