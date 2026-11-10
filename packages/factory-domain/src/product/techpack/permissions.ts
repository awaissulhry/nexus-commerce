import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The tech pack (B-W2b-230; PRD-130, PRD-131, PRD-133). Office only (area `product`), checked with can() over the style's
 * company (a tenant-wide style: over the company that keeps the copy).
 *
 *   techpacks.make   make a tech pack PDF of a style revision for an audience (internal, a workshop, a brand): a new stored
 *                    version of the revision's TECH_PACK document, made to go outside. The production manager, who keeps the
 *                    styles; the buyer, who sends the workshops their work.
 *
 * Reading the live tech pack is the revision's BOM (product.bom.view); its construction section also needs the routing
 * (product.routing.view), its protection and compliance sections the certificates (compliance.certificates.view). Reading the
 * stored versions and checking a scanned QR is product.bom.view / product.styles.view.
 */
export const PRODUCT_TECHPACKS_DEFINITIONS = definePermissions('product', {
  'techpacks.make': { risk: 'write', description: 'Make a tech pack PDF of a style revision for an audience (internal, a workshop, a brand): a partner copy never has a cost, a margin or a pay figure.' },
})

export const PRODUCT_TECHPACKS_MAKE = 'product.techpacks.make' satisfies Permission

export const PRODUCT_TECHPACKS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCT_TECHPACKS_MAKE])

/** Who holds it (auth/roles/templates): the production manager and the buyer (both read the BOM); the owner from every(). */
export const PRODUCT_TECHPACKS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCT_TECHPACKS_MAKE],
  buyer: [PRODUCT_TECHPACKS_MAKE],
})
