import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Hides as stock (apps/factory-api modules/inventory/hides; B-W2b-94; SCM-249, SCM-250; design warehouse.hides record
 * "Measurements & grade"). Area `inventory`, beside the module's own list (inventory/permissions.ts). Checked with can()
 * against the hide's lot's company and site; office only. Reading a hide's grading, its measures, a lot's area check and
 * the grade mix is inventory.stock.view; an article's grades and usable shares are the material's (product.materials.view
 * | manage). Correcting the stock after a re-measure is an adjustment move, so it also needs inventory.adjust.
 */
export const INVENTORY_HIDES_DEFINITIONS = definePermissions('inventory', {
  'hides.manage': {
    risk: 'write',
    description:
      "Correct a hide's grade, shade group, thickness and defects (with the reason once it is cut), and re-measure a whole hide against the tannery's area; correcting its stock after a re-measure also needs inventory.adjust.",
  },
})

export const INVENTORY_HIDES_MANAGE = 'inventory.hides.manage' satisfies Permission
export const INVENTORY_HIDES_PERMISSIONS: readonly Permission[] = Object.freeze([INVENTORY_HIDES_MANAGE])
