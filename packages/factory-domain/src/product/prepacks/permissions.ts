import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Prepacks (B-W2b-233; PRD-055; design products.styles › Sizes & measurements › Prepacks). Office only (area `product`),
 * checked with can() over the style's company (a style's prepack) or the size scale's (a prepack of every style of the
 * scale; a tenant-wide one only by a grant over every company). Reading them is product.styles.view (they are part of the
 * style a quote or an order reads; W2b-5 sales lets an order line take one).
 *
 *   prepacks.manage   keep the fixed size mixes dealers order: a prepack of one style or of every style of a size scale,
 *                     its pieces per size (and colourway), archive and restore. Sales, who sell the packs to dealers, and
 *                     the production manager, who keeps the styles.
 */
export const PRODUCT_PREPACKS_DEFINITIONS = definePermissions('product', {
  'prepacks.manage': {
    risk: 'write',
    description: 'Keep the prepacks dealers order: fixed mixes of pieces per size (and colourway) for one style or every style of a size scale; archive and restore them.',
  },
})

export const PRODUCT_PREPACKS_MANAGE = 'product.prepacks.manage' satisfies Permission

export const PRODUCT_PREPACKS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCT_PREPACKS_MANAGE])

/** Who holds it (auth/roles/templates): sales and the production manager; the owner from every(). */
export const PRODUCT_PREPACKS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCT_PREPACKS_MANAGE],
  sales: [PRODUCT_PREPACKS_MANAGE],
})
