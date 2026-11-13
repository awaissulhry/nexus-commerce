import { defineManifest } from '../../../core/manifest'

/**
 * Target price goal-seek (B-W2b-302; SAL-150): office only, the quote checked with can() over its company AND customer inside
 * (`record`), as every quote route. No new permission: pricing lines to a target is quote work (quotes.manage).
 */
export const manifest = defineManifest({
  'POST /sales/quotes/:quoteId/goal-seek': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
})
