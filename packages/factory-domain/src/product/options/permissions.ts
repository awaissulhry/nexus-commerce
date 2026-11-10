import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Options and configuration rules (B-W2b-229; PRD-081, PRD-206, PRD-207, PRD-208, PRD-211; design products.options, SCR-114).
 * Office only (area `product`), each checked with can() over the option group's company (a tenant-wide group is written only
 * by a grant over every company). Reading the option library, a style's offers and the configuration check is
 * product.styles.view (the library is picked on a style; a quote reads it in W2b-5).
 *
 *   options.manage   keep the option library: groups (kind, minimum and maximum picks), their values and free-text rules,
 *                    the requires and excludes rules, and what a value does to the garment (BOM lines added, replaced or
 *                    left out, an operation, minutes, "outside the certificate"). The production manager, who keeps the
 *                    styles and their BOMs.
 *   options.price    set the price surcharge of an option value (an amount or a percent; money.price too). Sales, who
 *                    price the garments; the production manager sees no money.
 *
 * Offering a group on a style is product.styles.manage (a change of the style's spec, under its edit rule); a draft BOM
 * line only for an option is product.bom.manage; a routing step only for an option is product.routing.manage.
 */
export const PRODUCT_OPTIONS_DEFINITIONS = definePermissions('product', {
  'options.manage': {
    risk: 'write',
    description: 'Keep the option library: option groups and their values, free-text values, the requires and excludes rules, and what an option does to the BOM, the routing, the minutes and the certificate.',
  },
  'options.price': { risk: 'write', description: 'Set the price surcharge of an option (an amount or a percent of the price; needs the price grain too).' },
})

export const PRODUCT_OPTIONS_MANAGE = 'product.options.manage' satisfies Permission
export const PRODUCT_OPTIONS_PRICE = 'product.options.price' satisfies Permission

export const PRODUCT_OPTIONS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCT_OPTIONS_MANAGE, PRODUCT_OPTIONS_PRICE])

/** Who holds them (auth/roles/templates): the production manager keeps the library, sales prices it; the owner from every(). */
export const PRODUCT_OPTIONS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCT_OPTIONS_MANAGE],
  sales: [PRODUCT_OPTIONS_PRICE],
})
