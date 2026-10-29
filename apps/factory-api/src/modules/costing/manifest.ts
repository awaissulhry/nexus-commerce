import { defineManifest } from '../../core/manifest'

/**
 * Costing's routes (A2 SCR-044 "Style › Cost"; features FIN-001, FIN-002, FIN-004). Office only: the floor and partner
 * and link sessions never see a cost (A1 §2.6, PLT-035). A cost sheet belongs to its style, which belongs to one company
 * or to every company of the tenant, so each handler checks the style's company (and the company asked for) with
 * can() (`record`). The sheet is computed when asked, from the revision's BOM and routing and today's prices and rates
 * (no stored snapshot; a quote keeps its own, QuoteLine.costSnapshot). The rates and settings are written with
 * costing.rates.manage over their company (tenant-wide: a grant over every company).
 */
const view = { audiences: ['office'], permission: 'costing.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'costing.rates.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /costing/styles/:styleId/revisions/:revisionId/cost-sheet': view,
  'GET /costing/styles/:styleId/cost-sheet/compare': view,
  'POST /costing/cells': view,
  // The labour rates and costing settings (a rate or setting of one company, or tenant-wide).
  'GET /costing/rates': view,
  'POST /costing/rates': manage,
  'PATCH /costing/rates/:rateId': manage,
  'POST /costing/rates/:rateId/archive': manage,
  'GET /costing/settings': view,
  'PUT /costing/settings': manage,
})
