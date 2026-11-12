import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Warehouse reports (apps/factory-api modules/inventory/reports; B-W2b-356; design warehouse.reports SCR-257), in the inventory
 * area, office only. Checked with can() against the screen's company. The page needs this permission; its figures ALSO need
 * inventory.stock.view over each site they are counted at (the stock's own view), and every value the cost grain (money.cost),
 * so a role sees the report of the stock it may see and a value only with the cost grain.
 *
 * Read only: nothing here writes, so no command, audit row or event. No figure is per person.
 */
export const INVENTORY_REPORTS_DEFINITIONS = definePermissions('inventory', {
  'reports.view': {
    risk: 'read',
    description:
      'See the warehouse reports of a company: stock ageing by material type and leather use (received, cut, back as remnant, scrapped, on hand) by article and supplier lot, and their print view (each figure only from the stock you may see; values only with the cost grain).',
  },
})

export const INVENTORY_REPORTS_VIEW = 'inventory.reports.view' satisfies Permission

export const INVENTORY_REPORTS_PERMISSIONS: readonly Permission[] = Object.freeze([INVENTORY_REPORTS_VIEW])

/**
 * Who holds it (auth/roles/templates): the warehouse (the monthly stock review), the buyer (what to stop buying), the planner
 * (old stock to plan first), the production manager (leather use) and finance (old stock for the write-down). Office only; the
 * owner and read-only from every().
 */
export const INVENTORY_REPORTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  warehouse: [INVENTORY_REPORTS_VIEW],
  buyer: [INVENTORY_REPORTS_VIEW],
  planner: [INVENTORY_REPORTS_VIEW],
  production_manager: [INVENTORY_REPORTS_VIEW],
  finance: [INVENTORY_REPORTS_VIEW],
})
