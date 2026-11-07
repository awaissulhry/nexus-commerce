import { defineManifest } from '../../../core/manifest'

/**
 * Proofs signed with the quote (B-W2b-165; SAL-199; design links.quote "Proofs you accept with it", sales.quotes
 * Documents): office routes over a quote (quotes.view to read, quotes.manage to change; the handlers check each quote's
 * company and customer, and files.upload to add a file), the order's and the work order's reads of the accepted proofs
 * (orders.view, workorders.view), and the customer's accept link (the `link` audience of a QUOTE_ACCEPT link, links.open,
 * scope `record`: its one quote; the handler serves only that link's version's proofs).
 */
export const manifest = defineManifest({
  'GET /sales/quotes/:quoteId/proofs': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
  'POST /sales/quotes/:quoteId/proofs': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  'POST /sales/quotes/:quoteId/proofs/carry': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  'POST /sales/quotes/:quoteId/proofs/:fileId/versions': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  'POST /sales/quotes/:quoteId/proofs/:fileId/complete': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  'DELETE /sales/quotes/:quoteId/proofs/:fileId': { audiences: ['office'], permission: 'quotes.manage', scope: 'record' },
  'GET /sales/orders/:orderId/proofs': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'GET /production/work-orders/:workOrderId/proofs': { audiences: ['office'], permission: 'workorders.view', scope: 'record' },
  'GET /link/quote/proofs/:fileId': { audiences: ['link'], permission: 'links.open', scope: 'record' },
})
