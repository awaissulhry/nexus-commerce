import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * The planning module's permissions (apps/factory-api modules/planning; features PLN-062, PLN-063, PLN-064, PLN-065,
 * PLN-066; A2 SCR-055 "What to buy & make"). Each is checked with can() against the site's company and the site a run
 * plans for. Office only: no floor role holds them. Nothing here carries money: a line's expected cost also needs the
 * cost grain (money.cost), which the answer's marked fields follow.
 */
export const PLANNING_DEFINITIONS = definePermissions('planning', {
  view: { risk: 'read', description: "See a site's planning runs: what the confirmed orders need, the stock the plan may use and why the rest is not counted, what is on order, what is short and what to buy or make, and which orders drive each line." },
  run: { risk: 'write', description: 'Run the plan for a site now: a new run replaces the previous one; two runs of one site never overlap.' },
  decide: { risk: 'write', description: 'Set lines of the latest plan aside with a reason (the customer supplies it, a substitute, stock not in the system yet), and open them again.' },
})

export const PLANNING_VIEW = 'planning.view' satisfies Permission
export const PLANNING_RUN = 'planning.run' satisfies Permission
export const PLANNING_DECIDE = 'planning.decide' satisfies Permission

export const PLANNING_PERMISSIONS: readonly Permission[] = Object.freeze([PLANNING_VIEW, PLANNING_RUN, PLANNING_DECIDE])
