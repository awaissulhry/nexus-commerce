import { defineRoutes } from '../../../core/manifest'
import { marginsContract, orderMarginContract } from './contract'
import { manifest } from './manifest'
import { orderMargin, orderMargins } from './margins'

/**
 * Order margin from estimate to actual (B-W2a-29; FIN-047; design finance.margins "Margins" tiles, "Order margin, quote
 * to actual", "By customer and style" and the "profitability" DetailModal; sales.orders Margin tab: "Margin, quoted →
 * now", "Where the margin went", "By line"). Reads only, computed from the order lines and the work orders' cost ledger.
 */
export default defineRoutes('costing.margins', manifest, async (app) => {
  app.get('/costing/margins', { schema: marginsContract }, async (request) => orderMargins(request, request.query))

  app.get('/costing/margins/orders/:orderId', { schema: orderMarginContract }, async (request) => orderMargin(request, request.params.orderId))
})
