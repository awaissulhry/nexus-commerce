import { defineManifest } from '../../core/manifest'

/**
 * The accounting exports, the Intrastat rows, the year-end stock pack and the period locks (B-W2a-39; FIN-046, LOG-098,
 * LOG-100; design finance.accounting, SCR-156). Office only, scoped by record: an export and a lock belong to a company,
 * so the handlers check each with can() and filter the lists with scopeWhere(). Reading is accounting.view; making,
 * re-exporting and cancelling a batch accounting.export (and the grain of each package's amounts, checked by the
 * handler); locking a month and lifting a soft lock accounting.lock; lifting a hard lock also accounting.unlock with a
 * fresh step-up (checked by the handler). Writes take an Idempotency-Key.
 */
const view = { audiences: ['office'], permission: 'accounting.view', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /accounting/exports': view,
  'POST /accounting/exports': { audiences: ['office'], permission: 'accounting.export', scope: 'record' },
  'GET /accounting/exports/:exportId': view,
  'POST /accounting/exports/:exportId/cancel': { audiences: ['office'], permission: 'accounting.export', scope: 'record' },
  'GET /accounting/exports/:exportId/files/:fileId/download': view,
  'GET /accounting/periods': view,
  'GET /accounting/periods/:month': view,
  'GET /accounting/intrastat': view,
  'GET /accounting/locks': view,
  'POST /accounting/locks': { audiences: ['office'], permission: 'accounting.lock', scope: 'record' },
  'POST /accounting/locks/:lockId/lift': { audiences: ['office'], permission: 'accounting.lock', scope: 'record' },
  // B-W2b-201: accountant access — the guest portal's room (partner, the session's party; files only, read in the system scope
  // after the guest grant names the company and the period: guest/access.ts) and its office half on Finance › Close.
  'GET /portal/accounting': { audiences: ['partner'], permission: 'portal.accounting.view', scope: 'party' },
  'GET /portal/accounting/periods/:period': { audiences: ['partner'], permission: 'portal.accounting.view', scope: 'party' },
  'POST /portal/accounting/files/:fileId/download': { audiences: ['partner'], permission: 'portal.accounting.view', scope: 'party' },
  'POST /portal/accounting/zip': { audiences: ['partner'], permission: 'portal.accounting.view', scope: 'party' },
  'GET /accounting/accountants': view,
  'POST /accounting/accountants': { audiences: ['office'], permission: 'accounting.accountants.manage', scope: 'record' },
  'PATCH /accounting/accountants/:userId': { audiences: ['office'], permission: 'accounting.accountants.manage', scope: 'record' },
  'POST /accounting/accountants/:userId/end': { audiences: ['office'], permission: 'accounting.accountants.manage', scope: 'record' },
  // B-W2b-408: the accountant's bridge — the account mapping, the journals switch (a fresh code: the route), the integrity checks.
  'GET /accounting/mapping': view,
  'POST /accounting/mapping': { audiences: ['office'], permission: 'accounting.mapping.manage', scope: 'record' },
  'PATCH /accounting/mapping/:mappingId': { audiences: ['office'], permission: 'accounting.mapping.manage', scope: 'record' },
  'DELETE /accounting/mapping/:mappingId': { audiences: ['office'], permission: 'accounting.mapping.manage', scope: 'record' },
  'GET /accounting/settings': view,
  'PUT /accounting/settings': { audiences: ['office'], permission: 'accounting.journals.switch', scope: 'record' },
  'GET /accounting/integrity': view,
  'POST /accounting/integrity/run': { audiences: ['office'], permission: 'accounting.export', scope: 'record' },
})
