import { defineManifest } from '../../../core/manifest'

/**
 * Stock valuation at any date and value by hide area (B-W2a-29; FIN-039, SCM-256; design finance.reports SCR-239,
 * warehouse.hides "Leather dashboard"). Office only: the floor, partner and link sessions never see a value (A1 §2.6).
 * Read with inventory.stock.view, as the stock itself (the design's planner and warehouse reach the report and see its
 * quantities): the handlers read only the sites the caller's grants reach (scopeWhere over the site, siteFor for one);
 * every value is money.cost, dropped for a caller without the cost grain.
 */
const view = { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /costing/valuation': view,
  'GET /costing/valuation/layers': view,
  'GET /costing/valuation/leather': view,
})
