import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Planned work orders and planned subcontract orders (apps/factory-api modules/planning/planned-orders; B-W2b-293;
 * PLN-067, PLN-069; design planning.mrp "To make", "Create 4 work orders"). Reading them is planning.view (the planning
 * module's), making one firm or planned again planning.firm (B-W2a-22's, as for a planned purchase), checked with can()
 * against the site's company and the site. Office only.
 *
 *   planning.planned.convert   make planned orders real: each becomes a DRAFT work order of its order lines (the revision
 *                              the lines name); a planned subcontract order also its work order's release and its
 *                              DRAFT subcontract order to the workshop. The work order itself is still made with
 *                              workorders.manage (and released with workorders.release), the subcontract order with
 *                              purchasing.subcontract.manage: this permission never widens what those allow.
 *
 * Nothing here carries money or names a worker.
 */
export const PLANNING_PLANNED_DEFINITIONS = definePermissions('planning', {
  'planned.convert': {
    risk: 'write',
    description: "Make the plan's planned work orders real (each a DRAFT work order of its order lines, at the revision the lines name) and its planned subcontract orders (the work order released and its subcontract order to the workshop drafted). Needs the work-order and subcontracting permissions too.",
  },
})

export const PLANNING_PLANNED_CONVERT = 'planning.planned.convert' satisfies Permission

export const PLANNING_PLANNED_PERMISSIONS: readonly Permission[] = Object.freeze([PLANNING_PLANNED_CONVERT])

/**
 * Who holds it (auth/roles/templates; the owner from every()): the planner, who turns demand into work every day, and the
 * production manager. read_only gets none (a write; the page reads with planning.view).
 */
export const PLANNING_PLANNED_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  planner: [PLANNING_PLANNED_CONVERT],
  production_manager: [PLANNING_PLANNED_CONVERT],
})
