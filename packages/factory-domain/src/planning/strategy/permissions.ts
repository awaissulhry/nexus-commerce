import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The production strategy per item (apps/factory-api modules/planning/strategy; B-W2b-319; PLN-061; design planning.mps
 * sec:strategy). Reading it, and the one demand view (modules/planning/demand), is planning.view (the planning module's), checked
 * with can() against the site's company and the site. Office only. Nothing here carries money or names a worker.
 *
 *   planning.strategy.manage   set how a site meets the demand for a finished garment or a component: make to order, make to
 *                              stock or assemble to order (one item, or many in one change), with a reason
 */
export const PLANNING_STRATEGY_DEFINITIONS = definePermissions('planning', {
  'strategy.manage': {
    risk: 'write',
    description: 'Set how a site meets the demand for a finished garment or a component we make: make to order (wait for the customer’s order), make to stock (build ahead from a forecast) or assemble to order, for one item or many at once, with a reason.',
  },
})

export const PLANNING_STRATEGY_MANAGE = 'planning.strategy.manage' satisfies Permission

export const PLANNING_STRATEGY_PERMISSIONS: readonly Permission[] = Object.freeze([PLANNING_STRATEGY_MANAGE])

/**
 * Who holds it (auth/roles/templates; the owner from every()): the planner, who plans the site, and the production manager, who runs
 * what it makes. read_only gets none (a write; the page reads with planning.view); the buyer keeps the item parameters it buys by
 * (planning.items.manage), not how a garment is made.
 */
export const PLANNING_STRATEGY_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  planner: [PLANNING_STRATEGY_MANAGE],
  production_manager: [PLANNING_STRATEGY_MANAGE],
})
