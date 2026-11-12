import { defineManifest } from '../../../core/manifest'

/**
 * Credit limits (B-W2b-304; SAL-148, SAL-237, SAL-241, SAL-244; design finance.receivables sec:credit). Office only: each
 * route asks sales.credit.* and checks the customer's credit with can() over its company and customer (`record`); the
 * amounts need the price grain besides. The checks themselves are written by the steps' own commands (a quote sent, an
 * order made, a work order released, a shipment leaving); the yes on a hold is the approval engine's (POST
 * /approvals/tasks/:id/approve, kind CREDIT_OVERRIDE).
 */
const view = { audiences: ['office'], permission: 'sales.credit.view', scope: 'record' } as const
const limits = { audiences: ['office'], permission: 'sales.credit.limits', scope: 'record' } as const
const checks = { audiences: ['office'], permission: 'sales.credit.checks', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/credit/limits': view,
  'PUT /sales/credit/limits/:partyId/:companyId': limits,
  'GET /sales/credit/records/:recordType/:recordId': view,
  'POST /sales/credit/records/:recordType/:recordId/check': checks,
  'POST /sales/credit/checks/:checkId/ask': checks,
})
