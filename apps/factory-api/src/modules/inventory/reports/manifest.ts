import { defineManifest } from '../../../core/manifest'

/**
 * Warehouse reports (B-W2b-356; design warehouse.reports SCR-257). Office only, read only. The page's permission is
 * inventory.reports.view over the screen's company (checked in the handler with can(), `record`); the figures ALSO need
 * inventory.stock.view over each site they are counted at (handler: `placeOf`), and every value the cost grain (the contract's
 * money.cost fields). No write, no event: the figures are the stock ledger's moves and valuations, read.
 */
const view = { audiences: ['office'], permission: 'inventory.reports.view', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /inventory/reports/ageing': view,
  'GET /inventory/reports/leather': view,
})
