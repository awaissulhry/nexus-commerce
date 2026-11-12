import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Promise dates (apps/factory-api modules/planning/promise; B-W2b-301; PLN-168, PLN-169, PLN-171, PLN-179; design
 * planning.promise "Available to promise", the "Promise calculator", Sales › Quote "Suggest date" / "Check capacity").
 * Checked with can() against the site's company and the site (a quote or an order line also with its own view permission:
 * quotes.view, orders.view over its company and customer). Office only.
 *
 *   planning.promise.view     read available to promise per size, colour and week, and ask when an order can be ready:
 *                             the promise calculator (capacity, material, certificates), a quote's suggested dates and an
 *                             order line's dates per size. Nothing is written. Sales asks it at every quote (Rule 1).
 *   planning.promise.manage   record an order line's promise per size (the first promise of a size, or a size promised
 *                             apart from the line's date with its reason): planning owns promise dates (PLN-171). Only a
 *                             size a valid certificate covers through the date is promised (PLN-179).
 *
 * Nothing here carries money or names a worker.
 */
export const PLANNING_PROMISE_DEFINITIONS = definePermissions('planning', {
  'promise.view': {
    risk: 'read',
    description: 'See available to promise per size, colour and week, and ask when an order can be ready (the promise calculator, a quote\'s suggested dates, an order line\'s dates per size). Writes nothing.',
  },
  'promise.manage': {
    risk: 'write',
    description: "Record an order line's promise per size (a size's first promise, or a size promised apart with its reason); only sizes a valid certificate covers through the date.",
  },
})

export const PLANNING_PROMISE_VIEW = 'planning.promise.view' satisfies Permission
export const PLANNING_PROMISE_MANAGE = 'planning.promise.manage' satisfies Permission

export const PLANNING_PROMISE_PERMISSIONS: readonly Permission[] = Object.freeze([PLANNING_PROMISE_VIEW, PLANNING_PROMISE_MANAGE])

/**
 * Who holds them (auth/roles/templates; the owner from every(), read_only reads from the registry): the planner, who owns
 * promise dates, and the production manager read and record them; sales asks "when?" on every quote (the calculator, the
 * quote's suggested dates) and records nothing here (sales keeps typing the order's date, W1).
 */
export const PLANNING_PROMISE_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  planner: [PLANNING_PROMISE_VIEW, PLANNING_PROMISE_MANAGE],
  production_manager: [PLANNING_PROMISE_VIEW, PLANNING_PROMISE_MANAGE],
  sales: [PLANNING_PROMISE_VIEW],
})
