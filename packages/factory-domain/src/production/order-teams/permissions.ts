import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Teams own the work (owb- order workflow, plan.md § 5 D R43; PL-schema § 5A row 10 `OrderTeam`; PL-split S3 ss5): which team
 * of a site makes an order (one in charge; in SPLIT mode each team its share of the baskets), give an order to another team,
 * lend a team, end a team's part. Checked with can() against the order's company and party and the team's site. Office only;
 * nothing here carries money or measures a person.
 *
 *   production.teams.assign   give an order (or some of its baskets) to a team, change the team in charge, split the baskets
 *                             between teams, end a team's part
 */
export const PRODUCTION_ORDER_TEAMS_DEFINITIONS = definePermissions('production', {
  'teams.assign': {
    risk: 'write',
    description:
      "Give an order, or some of its baskets, to a team of the site: the team in charge, the teams that share the baskets and how many each makes; change or end a team's part.",
  },
})

export const PRODUCTION_TEAMS_ASSIGN = 'production.teams.assign' satisfies Permission

export const PRODUCTION_ORDER_TEAMS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_TEAMS_ASSIGN])

/**
 * The role templates (roles/templates addedFor; the Owner from every()). The production manager, the planner and the floor
 * supervisor give work to teams (plan.md § 5 D). The floor's team leader hands baskets out with production.dispatch.manage,
 * not this one.
 */
export const PRODUCTION_ORDER_TEAMS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCTION_TEAMS_ASSIGN],
  planner: [PRODUCTION_TEAMS_ASSIGN],
  floor_supervisor: [PRODUCTION_TEAMS_ASSIGN],
})
