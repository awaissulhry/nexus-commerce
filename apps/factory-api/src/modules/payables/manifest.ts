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
  // B-W2b-21 (Z8:03, Z8:06): the payables settings (settings.ts) and the SDI inbox of deliveries the pickup could not record (inbox.ts).
  'GET /payables/settings': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'PUT /payables/settings': { audiences: ['office'], permission: 'payables.settings', scope: 'record' },
  'GET /payables/sdi/inbox': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'POST /payables/sdi/inbox/:itemId/dismiss': { audiences: ['office'], permission: 'payables.manage', scope: 'record' },
  'POST /payables/sdi/inbox/:itemId/reopen': { audiences: ['office'], permission: 'payables.manage', scope: 'record' },
  // B-W2b-403: the leather area check (its claim is purchasing's: purchasing.claims.manage, checked by the claim command), the
  // subcontract match (a FEE entry: purchasing.subcontract.cost, checked by purchasing's command), the invoice's dual approval,
  // the weekly payment proposal (approve: a fresh code), the Owner's remittance switch and the money controls.
  'GET /payables/invoices/:invoiceId/area-check': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'POST /payables/invoices/:invoiceId/area-check/:lineId/claim': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'GET /payables/invoices/:invoiceId/subcontract-match': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'POST /payables/invoices/:invoiceId/subcontract-match/:lineId/fee': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'GET /payables/invoices/:invoiceId/dual-approval': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'GET /payables/proposals': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'GET /payables/proposals/candidates': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'POST /payables/proposals': { audiences: ['office'], permission: 'payables.proposals.manage', scope: 'record' },
  'GET /payables/proposals/:proposalId': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'PUT /payables/proposals/:proposalId/lines': { audiences: ['office'], permission: 'payables.proposals.manage', scope: 'record' },
  'POST /payables/proposals/:proposalId/approve': { audiences: ['office'], permission: 'payables.proposals.approve', scope: 'record' },
  'POST /payables/proposals/:proposalId/send-back': { audiences: ['office'], permission: 'payables.proposals.manage', scope: 'record' },
  'POST /payables/proposals/:proposalId/cancel': { audiences: ['office'], permission: 'payables.proposals.manage', scope: 'record' },
  'POST /payables/proposals/:proposalId/paid': { audiences: ['office'], permission: 'payables.proposals.manage', scope: 'record' },
  'GET /payables/remittance/settings': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
  'PUT /payables/remittance/settings': { audiences: ['office'], permission: 'payables.remittance.switch', scope: 'record' },
  'GET /payables/money-controls': { audiences: ['office'], permission: 'payables.view', scope: 'record' },
})
