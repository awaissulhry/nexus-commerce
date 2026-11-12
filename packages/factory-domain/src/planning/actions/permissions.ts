import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * MRP you can trust (apps/factory-api modules/planning/actions; B-W2b-306; PLN-072, PLN-073, PLN-076, PLN-078; design
 * planning.mrp "To make" and Requirements' protected cell). Reading stays planning.view (the run's action messages, the run
 * log, a planned order's protected fields); hard-pegging a requirement to one order line is planning.firm (B-W2a-22's: the
 * same planner's act on a line of the latest plan as making it firm). Checked with can() against the site's company and the
 * site. Office only.
 *
 *   planning.actions.manage   work the plan's action messages on existing orders (expedite, defer, cancel, increase,
 *                             decrease): mark one or several done or ignored, with a note. An ignored message is not raised
 *                             again by the next run while it asks the same thing.
 *   planning.planned.edit     edit planned work and subcontract orders (size run, dates, line, workshop, steps, kit date,
 *                             revision): each field changed is protected from the next run until Reset to plan; several at
 *                             once with one review. Making one real is still planning.planned.convert.
 *
 * Nothing here carries money or names a worker.
 */
export const PLANNING_ACTIONS_DEFINITIONS = definePermissions('planning', {
  'actions.manage': {
    risk: 'write',
    description: "Work the plan's action messages on existing orders (expedite, defer, cancel, increase, decrease a purchase order line, work order, subcontract order or planned order): mark them done or ignored, with a note.",
  },
  'planned.edit': {
    risk: 'write',
    description: 'Edit planned work and subcontract orders (sizes, start and due dates, line, workshop, steps, kit date, revision), one or several with one review: each field changed is kept by the next runs until Reset to plan.',
  },
})

export const PLANNING_ACTIONS_MANAGE = 'planning.actions.manage' satisfies Permission
export const PLANNING_PLANNED_EDIT = 'planning.planned.edit' satisfies Permission

export const PLANNING_ACTIONS_PERMISSIONS: readonly Permission[] = Object.freeze([PLANNING_ACTIONS_MANAGE, PLANNING_PLANNED_EDIT])

/**
 * Who holds them (auth/roles/templates; the owner from every()): the planner both; the buyer works the messages (most are
 * about purchase order lines: expedite, defer, decrease, cancel); the production manager both (work orders, subcontract
 * orders, planned work). read_only gets none (writes; the page reads with planning.view).
 */
export const PLANNING_ACTIONS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  planner: [PLANNING_ACTIONS_MANAGE, PLANNING_PLANNED_EDIT],
  buyer: [PLANNING_ACTIONS_MANAGE],
  production_manager: [PLANNING_ACTIONS_MANAGE, PLANNING_PLANNED_EDIT],
})
