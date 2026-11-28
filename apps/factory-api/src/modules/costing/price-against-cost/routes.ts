import { defineRoutes } from '../../../core/manifest'
import { priceAgainstCostContract } from './contract'
import { manifest } from './manifest'
import { priceAgainstCost } from './read'

/**
 * owb-pd3 (S4; design plan § 5zh): every agreed (CUSTOMER) price of a product against its cost — the kept standard cost, else the
 * cost now — with what it earns, the margin (a share of the price), the flag against the target and the lowest price that keeps
 * it. EUR only. Read with costing.view and the price, cost and margin grains.
 */
export default defineRoutes('costing.priceAgainstCost', manifest, async (app) => {
  app.get('/costing/styles/:styleId/price-against-cost', { schema: priceAgainstCostContract }, async (request) => priceAgainstCost(request, request.params.styleId, request.query))
})
