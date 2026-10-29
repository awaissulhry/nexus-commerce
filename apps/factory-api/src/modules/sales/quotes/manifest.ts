import { defineManifest } from '../../../core/manifest'

/**
 * Quotes (B-W1-21; A2 SCR-030, SCR-034, SCR-035; SAL-143, SAL-172, SAL-184, SAL-203, SAL-268, GAP-001): office only (a
 * floor, portal or link session is refused by audience; the customer's accept link is B-W1-24's). A quote belongs to a
 * company and a customer, so the handlers check each quote with can() and filter the list with scopeWhere() (`record`).
 * Deciding an approval is its own permission (quotes.approve), apart from editing.
 */
export const manifest = defineManifest({
  'GET /sales/quotes': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
  'GET /sales/quotes/:quoteId': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
  'POST /sales/quotes': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  'PATCH /sales/quotes/:quoteId': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  'POST /sales/quotes/:quoteId/lines': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  'PATCH /sales/quotes/:quoteId/lines/:lineId': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  'DELETE /sales/quotes/:quoteId/lines/:lineId': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  'POST /sales/quotes/:quoteId/recompute': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  'POST /sales/quotes/:quoteId/approval': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  'POST /sales/quotes/:quoteId/approval/approve': { audiences: ['office'], permission: 'quotes.approve', scope: 'record' },
  'POST /sales/quotes/:quoteId/approval/reject': { audiences: ['office'], permission: 'quotes.approve', scope: 'record' },
  'POST /sales/quotes/:quoteId/reopen': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  'POST /sales/quotes/:quoteId/cancel': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  // The sales settings: the quote rules of a company or of the tenant.
  'GET /sales/settings': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
  'PUT /sales/settings': { audiences: ['office'], permission: 'sales.settings.manage', scope: 'record' },
})
