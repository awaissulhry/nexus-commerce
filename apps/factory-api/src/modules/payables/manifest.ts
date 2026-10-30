import { defineManifest } from '../../core/manifest'

/**
 * Payables (B-W2a-62; FIN-136 supplier invoice capture, FIN-137 three-way match; design finance.payables, SCR-153):
 * office only. Every invoice belongs to a company and a supplier, so the handlers check each with can() and filter the
 * lists (`record`). Amounts and prices travel only with the cost grain.
 */
export const manifest = defineManifest({
  'GET /payables/invoices': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'GET /payables/invoices/counts': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'GET /payables/invoices/:invoiceId': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'GET /payables/invoices/:invoiceId/xml': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'GET /payables/invoices/:invoiceId/candidates': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'POST /payables/invoices': { audiences: ['office'], permission: 'payables.manage', scope: 'record' },
  'PATCH /payables/invoices/:invoiceId': { audiences: ['office'], permission: 'payables.manage', scope: 'record' },
  'POST /payables/invoices/:invoiceId/lines': { audiences: ['office'], permission: 'payables.manage', scope: 'record' },
  'PATCH /payables/invoices/:invoiceId/lines/:lineId': { audiences: ['office'], permission: 'payables.manage', scope: 'record' },
  'DELETE /payables/invoices/:invoiceId/lines/:lineId': { audiences: ['office'], permission: 'payables.manage', scope: 'record' },
  'POST /payables/invoices/:invoiceId/without-order': { audiences: ['office'], permission: 'payables.manage', scope: 'record' },
  'POST /payables/invoices/:invoiceId/match': { audiences: ['office'], permission: 'payables.manage', scope: 'record' },
  'POST /payables/invoices/:invoiceId/matches/:matchId/accept': { audiences: ['office'], permission: 'payables.differences.accept', scope: 'record' },
  'POST /payables/invoices/:invoiceId/send-to-buyer': { audiences: ['office'], permission: 'payables.manage', scope: 'record' },
  'POST /payables/invoices/:invoiceId/dispute': { audiences: ['office'], permission: 'payables.manage', scope: 'record' },
  'POST /payables/invoices/:invoiceId/reopen': { audiences: ['office'], permission: 'payables.manage', scope: 'record' },
  'POST /payables/invoices/:invoiceId/void': { audiences: ['office'], permission: 'payables.manage', scope: 'record' },
  'POST /payables/invoices/:invoiceId/settle-claim': { audiences: ['office'], permission: 'payables.manage', scope: 'record' },
  'POST /payables/invoices/:invoiceId/approve': { audiences: ['office'], permission: 'payables.approve', scope: 'record' },
  'POST /payables/invoices/approve': { audiences: ['office'], permission: 'payables.approve', scope: 'record' },
  'POST /payables/invoices/:invoiceId/withdraw-approval': { audiences: ['office'], permission: 'payables.approve', scope: 'record' },
  'POST /payables/invoices/:invoiceId/pay': { audiences: ['office'], permission: 'payables.pay', scope: 'record' },
  'GET /payables/sdi': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'POST /payables/sdi/pickup': { audiences: ['office'], permission: 'payables.manage', scope: 'record' },
})
