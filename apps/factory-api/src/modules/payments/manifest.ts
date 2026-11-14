import { defineManifest, PUBLIC } from '../../core/manifest'

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
  // B-W2b-185 (./online; FIN-118, FIN-123): paying online by card or SEPA through the payment provider. The office sends the
  // page to pay an invoice and reads a record's online payments; a PAYMENT or DEPOSIT_INFO link pays its own record (the
  // handler checks the purpose); the customer's Finance and Admin see what is open and pay in the portal; the FAKE
  // provider's own fields are public (the client secret is the key) and answer 404 outside local and test.
  'POST /payments/invoices/:invoiceId/link': { audiences: ['office'], permission: 'payments.record', scope: 'record' },
  'GET /payments/intents': { audiences: ['office'], permission: 'payments.view', scope: 'record' },
  'GET /payments/link/pay': { audiences: ['link'], permission: 'links.open', scope: 'party' },
  'POST /payments/link/pay/intents': { audiences: ['link'], permission: 'links.open', scope: 'party' },
  'GET /payments/link/pay/intents/:intentId': { audiences: ['link'], permission: 'links.open', scope: 'party' },
  'GET /portal/payments/open-items': { audiences: ['partner'], permission: 'portal.payments.view', scope: 'party' },
  'GET /portal/payments/statement': { audiences: ['partner'], permission: 'portal.payments.view', scope: 'party' },
  'GET /portal/payments/statement/pdf': { audiences: ['partner'], permission: 'portal.payments.view', scope: 'party' },
  'POST /portal/payments/intents': { audiences: ['partner'], permission: 'portal.payments.pay', scope: 'party' },
  'GET /portal/payments/intents/:intentId': { audiences: ['partner'], permission: 'portal.payments.view', scope: 'party' },
  'POST /payment-fake/confirm': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  // B-W2b-393 (./bank, ./matching, ./write-offs; FIN-130, FIN-132, FIN-117, FIN-119): bank statements imported from the files
  // the company downloads from its bank, their lines matched with how sure and why (a person accepts every match), the
  // payments not placed on an invoice, small differences written off within the tolerance. Each handler checks the
  // company (and the party) with can().
  'GET /payments/bank/accounts': { audiences: ['office'], permission: 'payments.bank.view', scope: 'record' },
  'GET /payments/bank/statements': { audiences: ['office'], permission: 'payments.bank.view', scope: 'record' },
  'GET /payments/bank/statements/:statementId': { audiences: ['office'], permission: 'payments.bank.view', scope: 'record' },
  'POST /payments/bank/statements/uploads': { audiences: ['office'], permission: 'payments.bank.import', scope: 'record' },
  'POST /payments/bank/statements/dry-run': { audiences: ['office'], permission: 'payments.bank.import', scope: 'record' },
  'POST /payments/bank/statements': { audiences: ['office'], permission: 'payments.bank.import', scope: 'record' },
  'GET /payments/bank/lines': { audiences: ['office'], permission: 'payments.bank.view', scope: 'record' },
  'GET /payments/bank/lines/counts': { audiences: ['office'], permission: 'payments.bank.view', scope: 'record' },
  'GET /payments/bank/lines/:lineId': { audiences: ['office'], permission: 'payments.bank.view', scope: 'record' },
  'POST /payments/bank/lines/:lineId/match': { audiences: ['office'], permission: 'payments.bank.match', scope: 'record' },
  'POST /payments/bank/matches/accept': { audiences: ['office'], permission: 'payments.bank.match', scope: 'record' },
  'POST /payments/bank/matches/:matchId/accept': { audiences: ['office'], permission: 'payments.bank.match', scope: 'record' },
  'POST /payments/bank/matches/:matchId/reverse': { audiences: ['office'], permission: 'payments.bank.match', scope: 'record' },
  'POST /payments/bank/suggestions/refresh': { audiences: ['office'], permission: 'payments.bank.match', scope: 'record' },
  'GET /payments/unapplied': { audiences: ['office'], permission: 'payments.view', scope: 'record' },
  'GET /payments/:paymentId/bank-line': { audiences: ['office'], permission: 'payments.view', scope: 'record' },
  'GET /payments/:paymentId/write-offs': { audiences: ['office'], permission: 'payments.view', scope: 'record' },
  'POST /payments/:paymentId/write-offs': { audiences: ['office'], permission: 'payments.writeOff', scope: 'record' },
  'POST /payments/:paymentId/write-offs/:writeOffId/reverse': { audiences: ['office'], permission: 'payments.writeOff', scope: 'record' },
  'GET /payments/write-offs/tolerance': { audiences: ['office'], permission: 'receivables.view', scope: 'record' },
  'PUT /payments/write-offs/tolerance': { audiences: ['office'], permission: 'receivables.settings.manage', scope: 'record' },
})
