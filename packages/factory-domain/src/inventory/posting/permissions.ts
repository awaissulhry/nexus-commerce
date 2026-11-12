import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Warehouse rules (apps/factory-api modules/inventory/posting; B-W2b-314; SCM-196, SCM-281, the design's warehouse.settings
 * ws-posting and ws-adjust). Area `inventory`, beside the module's own list (inventory/permissions.ts). Checked with can()
 * against the company of the rules (the tenant-wide rules: a grant over every company).
 *
 *   inventory.rules.manage   how many days back an office move may be dated (its posting date), the value above which an
 *                            adjustment waits for a yes (the cost grain too: the value is a cost), and whether a material
 *                            below its planning minimum raises an alert. Loosening a rule (more days back, no limit, a
 *                            higher value, no value) asks the reason and a fresh code.
 *
 * Reading the rules is inventory.stock.view; the value only with the cost grain. Who approves an adjustment is the approval
 * rule's (approvals.rules.manage, Admin › Automation), never this permission's.
 */
export const INVENTORY_RULES_DEFINITIONS = definePermissions('inventory', {
  'rules.manage': {
    risk: 'write',
    description:
      'Change the warehouse rules: how many days back a stock move may be dated, the value above which an adjustment waits for a yes (with the cost grain), and the low-stock alerts. Loosening one asks the reason and a fresh code.',
  },
})

export const INVENTORY_RULES_MANAGE = 'inventory.rules.manage' satisfies Permission
export const INVENTORY_RULES_PERMISSIONS: readonly Permission[] = Object.freeze([INVENTORY_RULES_MANAGE])

/**
 * Who holds it (auth/roles/templates; the owner from every()): the warehouse, whose rules they are, and finance, who sees
 * the value of an adjustment (the warehouse template has no cost grain) and closes the months the posting dates go into.
 */
export const INVENTORY_RULES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  warehouse: [INVENTORY_RULES_MANAGE],
  finance: [INVENTORY_RULES_MANAGE],
})
