import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Made-to-measure rules (B-W2b-248; PRD-201 … PRD-204; GATE-MTM). Office only (area `product`). Reading a template's rules
 * and asking the check is product.styles.view, keeping them (the plausibility rules, the base size rule, the alteration
 * limits) product.styles.manage: the templates are the Sizes & measurements library's, as the size scales and points of
 * measure (B-W2b-224). Marking a BOM line to scale is product.bom.manage (a part of the revision's BOM). A check that names
 * a rider's measurement profile also needs sales.measurements.view over the profile's customer (body measures are
 * personal data); the consumption is answered only with product.bom.view.
 *
 *   mtm.switch   turn a template's made-to-measure rules on or off. While off (how every template is built: Owner 11-09,
 *                question 5 A) nothing is checked; once on, a rider's link refuses measures a BLOCK rule breaks. It is the
 *                Owner's word that made-to-measure starts (GATE-MTM), so no template holds it: the owner from every().
 */
export const PRODUCT_MTM_DEFINITIONS = definePermissions('product', {
  'mtm.switch': {
    risk: 'write',
    description: "Turn a measurement template's made-to-measure rules (plausibility rules, base size rule, alteration limits) on or off: while off, nothing is checked.",
  },
})

export const PRODUCT_MTM_SWITCH = 'product.mtm.switch' satisfies Permission

export const PRODUCT_MTM_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCT_MTM_SWITCH])
