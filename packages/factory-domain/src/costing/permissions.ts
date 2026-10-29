import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * Costing's permissions (apps/factory-api modules/costing; features FIN-001, FIN-002, FIN-004, GAP-006), in the costing
 * area. Checked with can() against the style's company (a tenant-wide style: the company the cost is asked for, else
 * every company the grant reaches).
 *
 * Reading a cost sheet is not seeing its figures: every cost figure is a `money.cost` field, dropped for a caller
 * without the cost grain (A1 §2.6), so a sales person or a production manager may see which inputs are missing and the
 * minutes and quantities behind a cost, never the cost. Floor, portal and link sessions never reach these routes.
 */
export const COSTING_DEFINITIONS = definePermissions('costing', {
  view: {
    risk: 'read',
    description:
      "See a style revision's cost sheet: material from the BOM per size and colourway at each material's standard purchase price, labour from the routing's standard minutes, overhead, the waterfall, what is missing and the inputs used; compare two revisions; cost a quote's cells. Figures only with the cost grain.",
  },
})

export const COSTING_VIEW = 'costing.view' satisfies Permission
export const COSTING_PERMISSIONS: readonly Permission[] = Object.freeze([COSTING_VIEW])
