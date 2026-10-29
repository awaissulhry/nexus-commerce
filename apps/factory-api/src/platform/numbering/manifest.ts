import { defineManifest } from '../../core/manifest'

/**
 * The numbering routes (plan A1 §3.2 step 2): office admin screens. Each series belongs to a company, so the handler
 * checks the company with can() (writes) or scopeWhere() (the list).
 */
export const manifest = defineManifest({
  'GET /numbering/series': { audiences: ['office'], permission: 'numbering.view', scope: 'record' },
  'POST /numbering/series': { audiences: ['office'], permission: 'numbering.manage', scope: 'record' },
  'PUT /numbering/series/:seriesId/start': { audiences: ['office'], permission: 'numbering.manage', scope: 'record' },
  'POST /numbering/series/:seriesId/advance': { audiences: ['office'], permission: 'numbering.manage', scope: 'record' },
  'GET /numbering/series/:seriesId/allocations': { audiences: ['office'], permission: 'numbering.view', scope: 'record' },
  'POST /numbering/series/:seriesId/close': { audiences: ['office'], permission: 'numbering.manage', scope: 'record' },
})
