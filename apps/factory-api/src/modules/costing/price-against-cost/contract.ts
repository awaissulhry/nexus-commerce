import { defineContract, id, input } from '@nexus/factory-domain/core/contracts'
import { priceAgainstCostQuery, priceAgainstCostView } from '@nexus/factory-domain/costing/keep/contracts'

/** owb-pd3: GET /costing/styles/:styleId/price-against-cost?revisionId= — the answer is the view itself (web B's Cost tab reads it so). */
export const priceAgainstCostContract = defineContract({
  params: input({ styleId: id() }),
  querystring: priceAgainstCostQuery,
  response: { 200: priceAgainstCostView },
})
