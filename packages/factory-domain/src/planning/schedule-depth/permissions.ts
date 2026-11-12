import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Scheduling in depth (apps/factory-api modules/planning/schedule-depth; B-W2b-312; PLN-130, PLN-134, PLN-139, PLN-141; design
 * planning.board "Pin (W2b)", "What-if", "Reschedule backlog (W2b)", "Material-aware (W2b)"). Checked with can() against the
 * site's company and the site. Office only.
 *
 *   planning.schedule.pin   pin a bar (or every slot of a work order) of the site's working plan where it is, or unpin it: a
 *                           pinned slot keeps its lane and times until it is unpinned; moves, a backlog reschedule and
 *                           forward scheduling go around it (PLN-139: "Planner; Supervisor": promised work and customer visits
 *                           must not move).
 *
 * Forward scheduling, the backlog reschedule and what-if moves change the shared working plan: planning.schedule.manage
 * (B-W2a-34's), as every other move. Nothing here carries money or names a worker.
 */
export const PLANNING_SCHEDULE_DEPTH_DEFINITIONS = definePermissions('planning', {
  'schedule.pin': {
    risk: 'write',
    description:
      "Pin a bar or a whole work order of the site's working plan where it is, or unpin it: a pinned slot keeps its lane and times until it is unpinned, and rescheduling moves around it. The floor sees it with the next publish.",
  },
})

export const PLANNING_SCHEDULE_PIN = 'planning.schedule.pin' satisfies Permission

export const PLANNING_SCHEDULE_DEPTH_PERMISSIONS: readonly Permission[] = Object.freeze([PLANNING_SCHEDULE_PIN])

/**
 * Who holds it (auth/roles/templates; the owner from every(), read_only reads from the registry): the planner, who keeps the
 * board, and the production manager (the board's supervisor in the office: it reads the board and pins what must not move,
 * without moving bars itself).
 */
export const PLANNING_SCHEDULE_DEPTH_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  planner: [PLANNING_SCHEDULE_PIN],
  production_manager: [PLANNING_SCHEDULE_PIN],
})
