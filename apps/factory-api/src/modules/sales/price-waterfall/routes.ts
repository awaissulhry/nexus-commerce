import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { addFeeContract, editFeeContract, getFloorsContract, orderPricingContract, priceLineContract, quotePricingContract, saveFloorsContract } from './contract'
import { addFee, editFee } from './fees'
import { getMarginFloors, saveMarginFloors } from './floors'
import { manifest } from './manifest'
import { orderPricing } from './order-price'
import { priceLine, quotePricing } from './quote-price'

/**
 * The price of a line (B-W2b-330): a quote's pricing by line (waterfall, why this price, the list's and the cost's
 * prices, the margin against the floor), a line priced by its waterfall with a manual net and its reason, fees on a quote,
 * an order's waterfalls and fees, and the margin floors by role of the sales settings (lowering one asks a step-up).
 */
export default defineRoutes('sales.price-waterfall', manifest, async (app) => {
  app.get('/sales/quotes/:quoteId/pricing', { schema: quotePricingContract }, async (request) => quotePricing(request, request.params.quoteId))

  app.put('/sales/quotes/:quoteId/lines/:lineId/price', { schema: priceLineContract }, async (request) => priceLine(request, request.params.quoteId, request.params.lineId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/quotes/:quoteId/fees', { schema: addFeeContract }, async (request, reply) => reply.code(201).send(await addFee(request, request.params.quoteId, request.body, idempotencyKeyFrom(request))))

  app.patch('/sales/quotes/:quoteId/fees/:lineId', { schema: editFeeContract }, async (request) => editFee(request, request.params.quoteId, request.params.lineId, request.body, idempotencyKeyFrom(request)))

  app.get('/sales/orders/:orderId/pricing', { schema: orderPricingContract }, async (request) => orderPricing(request, request.params.orderId))

  app.get('/sales/settings/margin-floors', { schema: getFloorsContract }, async (request) => getMarginFloors(request, request.query))

  app.put('/sales/settings/margin-floors', { schema: saveFloorsContract }, async (request) => saveMarginFloors(request, request.body, idempotencyKeyFrom(request), () => requireStepUp(officeAuthOf(app), request)))
})
