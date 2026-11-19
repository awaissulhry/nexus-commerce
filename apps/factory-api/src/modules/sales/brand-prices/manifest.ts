import { defineManifest } from '../../../core/manifest'

/**
 * The customer's price and the price check (customer page plan C2d, C3, B-CP-017): office only (the portal's own price check is
 * B-CP-019's, under /portal). Every route is checked per record: the order with can() over its company AND customer (a person
 * limited to other customers gets the same not-found as an unknown id: the brand wall), then the PRICE grain over it in the
 * handler (403 in words "Shown to people who see prices": the money wall). No new permission: reading an order's prices is
 * orders.view + money.price, writing them orders.manage + money.price.
 */
const view = { audiences: ['office'], permission: 'orders.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'orders.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/orders/:orderId/price-check': view,
  'PUT /sales/orders/:orderId/brand-prices': manage,
  'POST /sales/orders/:orderId/brand-prices/from-request': manage,
  // B-CP-018: one customer's counts (orders.view over that customer, and the price grain: the handler).
  'GET /sales/brand-prices/summary': view,
})
