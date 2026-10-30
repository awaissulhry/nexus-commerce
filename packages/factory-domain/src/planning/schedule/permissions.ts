import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The planning board (apps/factory-api modules/planning/schedule; B-W2a-34; PLN-129, PLN-131, PLN-132, PLN-147,
 * PLN-160; design planning.board, planning.allocation; Owner answer P3). Reading the board, the allocation board and
 * the published versions is planning.view; changing the site's shared working plan and publishing it are these,
 * checked with can() against the site's company and the site. Office only. The floor reads the published plan as its
 * dispatch list with floor.work (modules/production/dispatch), and the office with workorders.view. Nothing here names
 * a person or carries money: load is per line, work centre and workshop (Statuto dei Lavoratori art. 4).
 */
export const PLANNING_SCHEDULE_DEFINITIONS = definePermissions('planning', {
  'schedule.manage': {
    risk: 'write',
    description:
      "Change the site's shared working plan: place work orders and their operations on lines, work centres and workshops, move them in time and between lanes, keep one on an overbooked lane with a reason, send them back to the tray, place them by their due dates, and allocate a work order (or part of it) to a line or a workshop. The floor sees none of it until the plan is published.",
  },
  'schedule.publish': {
    risk: 'write',
    description: "Publish the site's working plan to the floor as its next numbered version, for the days chosen: the lines' and stations' dispatch lists change to it from the time set.",
  },
})

export const PLANNING_SCHEDULE_MANAGE = 'planning.schedule.manage' satisfies Permission
export const PLANNING_SCHEDULE_PUBLISH = 'planning.schedule.publish' satisfies Permission

export const PLANNING_SCHEDULE_PERMISSIONS: readonly Permission[] = Object.freeze([PLANNING_SCHEDULE_MANAGE, PLANNING_SCHEDULE_PUBLISH])
