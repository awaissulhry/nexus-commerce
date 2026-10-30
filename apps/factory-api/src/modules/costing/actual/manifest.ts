import { defineManifest } from '../../../core/manifest'

/**
 * Standard vs actual and the cost ledger (B-W2a-21; FIN-026, FIN-027, FIN-033, FIN-038; design finance.costing SCR-154,
 * production.workorders "Labour & cost"). Office only: the floor, partner and link sessions never see a cost (A1 §2.6).
 * Each handler checks the work order's (or the entry's) company and site with can(), and filters lists with
 * scopeWhere() (`record`); every figure is money.cost. Posting by hand and reversing need costing.ledger.manage.
 */
const view = { audiences: ['office'], permission: 'costing.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'costing.ledger.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /costing/work-orders': view,
  'GET /costing/work-orders/:workOrderId': view,
  'GET /costing/ledger': view,
  'POST /costing/work-orders/:workOrderId/post': manage,
  'POST /costing/entries/:entryId/reverse': manage,
})
