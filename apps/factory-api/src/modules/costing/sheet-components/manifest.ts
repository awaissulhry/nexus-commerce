import { defineManifest } from '../../../core/manifest'

/**
 * The cost sheet's components (B-W2b-418; FIN-003, FIN-006, FIN-008, FIN-009, FIN-011, FIN-020; design products.styles › Cost
 * "Cost sheet" with its Subcontract, Packaging and Freight and duties steps). Office only: the floor, partner and link
 * sessions never see a cost (A1 §2.6). Each handler checks the style's, sheet's, work order's or row's company (and site)
 * with can() and filters lists with scopeWhere() (`record`). Reads: costing.view; a draft's lines, leather bases and uplifts:
 * costing.sheets.manage; the piece-rate labour switch: costing.rates.manage (the costing settings' own). A figure sent needs
 * the cost grain.
 */
const view = { audiences: ['office'], permission: 'costing.view', scope: 'record' } as const
const sheets = { audiences: ['office'], permission: 'costing.sheets.manage', scope: 'record' } as const
const rates = { audiences: ['office'], permission: 'costing.rates.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /costing/styles/:styleId/revisions/:revisionId/components': view,
  'POST /costing/cost-sheets/:sheetId/components': sheets,
  'GET /costing/cost-sheets/:sheetId/split': view,
  'GET /costing/work-orders/:workOrderId/cost-split': view,
  'GET /costing/leather-bases': view,
  'GET /costing/leather-bases/:basisId': view,
  'POST /costing/leather-bases': sheets,
  'PATCH /costing/leather-bases/:basisId': sheets,
  'POST /costing/leather-bases/:basisId/archive': sheets,
  'GET /costing/uplifts': view,
  'GET /costing/uplifts/landed': view,
  'GET /costing/uplifts/:upliftId': view,
  'POST /costing/uplifts': sheets,
  'PATCH /costing/uplifts/:upliftId': sheets,
  'POST /costing/uplifts/:upliftId/archive': sheets,
  'GET /costing/piece-rate-labour': view,
  'PUT /costing/piece-rate-labour': rates,
})
