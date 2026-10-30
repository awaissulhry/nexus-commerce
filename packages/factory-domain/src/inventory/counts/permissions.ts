import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Stock counts and the year-end physical inventory (apps/factory-api modules/inventory/counts; B-W2a-15; SCM-224,
 * SCM-230; SCM-229 and SCM-293 for the approval; design warehouse.counts, SCR-132). Area `inventory`, beside the
 * module's own list (inventory/permissions.ts). Checked with can() against the count's company and site; office only
 * (counting by scan on the floor is W2b, floor.count). Applying the differences is `inventory.adjust` ("post a count's
 * differences"); values (the differences' worth, the valued list) also need the cost grain, `money.cost`.
 */
export const INVENTORY_COUNTS_DEFINITIONS = definePermissions('inventory', {
  'counts.view': {
    risk: 'read',
    description: 'See the stock counts and the year-end inventories of a site: their lines, what was expected and counted, the differences and their reasons, the approval, and print the count sheets (values only with the cost grain).',
  },
  'counts.manage': {
    risk: 'write',
    description: 'Open a cycle count or the year-end inventory of a site and start it (the expected quantities frozen), type what was counted, add what was found, ask for recounts, give the reasons, submit the count and cancel one before it is applied.',
  },
  'counts.approve': {
    risk: 'write',
    description: "Approve a submitted count's differences, or send it back for a recount with the reason. Over the approval limit, never the differences one counted oneself.",
  },
  'counts.signoff': {
    risk: 'write',
    description: 'Sign off an applied year-end inventory with its number typed: the valued list as of the inventory date (c.c. art. 2217) is frozen as a file of the count. Needs the cost grain.',
  },
})

export const INVENTORY_COUNTS_VIEW = 'inventory.counts.view' satisfies Permission
export const INVENTORY_COUNTS_MANAGE = 'inventory.counts.manage' satisfies Permission
export const INVENTORY_COUNTS_APPROVE = 'inventory.counts.approve' satisfies Permission
export const INVENTORY_COUNTS_SIGNOFF = 'inventory.counts.signoff' satisfies Permission

export const INVENTORY_COUNTS_PERMISSIONS: readonly Permission[] = Object.freeze([INVENTORY_COUNTS_VIEW, INVENTORY_COUNTS_MANAGE, INVENTORY_COUNTS_APPROVE, INVENTORY_COUNTS_SIGNOFF])
