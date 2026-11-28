import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The product draft (owb- order workflow, plan.md § 5 D R40 "the designer edits drafts only"; the design's R40 "the designer
 * makes the product draft, the owner releases it"; base settle 5). Checked with can() against the style's company. The write
 * routes of a style (apps/factory-api modules/product) accept product.styles.manage, OR this right AND the revision is DRAFT:
 * the server keeps "a DRAFT only" (S4). Office only; never a price, a cost or a release.
 *
 *   product.drafts.edit   make a product and change a DRAFT revision of it: the style, its materials (BOM), its sizes and its
 *                         route; never release, archive or price it (release stays product.bom.release, archive and the size
 *                         scales stay product.styles.manage)
 */
export const PRODUCT_DRAFTS_DEFINITIONS = definePermissions('product', {
  'drafts.edit': {
    risk: 'write',
    description: 'Make a product and change a draft of it: the style, its materials, its sizes and its route. Never release, archive or price it.',
  },
})

export const PRODUCT_DRAFTS_EDIT = 'product.drafts.edit' satisfies Permission

export const PRODUCT_DRAFTS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCT_DRAFTS_EDIT])

/**
 * The role templates (roles/templates addedFor; the Owner from every()). The Factory designer makes the product draft (R40, the
 * Owner's yes on plan.md § 5 D); the people who hold product.styles.manage need nothing more.
 */
export const PRODUCT_DRAFTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  designer: [PRODUCT_DRAFTS_EDIT],
})
