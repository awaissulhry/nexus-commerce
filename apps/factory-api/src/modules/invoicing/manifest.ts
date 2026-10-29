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
})
