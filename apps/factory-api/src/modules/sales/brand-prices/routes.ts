import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { priceCheckContract, saveBrandPricesContract, takeOverContract } from './contract'
import { manifest } from './manifest'
import { readPriceCheck, saveBrandPrices, takeOverBrandPrices } from './prices'

/**
 * The customer's price and the price check of an order (customer page plan C2d, C3, B-CP-017): the check of one order, the
 * customer's prices set, changed and removed in one command, and the customer's own prices of its request taken over. Loaded
 * by its folder (core/autoload.ts).
 */
export default defineRoutes('sales.brand-prices', manifest, async (app) => {
  app.get('/sales/orders/:orderId/price-check', { schema: priceCheckContract }, async (request) => readPriceCheck(request, request.params.orderId))

  app.put('/sales/orders/:orderId/brand-prices', { schema: saveBrandPricesContract }, async (request) => saveBrandPrices(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/orders/:orderId/brand-prices/from-request', { schema: takeOverContract }, async (request) => takeOverBrandPrices(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))
})
