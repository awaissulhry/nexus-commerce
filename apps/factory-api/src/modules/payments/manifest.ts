import { defineManifest } from '../../core/manifest'

/**
 * Payments received (B-W1-28; A2 SCR-082; FIN-121, FIN-066): office only (a floor, portal or link session is refused by
 * audience), but for the customer's deposit page by its DEPOSIT_INFO link (deposit-link.ts). A payment belongs to a company and a party, so the handlers check each record with can() and filter the
 * list with scopeWhere() (`record`). "Deposit received" also asks invoices.issue and a fresh step-up when it issues the
 * TD02.
 */
export const manifest = defineManifest({
  'GET /payments': { audiences: ['office'], permission: 'payments.view', scope: 'record' },
  'GET /payments/:paymentId': { audiences: ['office'], permission: 'payments.view', scope: 'record' },
  // A customer's open deposit requests and invoices, oldest first (SCR-082 "Record a payment"; open-items.ts).
  'GET /payments/open-items': { audiences: ['office'], permission: 'payments.view', scope: 'record' },
  'POST /payments': { audiences: ['office'], permission: 'payments.record', scope: 'record' },
  'POST /payments/deposit-received': { audiences: ['office'], permission: 'payments.record', scope: 'record' },
  'POST /payments/:paymentId/allocations': { audiences: ['office'], permission: 'payments.record', scope: 'record' },
  'POST /payments/:paymentId/allocations/:allocationId/reverse': { audiences: ['office'], permission: 'payments.record', scope: 'record' },
  'POST /payments/:paymentId/void': { audiences: ['office'], permission: 'payments.void', scope: 'record' },
  'POST /payments/deposit-requests/:depositRequestId/link': { audiences: ['office'], permission: 'payments.record', scope: 'record' },
  'GET /payments/link/deposit': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  // B-W2a-61 (FIN-127, FIN-122; refunds.ts, credit-balance.ts): refunds to customers (money out: payments.refund; a refund
  // recorded as paid by mistake is voided with payments.void) and the customer's credit balance.
  'GET /payments/refunds': { audiences: ['office'], permission: 'payments.view', scope: 'record' },
  'GET /payments/refunds/open': { audiences: ['office'], permission: 'payments.view', scope: 'record' },
  'GET /payments/refunds/:refundId': { audiences: ['office'], permission: 'payments.view', scope: 'record' },
  'POST /payments/refunds': { audiences: ['office'], permission: 'payments.refund', scope: 'record' },
  'PATCH /payments/refunds/:refundId': { audiences: ['office'], permission: 'payments.refund', scope: 'record' },
  'POST /payments/refunds/:refundId/paid': { audiences: ['office'], permission: 'payments.refund', scope: 'record' },
  'POST /payments/refunds/:refundId/cancel': { audiences: ['office'], permission: 'payments.refund', scope: 'record' },
  'POST /payments/refunds/:refundId/void': { audiences: ['office'], permission: 'payments.void', scope: 'record' },
  'GET /payments/credit-balance': { audiences: ['office'], permission: 'payments.view', scope: 'record' },
  'POST /payments/release-overpayment': { audiences: ['office'], permission: 'payments.record', scope: 'record' },
  // B-W2b-21 (Z8:01; deposit-carry.ts): a PAID deposit that issues no deposit invoice (NONE) carried onto its order's invoice.
  'POST /payments/deposit-requests/:depositRequestId/carry': { audiences: ['office'], permission: 'payments.record', scope: 'record' },
})
