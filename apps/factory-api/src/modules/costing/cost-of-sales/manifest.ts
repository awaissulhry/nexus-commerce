import { defineManifest } from '../../../core/manifest'

/**
 * Cost of goods sold at shipment (B-W2b-407; FIN-043; design finance.accounting "cost of goods sold and variances").
 * Office only: the floor, partner and link sessions never see a cost (A1 §2.6). Each handler checks the entry's (or the
 * shipment's) company and customer with can() and filters the list with scopeWhere() (`record`); every amount is
 * money.cost. Posting a shipment's cost by hand and reversing an entry is costing.ledger.manage.
 */
const view = { audiences: ['office'], permission: 'costing.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'costing.ledger.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /costing/cost-of-sales': view,
  'POST /costing/cost-of-sales/post': manage,
  'POST /costing/cost-of-sales/:entryId/reverse': manage,
})
