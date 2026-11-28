import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * "Print and start the work" (owb- order workflow, plan.md § 5 D R24 and § 5 G/H; PL-split S3 ss2): from a confirmed order, run
 * today's release checks first (law, money and structure refuse; the rest warns, in words), release its work orders, make its
 * baskets when the site makes them at print (production/baskets/at-print), write the print record FIRST and print the pages
 * and cards; "Print again" prints the SAME codes with a reason. Checked with can() against the order's company and party.
 * The release trigger still checks at the update, so this right alone skips no check. Office only; nothing here carries money.
 *
 *   production.print.start   print and start the work of a confirmed order, and print its pages and cards again
 */
export const PRODUCTION_PRINT_START_DEFINITIONS = definePermissions('production', {
  'print.start': {
    risk: 'write',
    description:
      "Print and start the work of a confirmed order: run the release checks first (what refuses and what only warns is said in words), release its work orders, make its baskets where the site makes them at print, and print the pages and cards; print them again with the same codes and a reason.",
  },
})

export const PRODUCTION_PRINT_START = 'production.print.start' satisfies Permission

export const PRODUCTION_PRINT_START_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_PRINT_START])

/**
 * The role templates (roles/templates addedFor; the Owner from every()). Sales starts the work of its orders (R24, the Owner's
 * yes); the production manager and the planner, who release work orders today, start it too (the Owner's yes of 2026-11-28,
 * owb-b6). The Factory designer prints only with the Owner's yes: never from its template, only by the per-person offer
 * `extra_print_and_start` an administrator assigns (People by customer › Extra rights).
 */
export const PRODUCTION_PRINT_START_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  sales: [PRODUCTION_PRINT_START],
  planner: [PRODUCTION_PRINT_START],
  production_manager: [PRODUCTION_PRINT_START],
})
