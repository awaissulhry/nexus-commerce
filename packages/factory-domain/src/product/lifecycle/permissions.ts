import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The style lifecycle and the product settings (B-W2b-221; PRD-007, PRD-008, PRD-105, PRD-182; design products.settings).
 * Office only (area `product`). Reading a style's lifecycle, the product types and the product settings is
 * product.styles.view (a type is picked on a style; the edit rule is what a style page shows). Each is checked with can()
 * against the record's company; a tenant-wide type or the tenant-wide settings are written only by a grant over every
 * company.
 *
 *   styles.lifecycle   move a style from concept to discontinued and back (one command per move) and name the style that
 *                      replaces it: decides what may still change in it. The production manager, who keeps the styles.
 *   settings.manage    keep the product types (required attributes, defaults, inheritance), the edit rule per lifecycle
 *                      state and the consumption tolerance. The production manager.
 *
 * Setting a style's type is product.styles.manage (a field of the style).
 */
export const PRODUCT_LIFECYCLE_DEFINITIONS = definePermissions('product', {
  'styles.lifecycle': { risk: 'write', description: 'Move a style through its lifecycle (concept, development, sampling, approved, in production, phase out, discontinued) and name the style that replaces it.' },
  'settings.manage': { risk: 'write', description: 'Keep the product types with their required attributes and defaults, the edit rule per lifecycle state and the consumption tolerance.' },
})

export const PRODUCT_LIFECYCLE_MOVE = 'product.styles.lifecycle' satisfies Permission
export const PRODUCT_SETTINGS_MANAGE = 'product.settings.manage' satisfies Permission

export const PRODUCT_LIFECYCLE_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCT_LIFECYCLE_MOVE, PRODUCT_SETTINGS_MANAGE])

/** Who holds them (auth/roles/templates): the production manager, beside product.styles.manage; the owner from every(). */
export const PRODUCT_LIFECYCLE_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCT_LIFECYCLE_MOVE, PRODUCT_SETTINGS_MANAGE],
})
