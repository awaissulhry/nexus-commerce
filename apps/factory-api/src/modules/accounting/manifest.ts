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
})
