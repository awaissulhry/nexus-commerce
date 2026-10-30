import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Receiving every day (apps/factory-api modules/inventory/receipts; B-W2a-31; SCM-115, SCM-118, SCM-123, SCM-248;
 * design warehouse.receipts rec "Discrepancies"). Area `inventory`, beside the module's own list (inventory/permissions.ts).
 * Checked with can() against the receipt's company and site; office only. Reading a receipt's discrepancies, its
 * delivery-note photos and a hide list's totals is inventory.stock.view; adding a delivery-note photo is inventory.receive
 * (office and floor) with files.upload (office); importing a tannery's hide list is inventory.receive with imports.run and
 * imports.apply. No money anywhere here (Owner answer C2: no prices on what a supplier receives).
 */
export const INVENTORY_DISCREPANCIES_DEFINITIONS = definePermissions('inventory', {
  'discrepancies.manage': {
    risk: 'write',
    description: "Record what was wrong with a delivery (short, over, damaged, the wrong item or colour, a missing document) on its receipt with the reason, the line, the quantity, a note and photos; change or remove one not yet reported; record the supplier's answer (agreed, credited) and close it with what settled it.",
  },
  'discrepancies.report': {
    risk: 'write',
    description: "Send the discrepancy report (a PDF without prices) to the supplier's contacts by e-mail, on the receipt's thread; the discrepancies it names become reported.",
  },
})

export const INVENTORY_DISCREPANCIES_MANAGE = 'inventory.discrepancies.manage' satisfies Permission
export const INVENTORY_DISCREPANCIES_REPORT = 'inventory.discrepancies.report' satisfies Permission

export const INVENTORY_DISCREPANCIES_PERMISSIONS: readonly Permission[] = Object.freeze([INVENTORY_DISCREPANCIES_MANAGE, INVENTORY_DISCREPANCIES_REPORT])
