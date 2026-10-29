import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The style library's permissions (apps/factory-api modules/product/styles; features PRD-001, PRD-004, PRD-005,
 * PRD-047, PRD-048), in the product area: styles with their colourways, size range, SKU matrix and revision shells, and
 * the size scale library they pick from. Each is checked with can() against the record's company; a tenant-wide style
 * or scale (no company) is written only by a grant that reaches every company.
 */
export const PRODUCT_STYLES_DEFINITIONS = definePermissions('product', {
  'styles.view': { risk: 'read', description: 'See the styles: their colourways, size range, colour x size SKUs and barcodes, revisions, and the size scales.' },
  'styles.manage': { risk: 'write', description: 'Create and edit styles, their colourways, size range and SKUs, start a revision, archive and reactivate them; keep the size scales.' },
})

export const PRODUCT_STYLES_VIEW = 'product.styles.view' satisfies Permission
export const PRODUCT_STYLES_MANAGE = 'product.styles.manage' satisfies Permission
export const PRODUCT_STYLES_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCT_STYLES_VIEW, PRODUCT_STYLES_MANAGE])
