import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Moving baskets by hand (owb- order workflow, plan.md § 5 D R56 and decision D3; PL-schema § 4 and § 5A row 12 `BasketMove`,
 * `BasketRouteEdit`; PL-split S5 fl2). A basket is a bundle; its place is its scans plus its moves. A hand move writes a
 * `BasketMove` row and never a scan, a pay line or a cost line; the scan guard does not change. Checked with can() against the
 * work order's company and site; a floor device works at its own site only (can() pins it, row-level security too). Shared
 * with the floor (FLOOR_SHARED_PERMISSIONS): both are done on a phone as much as in the office.
 *
 *   production.baskets.move    move a basket FORWARD by hand, or "Take it here" (into the device's department), without a
 *                              scan and without pay
 *   production.baskets.route   move a basket BACK (a reason), undo another person's move, and change the steps of a basket
 *                              (skip a step, put one back, add one before the last, back to normal; a reason)
 *
 * Nothing here names the worker in a list, a filter or a total (Statuto dei Lavoratori art. 4); a move names its worker only
 * inside one basket's history, and only where the site's floor records name workers (people/privacy worker gate).
 */
export const PRODUCTION_BASKETS_DEFINITIONS = definePermissions('production', {
  'baskets.move': {
    risk: 'write',
    description: 'Move a basket forward to its next step by hand, or take it into your department, without a scan and without pay (a floor device: at its own site).',
  },
  'baskets.route': {
    risk: 'write',
    description:
      "Move a basket back with a reason, undo another person's move, and change a basket's steps: skip a step, put one back, add one before the last, or back to normal (a floor device: at its own site).",
  },
})

export const PRODUCTION_BASKETS_MOVE = 'production.baskets.move' satisfies Permission
export const PRODUCTION_BASKETS_ROUTE = 'production.baskets.route' satisfies Permission

export const PRODUCTION_BASKETS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_BASKETS_MOVE, PRODUCTION_BASKETS_ROUTE])

/** What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): both, at its own site. */
export const PRODUCTION_BASKETS_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_BASKETS_MOVE, PRODUCTION_BASKETS_ROUTE])

/**
 * The role templates (roles/templates addedFor; the Owner from every()). Decision D3 / R56, the Owner's yes: "a worker moves
 * forward only; the team leader moves back and changes the steps". Office: the production manager and the floor supervisor do
 * both. Floor: the team leader does both; the operator, the cutting operator and the floor inspector move forward only.
 */
export const PRODUCTION_BASKETS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCTION_BASKETS_MOVE, PRODUCTION_BASKETS_ROUTE],
  floor_supervisor: [PRODUCTION_BASKETS_MOVE, PRODUCTION_BASKETS_ROUTE],
})
export const PRODUCTION_BASKETS_FLOOR_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  team_leader: [PRODUCTION_BASKETS_MOVE, PRODUCTION_BASKETS_ROUTE],
  operator: [PRODUCTION_BASKETS_MOVE],
  cutting_operator: [PRODUCTION_BASKETS_MOVE],
  floor_inspector: [PRODUCTION_BASKETS_MOVE],
})
