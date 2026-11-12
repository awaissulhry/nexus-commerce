import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Warranty and service cases (B-W2b-345; SAL-368, SAL-436; design sales.service "Warranty & service"), in the sales area
 * beside the returns and repairs. Office only. Each is checked with can() against the case's company and, when it names
 * one, its customer: a role limited to some customers sees only their cases (and the cases that name no customer, a rider
 * who wrote to us directly).
 *
 *   view     the cases list and its tiles, a case with its garment, its warranty check (the legal guarantee against the
 *            factory's own, in words), its linked records and the status mails the customer was sent
 *   manage   open a case, change its facts, its owner and whether the customer is told at each status change; move it
 *            (open, waiting for the customer or a part, resolved, reopened, closed); link and unlink records; open a repair,
 *            a return, a remake or a credit from it (with the repairs' or returns' own manage permission too)
 *   decide   decide the cover of a claim: under the legal guarantee or the factory's own, covered, partly or not covered,
 *            and why in words (the remedy the customer gets follows from it)
 */
export const SALES_SERVICE_DEFINITIONS = definePermissions('sales', {
  'service.view': {
    risk: 'read',
    description: "See warranty and service cases: the garment, the warranty check (the legal guarantee against the factory's own), the records each case led to and the status mails sent to the customer.",
  },
  'service.manage': {
    risk: 'write',
    description: 'Open a warranty or service case, change it, move it (waiting, resolved, reopened, closed), link records to it, tell the customer at each status change, and open a repair, a return, a remake or a credit from it.',
  },
  'service.decide': {
    risk: 'write',
    description: "Decide the cover of a claim: under the legal guarantee or the factory's own guarantee, covered, partly or not covered, and why.",
  },
})

export const SALES_SERVICE_VIEW = 'sales.service.view' satisfies Permission
export const SALES_SERVICE_MANAGE = 'sales.service.manage' satisfies Permission
export const SALES_SERVICE_DECIDE = 'sales.service.decide' satisfies Permission

export const SALES_SERVICE_PERMISSIONS: readonly Permission[] = Object.freeze([SALES_SERVICE_VIEW, SALES_SERVICE_MANAGE, SALES_SERVICE_DECIDE])

/**
 * Who holds them (auth/roles/templates; the owner from every(), read-only through the registry): sales opens and follows the
 * cases and decides the cover (as it decides returns); quality follows the complaint and safety cases up; the production
 * manager and finance read them (a repair or a credit comes from one).
 */
export const SALES_SERVICE_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  sales: [SALES_SERVICE_VIEW, SALES_SERVICE_MANAGE, SALES_SERVICE_DECIDE],
  quality_inspector: [SALES_SERVICE_VIEW, SALES_SERVICE_MANAGE],
  production_manager: [SALES_SERVICE_VIEW],
  finance: [SALES_SERVICE_VIEW],
})
