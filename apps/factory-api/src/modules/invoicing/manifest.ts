import { defineManifest } from '../../core/manifest'

/**
 * Invoices (B-W1-28; A2 SCR-080, SCR-081; FIN-054, FIN-057, FIN-061, FIN-066, FIN-085): office only (a floor, portal or
 * link session is refused by audience). An invoice belongs to a company and a customer, so the handlers check each record
 * with can() and filter the lists with scopeWhere() (`record`). Issuing also asks a fresh step-up (invoices.issue).
 */
export const manifest = defineManifest({
  'GET /invoicing/invoices': { audiences: ['office'], permission: 'invoices.view', scope: 'record' },
  'GET /invoicing/invoices/:invoiceId': { audiences: ['office'], permission: 'invoices.view', scope: 'record' },
  'GET /invoicing/invoices/:invoiceId/checks': { audiences: ['office'], permission: 'invoices.view', scope: 'record' },
  // The record's DDTs, deductions, credit notes, payments and its orders' deposits (SCR-081; related.ts).
  'GET /invoicing/invoices/:invoiceId/related': { audiences: ['office'], permission: 'invoices.view', scope: 'record' },
  'POST /invoicing/invoices': { audiences: ['office'], permission: 'invoices.manage', scope: 'record' },
  'POST /invoicing/invoices/deposit-draft': { audiences: ['office'], permission: 'invoices.manage', scope: 'record' },
  'PATCH /invoicing/invoices/:invoiceId': { audiences: ['office'], permission: 'invoices.manage', scope: 'record' },
  'PUT /invoicing/invoices/:invoiceId/lines': { audiences: ['office'], permission: 'invoices.manage', scope: 'record' },
  'DELETE /invoicing/invoices/:invoiceId': { audiences: ['office'], permission: 'invoices.manage', scope: 'record' },
  'POST /invoicing/invoices/:invoiceId/issue': { audiences: ['office'], permission: 'invoices.issue', scope: 'record' },
  'POST /invoicing/invoices/:invoiceId/files': { audiences: ['office'], permission: 'invoices.issue', scope: 'record' },
  // SDI (B-W1-50; handlers in ./sdi): the status, the send (step-up), the correction of a rejected invoice (step-up).
  'GET /invoicing/invoices/:invoiceId/sdi': { audiences: ['office'], permission: 'invoices.view', scope: 'record' },
  'POST /invoicing/invoices/:invoiceId/sdi/send': { audiences: ['office'], permission: 'invoices.issue', scope: 'record' },
  'PUT /invoicing/invoices/:invoiceId/sdi/correction': { audiences: ['office'], permission: 'invoices.issue', scope: 'record' },
  // Invoices of shipped goods (B-W1-51; handlers in ./from-shipment, ./credit-note): drafts are invoices.manage, they are
  // issued and sent by the routes above (invoices.issue + step-up); a credit note has no permission of its own.
  'GET /invoicing/shipped-not-invoiced': { audiences: ['office'], permission: 'invoices.view', scope: 'record' },
  'POST /invoicing/invoices/from-ddts': { audiences: ['office'], permission: 'invoices.manage', scope: 'record' },
  'DELETE /invoicing/invoices/:invoiceId/deductions/:lineId': { audiences: ['office'], permission: 'invoices.manage', scope: 'record' },
  'POST /invoicing/invoices/:invoiceId/credit-note': { audiences: ['office'], permission: 'invoices.manage', scope: 'record' },
  'GET /invoicing/orders/:orderId/settlement': { audiences: ['office'], permission: 'invoices.view', scope: 'record' },
  // Invoicing every day (B-W2a-54; handlers in ./from-shipment/deferred.ts, ./milestones.ts): the deferred invoices due,
  // one TD24 of a customer's month, the invoice of a payment schedule step (its deposit's TD02). No permission of its own.
  'GET /invoicing/deferred': { audiences: ['office'], permission: 'invoices.view', scope: 'record' },
  'POST /invoicing/invoices/deferred': { audiences: ['office'], permission: 'invoices.manage', scope: 'record' },
  'POST /invoicing/invoices/from-milestone': { audiences: ['office'], permission: 'invoices.manage', scope: 'record' },
  // Finance settings as invoicing reads them (SCR-083; settings.ts): per company the caller may see invoices of.
  'GET /invoicing/settings': { audiences: ['office'], permission: 'invoices.view', scope: 'record' },
})
