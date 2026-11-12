import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Counts in depth (B-W2b-299; SCM-226 … SCM-229, SCM-293; apps/factory-api modules/inventory/counts-depth). Area `inventory`,
 * beside the counts' own list (inventory/counts/permissions.ts). Checked with can() against the count's company and site.
 *
 *   inventory.counts.scan   count a running count by scanning every unit (a hide's area, a roll's length, the pieces on the
 *                           number pad), say "Bin done" and finish a bin; recount a line the office or the rule asked (never
 *                           one's own count while the separation rule is on). Shared with the floor (a warehouse phone or
 *                           tablet at its own site); never a cost.
 *
 * Count schedules are planned with inventory.counts.manage and read with inventory.counts.view; the frozen lines read with
 * inventory.counts.view; the separation switches are the warehouse rules' (inventory.rules.manage, B-W2b-314). The yes on a
 * count's differences over an approval rule is the approval engine's (approvals.decide, kind COUNT_VARIANCE).
 */
export const INVENTORY_COUNTS_DEPTH_DEFINITIONS = definePermissions('inventory', {
  'counts.scan': {
    risk: 'write',
    description: 'Count a running stock count by scanning every unit on a warehouse phone or tablet (a hide with its area, a roll with its length, pieces on the number pad), see the bin’s differences after Bin done, finish the bin and recount a line someone else counted.',
  },
})

export const INVENTORY_COUNTS_SCAN = 'inventory.counts.scan' satisfies Permission
export const INVENTORY_COUNTS_DEPTH_PERMISSIONS: readonly Permission[] = Object.freeze([INVENTORY_COUNTS_SCAN])

/** The ones a floor role may hold too (the floor counts by scan at its own site). */
export const INVENTORY_COUNTS_DEPTH_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([INVENTORY_COUNTS_SCAN])

/**
 * Who holds it (auth/roles/templates): the warehouse in the office (a phone at the shelves), and on the floor the operator and
 * the team leader (who receive and move stock today). The owner from every().
 */
export const INVENTORY_COUNTS_DEPTH_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  warehouse: [INVENTORY_COUNTS_SCAN],
})
export const INVENTORY_COUNTS_DEPTH_FLOOR_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  operator: [INVENTORY_COUNTS_SCAN],
  team_leader: [INVENTORY_COUNTS_SCAN],
})
