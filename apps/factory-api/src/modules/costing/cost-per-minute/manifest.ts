import { defineManifest } from '../../../core/manifest'

/**
 * The cost-per-minute calculator (B-W2b-419; FIN-005; design finance.settings › Costing "Cost-per-minute calculator"). Office
 * only: the floor, partner and link sessions never see a cost (A1 §2.6). Each handler checks the calculation's company (and a
 * work centre's site) with can() and filters the list with scopeWhere() (`record`). Kept with costing.rates.manage over the
 * company, the labour rates' permission: applying writes the company's labour rate; a figure sent needs the cost grain.
 */
const view = { audiences: ['office'], permission: 'costing.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'costing.rates.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /costing/cost-per-minute': view,
  'GET /costing/cost-per-minute/prefill': view,
  'GET /costing/cost-per-minute/:calcId': view,
  'POST /costing/cost-per-minute': manage,
  'PATCH /costing/cost-per-minute/:calcId': manage,
  'DELETE /costing/cost-per-minute/:calcId': manage,
  'POST /costing/cost-per-minute/:calcId/apply': manage,
})
