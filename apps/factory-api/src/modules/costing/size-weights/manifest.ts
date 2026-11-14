import { defineManifest } from '../../../core/manifest'

/**
 * Size weights and the cost by size (B-W2b-420; FIN-016; design products.styles › Cost "Cost by size"). Office only. Each
 * handler checks the style's or the sheet's company with can() (`record`). Reads: costing.view; a style's size mix kept:
 * costing.sheets.manage (every company's style without a season: a grant over every company).
 */
const view = { audiences: ['office'], permission: 'costing.view', scope: 'record' } as const
const sheets = { audiences: ['office'], permission: 'costing.sheets.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /costing/size-weights': view,
  'PUT /costing/size-weights': sheets,
  'GET /costing/cost-sheets/:sheetId/by-size': view,
})
