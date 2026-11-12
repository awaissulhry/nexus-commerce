import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Purchasing reports (apps/factory-api modules/purchasing/reports; B-W2b-350; design purchasing.reports SCR-255), in the
 * purchasing area, office only. Checked with can() against the screen's company. The page needs this permission; its figures
 * ALSO need purchasing.view over each order they count (the orders' own view: company, site and supplier), and every amount the
 * cost grain (money.cost), so a role sees the spend and the late lines of the orders it may see, and an amount only with the cost
 * grain.
 *
 * Read only: nothing here writes, so no command, audit row or event (a chase from the page is the order's own route).
 */
export const PURCHASING_REPORTS_DEFINITIONS = definePermissions('purchasing', {
  'reports.view': {
    risk: 'read',
    description:
      'See the purchasing reports of a company: spend by supplier, category, material, company and month with sample orders apart, the late purchase order lines with the work orders and customer orders they hold up, and their print view (each figure only from the orders you may see; amounts only with the cost grain).',
  },
})

export const PURCHASING_REPORTS_VIEW = 'purchasing.reports.view' satisfies Permission

export const PURCHASING_REPORTS_PERMISSIONS: readonly Permission[] = Object.freeze([PURCHASING_REPORTS_VIEW])

/**
 * Who holds it (auth/roles/templates): the buyer (the monthly buying review), the planner and the production manager (the late
 * lines and what they hold up), finance (the spend) and the warehouse (what is late to arrive). Office only; the owner and
 * read-only from every(). The planner and the warehouse hold no cost grain: they see counts, never an amount.
 */
export const PURCHASING_REPORTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  buyer: [PURCHASING_REPORTS_VIEW],
  planner: [PURCHASING_REPORTS_VIEW],
  production_manager: [PURCHASING_REPORTS_VIEW],
  finance: [PURCHASING_REPORTS_VIEW],
  warehouse: [PURCHASING_REPORTS_VIEW],
})
