import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * The work order close's own permission (B-W2b-411; MES-013), in the work orders' area, office only. Closing a COMPLETED
 * work order (with its reason beyond the tolerance) and the closer's Undo within a few seconds are workorders.manage, as
 * the other moves are. Reading the close's variance split and the scrap and rework cost is costing.view (figures with
 * money.cost).
 *
 *   reopen   take a close back later, or one someone else made, with a reason: its variance and closing entries are
 *            reversed and the work order is COMPLETED again
 */
export const WORK_ORDER_CLOSE_DEFINITIONS = definePermissions('workorders', {
  reopen: {
    risk: 'write',
    description:
      "Reopen a closed work order, with a reason: its close is taken back (its variance and closing entries reversed, the work order COMPLETED again) so it can be corrected and closed again. The person who closed it undoes it without a reason for a few seconds after the close.",
  },
})

export const WORKORDERS_REOPEN = 'workorders.reopen' satisfies Permission

export const WORK_ORDER_CLOSE_PERMISSIONS: readonly Permission[] = Object.freeze([WORKORDERS_REOPEN])

/** The role templates that get it (owner: every()): the production manager, who closes the work orders. */
export const WORK_ORDER_CLOSE_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [WORKORDERS_REOPEN],
})
