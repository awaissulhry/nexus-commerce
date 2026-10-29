import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The BOM's permissions (apps/factory-api modules/product/bom; features PRD-043, PRD-076, PRD-079, PRD-082, PRD-100), in
 * the product area. Each is checked with can() against the style's company; a tenant-wide style (no company) is written
 * only by a grant that reaches every company.
 *
 * Releasing is its own permission: it freezes the specification every later work order is made from (A1 §2.5) and
 * makes a draft style active, so the Owner can give the BOM to a product developer without the release.
 */
export const PRODUCT_BOM_DEFINITIONS = definePermissions('product', {
  'bom.view': { risk: 'read', description: "See a style revision's BOM: materials, quantities per size, colours per colourway, wastage and what each size needs; compare two revisions." },
  'bom.manage': { risk: 'write', description: "Edit a draft revision's BOM and its planned hide yield, copy a frozen revision into a new draft, and abandon a draft." },
  'bom.release': { risk: 'write', description: 'Release a draft revision (its BOM, routing and label are frozen; the style becomes active) and withdraw a released one.' },
})

export const PRODUCT_BOM_VIEW = 'product.bom.view' satisfies Permission
export const PRODUCT_BOM_MANAGE = 'product.bom.manage' satisfies Permission
export const PRODUCT_BOM_RELEASE = 'product.bom.release' satisfies Permission
export const PRODUCT_BOM_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCT_BOM_VIEW, PRODUCT_BOM_MANAGE, PRODUCT_BOM_RELEASE])
