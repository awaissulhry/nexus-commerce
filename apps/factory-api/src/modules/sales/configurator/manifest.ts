import { defineManifest } from '../../../core/manifest'

/**
 * The configurator on a quote or order line (B-W2b-340; SAL-133, SAL-136, SAL-139, SAL-140, SAL-249): office only (no
 * configurator on the floor, a link or the portal yet). A quote's routes are checked with can() over its company AND customer,
 * an order's the same, a style's over its company (`record`). No new permission: choosing a line's options is quote work
 * (quotes.view | quotes.manage) or order work (orders.view | orders.manage); the artwork also asks files.upload (the files
 * platform); the bench ("Test a combination") reads a style (product.styles.view).
 */
const quoteView = { audiences: ['office'], permission: 'quotes.view', scope: 'record' } as const
const quoteManage = { audiences: ['office'], permission: 'quotes.manage', scope: 'record' } as const
const orderView = { audiences: ['office'], permission: 'orders.view', scope: 'record' } as const
const orderManage = { audiences: ['office'], permission: 'orders.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/configurator/styles/:styleId': { audiences: ['office'], permission: 'product.styles.view', scope: 'record' },
  'GET /sales/quotes/:quoteId/lines/:lineId/configurator': quoteView,
  'POST /sales/quotes/:quoteId/lines/:lineId/configurator/check': quoteView,
  'PUT /sales/quotes/:quoteId/lines/:lineId/options': quoteManage,
  'POST /sales/quotes/:quoteId/lines/:lineId/artwork': quoteManage,
  'GET /sales/orders/:orderId/lines/:lineId/configurator': orderView,
  'POST /sales/orders/:orderId/lines/:lineId/configurator/check': orderView,
  'PUT /sales/orders/:orderId/lines/:lineId/options': orderManage,
  'POST /sales/orders/:orderId/lines/:lineId/artwork': orderManage,
})
