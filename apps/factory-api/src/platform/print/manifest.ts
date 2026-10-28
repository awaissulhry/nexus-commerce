import { defineManifest } from '../../core/manifest'

/**
 * The print routes (plan A1 §3.9; GAP-007). Printers and jobs belong to a company and a site, so the handlers check
 * each one with can() and filter lists with scopeWhere() (`record`); a floor device reaches only its own site (row-level
 * security and its pinned site). Sending a failed job again is listed under print.view and checked in the handler with
 * the permission that queued it (print.labels for a label, print.documents for a document). The label PDF is the
 * browser's fallback: no record, only the tenant's own scannable ids (`tenant`).
 */
export const manifest = defineManifest({
  'GET /print/printers': { audiences: ['office', 'floor'], permission: 'print.view', scope: 'record' },
  'POST /print/printers': { audiences: ['office'], permission: 'print.manage', scope: 'record' },
  'PATCH /print/printers/:printerId': { audiences: ['office'], permission: 'print.manage', scope: 'record' },
  'POST /print/jobs/label': { audiences: ['office', 'floor'], permission: 'print.labels', scope: 'record' },
  'POST /print/jobs/document': { audiences: ['office', 'floor'], permission: 'print.documents', scope: 'record' },
  'GET /print/jobs': { audiences: ['office', 'floor'], permission: 'print.view', scope: 'record' },
  'GET /print/jobs/:jobId': { audiences: ['office', 'floor'], permission: 'print.view', scope: 'record' },
  'POST /print/jobs/:jobId/retry': { audiences: ['office', 'floor'], permission: 'print.view', scope: 'record' },
  'POST /print/labels/pdf': { audiences: ['office', 'floor'], permission: 'print.labels', scope: 'tenant' },
})
