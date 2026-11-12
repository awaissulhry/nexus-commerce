import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Work to subcontractors (apps/factory-api modules/planning/subcontract-capacity, capacity/subcontractors.ts, heatmap;
 * B-W2b-321; PLN-117, PLN-124, PLN-162, PLN-164, PLN-165; design planning.allocation, planning.capacity). Reading is
 * planning.view (the planning module's), checked with can() against the site's company and the site (a workshop's
 * capacity: its company, or every company for a tenant-wide workshop). Office only.
 *
 *   planning.subcontract.capacity   keep a workshop's weekly capacity: minutes or garments a week per kind of work, from a
 *                                   day until a day (PLN-124)
 *   planning.subcontract.outsource  send one operation of a work order outside to an approved workshop or bring it back
 *                                   in, and set when the kit must leave on a draft subcontract order (PLN-164, PLN-165).
 *                                   Making or cancelling the subcontract order itself still needs
 *                                   purchasing.subcontract.manage: this permission never widens what that allows
 *
 * Nothing here carries money or names a worker.
 */
export const PLANNING_SUBCONTRACT_DEFINITIONS = definePermissions('planning', {
  'subcontract.capacity': {
    risk: 'write',
    description: "Keep the workshops' weekly capacity: minutes or garments a week per kind of work, from a day until a day.",
  },
  'subcontract.outsource': {
    risk: 'write',
    description: "Send one operation of a work order outside to an approved workshop or bring it back in, and set when a draft subcontract order's kit must leave. Making or cancelling the subcontract order needs the subcontracting permission too.",
  },
})

export const PLANNING_SUBCONTRACT_CAPACITY = 'planning.subcontract.capacity' satisfies Permission
export const PLANNING_SUBCONTRACT_OUTSOURCE = 'planning.subcontract.outsource' satisfies Permission

export const PLANNING_SUBCONTRACT_PERMISSIONS: readonly Permission[] = Object.freeze([PLANNING_SUBCONTRACT_CAPACITY, PLANNING_SUBCONTRACT_OUTSOURCE])

/**
 * Who holds them (auth/roles/templates; the owner from every()): the planner, who fills the workshops every week, the
 * production manager, and the buyer, who agrees the workshops' capacity and drafts their orders. read_only gets none.
 */
export const PLANNING_SUBCONTRACT_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  planner: [PLANNING_SUBCONTRACT_CAPACITY, PLANNING_SUBCONTRACT_OUTSOURCE],
  production_manager: [PLANNING_SUBCONTRACT_CAPACITY, PLANNING_SUBCONTRACT_OUTSOURCE],
  buyer: [PLANNING_SUBCONTRACT_CAPACITY, PLANNING_SUBCONTRACT_OUTSOURCE],
})
