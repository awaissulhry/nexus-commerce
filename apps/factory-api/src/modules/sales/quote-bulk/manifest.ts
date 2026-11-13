import { defineManifest } from '../../../core/manifest'

/**
 * Paste lines, change a size run in bulk, fill by a size curve or a prepack (B-W2b-302; SAL-160, SAL-269, QT2:01): office only,
 * the quote checked with can() over its company AND customer inside (`record`). No new permission: quote work (quotes.manage).
 */
const manage = { audiences: ['office'], permission: 'quotes.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'POST /sales/quotes/:quoteId/lines/paste': manage,
  'POST /sales/quotes/:quoteId/lines/sizes': manage,
  'POST /sales/quotes/:quoteId/lines/fill': manage,
})
