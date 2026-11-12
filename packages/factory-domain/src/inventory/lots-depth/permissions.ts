import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Lots in depth (apps/factory-api modules/inventory/lots-depth, trace/report.ts; B-W2b-313; SCM-185, SCM-236, SCM-237,
 * SCM-238, SCM-242; design warehouse.lots). Area `inventory`, beside the module's own list. Office only, checked with can()
 * against the lot's company and site (a trace report: the start's). Reading the lot page, its lifecycle and attributes and
 * the trace stays inventory.stock.view (W1, W2a-27).
 *
 *   lots.manage    split a lot of hides into shade groups (child lots with the parent link) and regroup them, record a lot's
 *                  attributes (thickness range, finish, tannage, grade mix, origin; width and weight of a fabric), check its
 *                  lifecycle against the ledger now. The warehouse and the quality inspector, who sort the hides.
 *   trace.report   make the dated trace report for a customer, a notified body or an authority (PDF or CSV, kept as a file
 *                  of the record traced, with what was asked and when). The quality inspector, who speaks for the company
 *                  outward (B-W2b-260's recall and authority roles).
 */
export const INVENTORY_LOTS_DEPTH_DEFINITIONS = definePermissions('inventory', {
  'lots.manage': {
    risk: 'write',
    description:
      "Split a lot of hides into shade groups (child lots that keep the parent link) and regroup them, record a lot's attributes (thickness range, finish, tannage, grade mix, origin; a fabric's width and weight), and check its lifecycle against the stock moves.",
  },
  'trace.report': {
    risk: 'write',
    description: 'Make the dated trace report of a lot, hide, bundle, batch, serial or shipment for a customer, a notified body or an authority (PDF or CSV, kept with what was asked and when).',
  },
})

export const INVENTORY_LOTS_MANAGE = 'inventory.lots.manage' satisfies Permission
export const INVENTORY_TRACE_REPORT = 'inventory.trace.report' satisfies Permission
export const INVENTORY_LOTS_DEPTH_PERMISSIONS: readonly Permission[] = Object.freeze([INVENTORY_LOTS_MANAGE, INVENTORY_TRACE_REPORT])

/** Who holds them (auth/roles/templates): the warehouse sorts and records, quality also reports outward; the owner from every(). */
export const INVENTORY_LOTS_DEPTH_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  warehouse: [INVENTORY_LOTS_MANAGE],
  quality_inspector: [INVENTORY_LOTS_MANAGE, INVENTORY_TRACE_REPORT],
})
