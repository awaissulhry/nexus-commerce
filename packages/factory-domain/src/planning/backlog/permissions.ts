import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The backlog ranked (apps/factory-api modules/planning/backlog; B-W2b-317; PLN-177 "Backlog ranking drives allocation").
 * Checked with can() against the order's company (each order also with orders.view over its customer). Office only.
 *
 *   planning.backlog.manage   rank the open orders by hand (SalesOrder.backlogRank: 1 first, ties allowed), back to the rule
 *                             (no rank), or write the rule's order as the ranks. Allocation of scarce material and the promise
 *                             engine read the ranked backlog.
 *
 * Reading the ranked backlog is planning.view. Nothing here carries money or names a worker.
 */
export const PLANNING_BACKLOG_DEFINITIONS = definePermissions('planning', {
  'backlog.manage': {
    risk: 'write',
    description: 'Rank the open sales orders by hand (1 first), send them back to the rule (priority, promise, customer) or write the rule\'s order as the ranks; allocation of scarce material reads the ranked backlog.',
  },
})

export const PLANNING_BACKLOG_MANAGE = 'planning.backlog.manage' satisfies Permission

export const PLANNING_BACKLOG_PERMISSIONS: readonly Permission[] = Object.freeze([PLANNING_BACKLOG_MANAGE])

/**
 * Who holds it (auth/roles/templates; the owner from every(), read_only reads from the registry, a write is not read_only's):
 * the planner, who serves the backlog, and the production manager.
 */
export const PLANNING_BACKLOG_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  planner: [PLANNING_BACKLOG_MANAGE],
  production_manager: [PLANNING_BACKLOG_MANAGE],
})
