import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Planning reports (apps/factory-api modules/planning/reports; B-W2b-349; design planning.reports SCR-254), in the planning
 * area, office only. Checked with can() against the site the report is about, together with planning.view over that site (a
 * site the caller does not plan is not found): schedule adherence, the utilisation trend and the material cover all read the
 * site's plan and its work orders.
 *
 * Read only: nothing here writes, so no command, audit row or event. No money (minutes, days, quantities) and no person.
 */
export const PLANNING_REPORTS_DEFINITIONS = definePermissions('planning', {
  'reports.view': {
    risk: 'read',
    description:
      'See the planning reports of a site: planned against actual start and finish of the finished work orders per line and week, load and utilisation per line, the plant and each workshop over the weeks, the days of cover and projected stock-out date of each material, the work orders behind each figure, and their print view.',
  },
})

export const PLANNING_REPORTS_VIEW = 'planning.reports.view' satisfies Permission

export const PLANNING_REPORTS_PERMISSIONS: readonly Permission[] = Object.freeze([PLANNING_REPORTS_VIEW])

/**
 * Who holds it (auth/roles/templates): the planner and the production manager (the monthly planning review: adherence and
 * utilisation) and the buyer (the material cover and its stock-out dates). Office only; the owner and read-only from every().
 * Each of them already plans the site with planning.view.
 */
export const PLANNING_REPORTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  planner: [PLANNING_REPORTS_VIEW],
  production_manager: [PLANNING_REPORTS_VIEW],
  buyer: [PLANNING_REPORTS_VIEW],
})
