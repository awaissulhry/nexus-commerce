import { defineManifest } from '../../../core/manifest'

/**
 * The price of a line (B-W2b-330; SAL-173, SAL-174, SAL-175, SAL-181, SAL-189): office only (no price waterfall, fee or
 * floor on the floor, a link or the portal). A quote's routes are checked with can() over its company AND customer, an
 * order's over its company and customer, the settings over the company (`record`). No new permission: pricing a line and
 * its fees is quote work (quotes.view | quotes.manage), the floors by role are sales settings (sales.settings.manage).
 */
const quoteView = { audiences: ['office'], permission: 'quotes.view', scope: 'record' } as const
const quoteManage = { audiences: ['office'], permission: 'quotes.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/quotes/:quoteId/pricing': quoteView,
  'PUT /sales/quotes/:quoteId/lines/:lineId/price': quoteManage,
  'POST /sales/quotes/:quoteId/fees': quoteManage,
  'PATCH /sales/quotes/:quoteId/fees/:lineId': quoteManage,
  'GET /sales/orders/:orderId/pricing': { audiences: ['office'], permission: 'orders.view', scope: 'record' },
  'GET /sales/settings/margin-floors': quoteView,
  'PUT /sales/settings/margin-floors': { audiences: ['office'], permission: 'sales.settings.manage', scope: 'record' },
})
