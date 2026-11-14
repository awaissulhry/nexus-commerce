import { defineManifest } from '../../../core/manifest'

/**
 * Purchase price variance and the actual-cost settings (B-W2b-407; FIN-031; GATE-ACCOUNTANT; design finance.costing
 * "Purchase price variance"). Office only: the floor, partner and link sessions never see a cost (A1 §2.6). Each handler
 * checks the variance's (or the document's) company and supplier with can() and filters the list with scopeWhere()
 * (`record`); every unit cost and difference is money.cost. Posting a document's variances by hand and reversing one is
 * costing.ledger.manage; the company's switch and where it takes its variance are costing.actuals.manage with a fresh
 * step-up (the accountant's word).
 */
const view = { audiences: ['office'], permission: 'costing.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'costing.ledger.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /costing/actuals/settings': view,
  'PUT /costing/actuals/settings': { audiences: ['office'], permission: 'costing.actuals.manage', scope: 'record' },
  'GET /costing/ppv': view,
  'POST /costing/ppv/post': manage,
  'POST /costing/ppv/:varianceId/reverse': manage,
})
