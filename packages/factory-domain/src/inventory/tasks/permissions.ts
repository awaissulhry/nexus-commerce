import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * The warehouse task inbox (B-W2b-292; SCM-274; apps/factory-api modules/inventory/tasks). Area `inventory`, beside the
 * module's own list (inventory/permissions.ts). Checked with can() against the task's company and site.
 *
 *   inventory.tasks.manage   the office makes a task by hand (a delivery to receive, goods to move, a count, a put-away),
 *                            hands it to a floor role or one worker of the site (or to anyone there), changes its due time,
 *                            places, quantity and note, and cancels it with the reason. Office only.
 *
 * Reading a site's tasks is inventory.stock.view (the office) and floor.work (the tablet's inbox at its own site). Taking,
 * giving back and doing a task on the floor is floor.work; doing it also needs its act's permission at the site (factory-domain
 * inventory/tasks/rules TASK_ACTS: a move inventory.transfer, a pick inventory.issue, a delivery inventory.receive). Tasks
 * made by their sources (a receipt, a hold, a pick list, a count schedule) need nobody's permission: the system makes them.
 */
export const INVENTORY_TASKS_DEFINITIONS = definePermissions('inventory', {
  'tasks.manage': {
    risk: 'write',
    description: "Make the warehouse's floor tasks by hand (receive, put away, pick, move, count), hand them to a floor role or one worker of the site, change them and cancel them with the reason.",
  },
})

export const INVENTORY_TASKS_MANAGE = 'inventory.tasks.manage' satisfies Permission
export const INVENTORY_TASKS_PERMISSIONS: readonly Permission[] = Object.freeze([INVENTORY_TASKS_MANAGE])

/**
 * Who holds it (auth/roles/templates): the warehouse, who hands out the floor's work (the owner from every()). Nobody else
 * changes the floor's tasks; quality's quarantine moves are made by its holds.
 */
export const INVENTORY_TASKS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  warehouse: [INVENTORY_TASKS_MANAGE],
})
