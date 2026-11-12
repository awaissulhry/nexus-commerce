import { defineManifest } from '../../../core/manifest'

/**
 * A quote's delivery terms, its delivery schedule per line and its validity (B-W2b-294; SAL-145, SAL-151, SAL-162): office only,
 * each quote checked with can() over its company and customer inside (`record`), as every quote route.
 */
export const manifest = defineManifest({
  'GET /sales/quotes/:quoteId/terms': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
  'PUT /sales/quotes/:quoteId/terms': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  'PUT /sales/quotes/:quoteId/lines/:lineId/deliveries': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
})
