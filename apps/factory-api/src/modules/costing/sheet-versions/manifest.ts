import { defineManifest } from '../../../core/manifest'

/**
 * Cost sheet versions (B-W2b-420; FIN-014, FIN-015; design products.styles › Cost "Cost sheet versions and approval"). Office
 * only: the floor, partner and link sessions never see a cost (A1 §2.6). Each handler checks the sheet's (or style's)
 * company with can() and filters the list with scopeWhere() (`record`). Reads, the comparison and a what-if: costing.view;
 * a draft made, edited, deleted or sent for its yes, a what-if saved: costing.sheets.manage; an approved version taken back:
 * costing.sheets.approve. The yes itself is the approval engine's (POST /approvals/tasks/:id/approve). A figure sent needs
 * its grain.
 */
const view = { audiences: ['office'], permission: 'costing.view', scope: 'record' } as const
const sheets = { audiences: ['office'], permission: 'costing.sheets.manage', scope: 'record' } as const
const approve = { audiences: ['office'], permission: 'costing.sheets.approve', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /costing/cost-sheets': view,
  'GET /costing/cost-sheets/compare': view,
  'GET /costing/cost-sheets/:sheetId': view,
  'POST /costing/cost-sheets': sheets,
  'PATCH /costing/cost-sheets/:sheetId': sheets,
  'DELETE /costing/cost-sheets/:sheetId': sheets,
  'POST /costing/cost-sheets/:sheetId/submit': sheets,
  'POST /costing/cost-sheets/:sheetId/take-back': approve,
  'POST /costing/cost-sheets/:sheetId/what-if': view,
  'POST /costing/cost-sheets/:sheetId/what-if/save': sheets,
})
