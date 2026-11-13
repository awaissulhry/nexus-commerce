import { defineManifest } from '../../../core/manifest'

/**
 * Two versions of a quote compared (B-W2b-302; SAL-158): office only, the quote checked with can() over its company AND
 * customer inside (`record`). No new permission: reading a quote's versions is quotes.view.
 */
export const manifest = defineManifest({
  'GET /sales/quotes/:quoteId/versions/compare': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
})
