import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * GTINs from the company's own GS1 range (B-W2b-227; PRD-006). Office only (area `product`), checked with can() over the
 * range's company (a range belongs to one company; a style's SKUs take numbers of their style's company only).
 *
 *   gtins.manage   keep the company's GS1 GTIN ranges (prefix, block of item references, archive) and give a style's SKUs
 *                  GTINs from one, after a preview: numbers paid for, given once and never again. The production manager,
 *                  who keeps the styles.
 *
 * Reading the ranges is product.styles.view (the Assign GTINs preview shows the next free numbers). Typing or importing a
 * brand's own barcodes on its SKUs is product.styles.manage (W1's "SKUs and barcodes").
 */
export const PRODUCT_GTINS_DEFINITIONS = definePermissions('product', {
  'gtins.manage': { risk: 'write', description: "Keep the company's GS1 GTIN ranges and give a style's SKUs GTINs from them (a preview first; a GTIN is never given twice)." },
})

export const PRODUCT_GTINS_MANAGE = 'product.gtins.manage' satisfies Permission

export const PRODUCT_GTINS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCT_GTINS_MANAGE])

/** Who holds it (auth/roles/templates): the production manager, beside product.styles.manage; the owner from every(). */
export const PRODUCT_GTINS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCT_GTINS_MANAGE],
})
