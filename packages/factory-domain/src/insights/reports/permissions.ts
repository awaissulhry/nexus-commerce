import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Home › Reports (B-W2a-79; ANA-029 standard report pack, ANA-034 reports obey data permissions; design home.reports,
 * SCR-104), in the home area, office only. One permission reaches the library: what a report shows is what the person's
 * other permissions reach (each report reads its module's own list, as that person: its scopes, its grains), and a
 * report whose list the person cannot read stays listed, said, and is not run. Nothing here writes.
 *
 *   reports.view   the report library, a report's results (filters, the rows, totals and groups), its schedule and what
 *                  it counts; print it
 */
export const HOME_REPORTS_DEFINITIONS = definePermissions('home', {
  'reports.view': {
    risk: 'read',
    description:
      'See the report library and run the standard reports, each said as the question it answers. A report shows only the records your other permissions reach, and money only with its rights (price, cost, margin); figures about groups of fewer than 5 people are hidden.',
  },
})

export const HOME_REPORTS_VIEW = 'home.reports.view' satisfies Permission

export const HOME_REPORTS_PERMISSIONS: readonly Permission[] = Object.freeze([HOME_REPORTS_VIEW])
