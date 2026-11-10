import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The branding sets of private-label customers (B-W2b-247; PRD-045; design products.colours sec:colours.branding,
 * pop:colours.branding). Office only (area `product`), checked with can() over the set's company and its brand (party).
 *
 *   branding.manage   keep a brand's branding set: its logos and label artwork (files of the set), its packaging rules
 *                     and brand colours; start a new set (the brand's old one archived), archive and restore. Sales, who
 *                     agree the brand's assets with the customer, and the production manager, whose labels and tech packs
 *                     use them.
 *
 * Reading the sets is product.styles.view (a style's labels and tech pack read its brand's set). Sending a file is
 * files.upload.
 */
export const PRODUCT_BRANDING_DEFINITIONS = definePermissions('product', {
  'branding.manage': {
    risk: 'write',
    description: "Keep the private-label brands' branding sets: logos, label artwork, packaging rules and brand colours; start a new set, archive and restore one.",
  },
})

export const PRODUCT_BRANDING_MANAGE = 'product.branding.manage' satisfies Permission

export const PRODUCT_BRANDING_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCT_BRANDING_MANAGE])

/** Who holds it (auth/roles/templates): sales and the production manager; the owner from every(). */
export const PRODUCT_BRANDING_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCT_BRANDING_MANAGE],
  sales: [PRODUCT_BRANDING_MANAGE],
})
