import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Rolls, protector lots and consumables (apps/factory-api modules/inventory/rolls; B-W2b-107; SCM-260, SCM-261, SCM-263).
 * Area `inventory`, beside the module's own list (inventory/permissions.ts). Checked with can() against the row's company
 * and site.
 *
 *   inventory.rolls.manage        the office corrects what a roll is (width, shade, shrinkage, defects, the supplier's
 *                                 number) and sets an end of roll aside. Tagging a lot's rolls is receiving's
 *                                 (inventory.receive), taking length off a roll or bringing its end back is the issue's
 *                                 (inventory.issue), moving it inventory.transfer, scrapping it inventory.scrap, correcting
 *                                 its length inventory.adjust: each roll write posts the lot's move the ledger already has.
 *   inventory.protectors.record   which protector lot a batch or one garment holds (EN 1621; Reg. (EU) 2016/425), recorded
 *                                 in the office or on the line's tablet at its own site; only the office withdraws a wrong
 *                                 record, with the reason (the recall's evidence). Shared with the floor.
 *
 * Reading rolls and consumables is inventory.stock.view; a batch's protectors workorders.view; a protector lot's recall
 * quality.lots.view; a consumable's pack is the material's (product.materials.manage); its minimum and maximum per site are
 * planning's item parameters (planning.items.manage).
 */
export const INVENTORY_ROLLS_DEFINITIONS = definePermissions('inventory', {
  'rolls.manage': {
    risk: 'write',
    description: "Correct a fabric roll's width, shade, shrinkage, defects and the supplier's roll number, and set an end of roll aside.",
  },
  'protectors.record': {
    risk: 'write',
    description: 'Record which protector lot a batch or one garment holds (EN 1621), and withdraw a wrong record with the reason (the office only): what a protector recall reads.',
  },
})

export const INVENTORY_ROLLS_MANAGE = 'inventory.rolls.manage' satisfies Permission
export const INVENTORY_PROTECTORS_RECORD = 'inventory.protectors.record' satisfies Permission
export const INVENTORY_ROLLS_PERMISSIONS: readonly Permission[] = Object.freeze([INVENTORY_ROLLS_MANAGE, INVENTORY_PROTECTORS_RECORD])
/** The floor records a garment's protector lot at its own site (the line's tablet). */
export const INVENTORY_ROLLS_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([INVENTORY_PROTECTORS_RECORD])
