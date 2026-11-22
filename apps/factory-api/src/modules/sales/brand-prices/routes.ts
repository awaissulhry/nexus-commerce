import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { brandPriceSummary } from './columns' // B-CP-018
import { priceCheckContract, saveBrandPricesContract, summaryContract, takeOverContract } from './contract'
import { manifest } from './manifest'
import { readPriceCheck, saveBrandPrices, takeOverBrandPrices } from './prices'
// B-OM-020 (order money tab; Owner D4): a price difference accepted by hand, and taken back.
import { acceptPriceDifference, takeBackPriceDifference } from './accept'
import { acceptPriceDifferenceContract, takeBackPriceDifferenceContract } from './contract'

/**
 * The customer's price and the price check of an order (customer page plan C2d, C3, B-CP-017): the check of one order, the
 * customer's prices set, changed and removed in one command, and the customer's own prices of its request taken over. Loaded
 * by its folder (core/autoload.ts).
 */
export default defineRoutes('sales.brand-prices', manifest, async (app) => {
  app.get('/sales/orders/:orderId/price-check', { schema: priceCheckContract }, async (request) => readPriceCheck(request, request.params.orderId))

  app.put('/sales/orders/:orderId/brand-prices', { schema: saveBrandPricesContract }, async (request) => saveBrandPrices(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/orders/:orderId/brand-prices/from-request', { schema: takeOverContract }, async (request) => takeOverBrandPrices(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))

  // B-CP-018: one customer's Not equal and No customer price yet counts.
  app.get('/sales/brand-prices/summary', { schema: summaryContract }, async (request) => brandPriceSummary(request, request.query))

  // B-OM-020: accept the difference by hand (the nets as read, a reason), and take it back (a reason).
  app.post('/sales/orders/:orderId/price-check/accept', { schema: acceptPriceDifferenceContract }, async (request) => acceptPriceDifference(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))
  app.delete('/sales/orders/:orderId/price-check/accept', { schema: takeBackPriceDifferenceContract }, async (request) => takeBackPriceDifference(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))
})
