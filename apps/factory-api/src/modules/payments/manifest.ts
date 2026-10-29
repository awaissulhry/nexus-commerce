import { defineManifest } from '../../core/manifest'

/**
 * Payments received (B-W1-28; A2 SCR-082; FIN-121, FIN-066): office only (a floor, portal or link session is refused by
 * audience). A payment belongs to a company and a party, so the handlers check each record with can() and filter the
 * list with scopeWhere() (`record`). "Deposit received" also asks invoices.issue and a fresh step-up when it issues the
 * TD02.
 */
export const manifest = defineManifest({
  'GET /payments': { audiences: ['office'], permission: 'payments.view', scope: 'record' },
  'GET /payments/:paymentId': { audiences: ['office'], permission: 'payments.view', scope: 'record' },
  'POST /payments': { audiences: ['office'], permission: 'payments.record', scope: 'record' },
  'POST /payments/deposit-received': { audiences: ['office'], permission: 'payments.record', scope: 'record' },
  'POST /payments/:paymentId/allocations': { audiences: ['office'], permission: 'payments.record', scope: 'record' },
  'POST /payments/:paymentId/allocations/:allocationId/reverse': { audiences: ['office'], permission: 'payments.record', scope: 'record' },
  'POST /payments/:paymentId/void': { audiences: ['office'], permission: 'payments.void', scope: 'record' },
})
