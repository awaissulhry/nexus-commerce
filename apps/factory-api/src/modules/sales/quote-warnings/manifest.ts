import { defineManifest } from '../../../core/manifest'

/** The quote's Warnings (B-W2b-294; SAL-147): office only, the quote checked with can() over its company and customer inside. */
export const manifest = defineManifest({
  'GET /sales/quotes/:quoteId/warnings': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
})
