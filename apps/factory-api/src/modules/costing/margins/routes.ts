import { defineRoutes } from '../../../core/manifest'
import { marginsContract, orderMarginContract } from './contract'
import { manifest } from './manifest'
import { orderMargin, orderMargins } from './margins'
// B-OM-021 (order money tab): an order's margin set by hand.
import { idempotencyKeyFrom } from '../../../core/command'
import { addCostLineContract, removeCostLineContract, setTargetContract } from './contract'
import { addOrderCostLine, removeOrderCostLine, setOrderMarginTarget } from './hand'

/**
 * Order margin from estimate to actual (B-W2a-29; FIN-047; design finance.margins "Margins" tiles, "Order margin, quote
 * to actual", "By customer and style" and the "profitability" DetailModal; sales.orders Margin tab: "Margin, quoted →
 * now", "Where the margin went", "By line"). Reads only, computed from the order lines and the work orders' cost ledger.
 */
export default defineRoutes('costing.margins', manifest, async (app) => {
  app.get('/costing/margins', { schema: marginsContract }, async (request) => orderMargins(request, request.query))

  app.get('/costing/margins/orders/:orderId', { schema: orderMarginContract }, async (request) => orderMargin(request, request.params.orderId))

  // B-OM-021: a hand cost line added, one removed, the target set or cleared.
  app.post('/costing/margins/orders/:orderId/cost-lines', { schema: addCostLineContract }, async (request) => addOrderCostLine(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))
  app.post('/costing/margins/orders/:orderId/cost-lines/:lineId/remove', { schema: removeCostLineContract }, async (request) => removeOrderCostLine(request, request.params.orderId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.put('/costing/margins/orders/:orderId/target', { schema: setTargetContract }, async (request) => setOrderMarginTarget(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))
})
