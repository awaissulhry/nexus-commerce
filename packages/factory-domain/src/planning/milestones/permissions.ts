import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Time & action (apps/factory-api modules/planning/milestones; B-W2b-263; PLN-186; design planning.milestones, SCR-253). Reading
 * it is planning.view (the planning module's), checked with can() against the sales order's company and customer. Office only.
 *
 *   planning.milestones.manage     add, change and remove a sales order's pre-production gates (kind, words, target date, the
 *                                  sample round it waits for, its planner), and mark a gate done on a day
 *   planning.milestones.override   let the order's work start before a gate is passed ("Start before the gate?"): only someone
 *                                  who is neither the gate's planner nor the person who added it, with a reason (the
 *                                  database holds the same rule); recorded on the gate and in the audit trail
 *
 * Nothing here carries money or names a worker; a gate's planner is an office person, named inside the gate.
 */
export const PLANNING_MILESTONES_DEFINITIONS = definePermissions('planning', {
  'milestones.manage': {
    risk: 'write',
    description: "Add, change and remove a sales order's pre-production gates (what must be true before its work may start, by when, whose: sample approved, leather approved, trims in, pre-production sample, lab passed, or in words), and mark a gate done.",
  },
  'milestones.override': {
    risk: 'write',
    description: "Let an order's work start before a pre-production gate is passed, with a reason: only someone who is neither the gate's planner nor the person who added it. Recorded on the gate and audited.",
  },
})

export const PLANNING_MILESTONES_MANAGE = 'planning.milestones.manage' satisfies Permission
export const PLANNING_MILESTONES_OVERRIDE = 'planning.milestones.override' satisfies Permission

export const PLANNING_MILESTONES_PERMISSIONS: readonly Permission[] = Object.freeze([PLANNING_MILESTONES_MANAGE, PLANNING_MILESTONES_OVERRIDE])

/**
 * Who holds them (auth/roles/templates; the owner from every()): the planner keeps the gates (and is their usual owner); the
 * production manager keeps them too and is the second person who may let work start before a gate. read_only gets none
 * (both are writes; the page reads with planning.view).
 */
export const PLANNING_MILESTONES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  planner: [PLANNING_MILESTONES_MANAGE],
  production_manager: [PLANNING_MILESTONES_MANAGE, PLANNING_MILESTONES_OVERRIDE],
})
