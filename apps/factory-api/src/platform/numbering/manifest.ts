import { defineManifest, SIGNED_IN } from '../../core/manifest'

/**
 * The numbering routes (plan A1 §3.2 step 2): office admin screens. Each series belongs to a company, so the handler
 * checks the company with can() (writes) or scopeWhere() (the list). A tablet's number blocks belong to its company and
 * site (can() on the tablet). The tablet itself reads its open blocks and tops them up (floor.work, its own site).
 */
export const manifest = defineManifest({
  'GET /numbering/series': { audiences: ['office'], permission: 'numbering.view', scope: 'record' },
  'POST /numbering/series': { audiences: ['office'], permission: 'numbering.manage', scope: 'record' },
  'PUT /numbering/series/:seriesId/start': { audiences: ['office'], permission: 'numbering.manage', scope: 'record' },
  'POST /numbering/series/:seriesId/advance': { audiences: ['office'], permission: 'numbering.manage', scope: 'record' },
  'GET /numbering/series/:seriesId/allocations': { audiences: ['office'], permission: 'numbering.view', scope: 'record' },
  'POST /numbering/series/:seriesId/close': { audiences: ['office'], permission: 'numbering.manage', scope: 'record' },
  'GET /numbering/blocks': { audiences: ['office'], permission: 'numbering.view', scope: 'record' },
  'POST /numbering/blocks': { audiences: ['office'], permission: 'numbering.manage', scope: 'record' },
  'POST /numbering/blocks/:blockId/close': { audiences: ['office'], permission: 'numbering.manage', scope: 'record' },
  'GET /numbering/floor/blocks': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /numbering/floor/blocks/top-up': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  // B-W2b-24 (PLT-125): the number a new document would get (numbering.view, or the permission that makes such a document:
  // checked in override.ts), and "clashes refused at once" for a migrated document's typed number.
  'GET /numbering/preview': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'POST /numbering/override/check': { audiences: ['office'], permission: 'numbering.override', scope: 'record' },
})
