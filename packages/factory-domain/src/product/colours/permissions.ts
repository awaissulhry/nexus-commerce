import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The colour library (B-W2b-247; PRD-041; design products.colours, SCR-118). Office only (area `product`), checked with can()
 * over the colour's company (a colour of every company: a grant over every company).
 *
 *   colours.manage   keep the colour library: add a colour, change its names, system, reference, family and hex, archive
 *                    and restore it. The production manager, who keeps the styles and materials that name the colours.
 *
 * Reading the library is product.styles.view (a colourway picks its colour from it; W1's GET /product/colours). A colour's
 * photo is a file of the colour (files.upload).
 */
export const PRODUCT_COLOURS_DEFINITIONS = definePermissions('product', {
  'colours.manage': { risk: 'write', description: 'Keep the colour library: add colours, change their names, Pantone, RAL or NCS reference, family and hex, archive and restore them.' },
})

export const PRODUCT_COLOURS_MANAGE = 'product.colours.manage' satisfies Permission

export const PRODUCT_COLOURS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCT_COLOURS_MANAGE])

/** Who holds it (auth/roles/templates): the production manager; the owner from every(). */
export const PRODUCT_COLOURS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCT_COLOURS_MANAGE],
})
