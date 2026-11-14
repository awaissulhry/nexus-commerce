import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { bySizeContract, setSizeWeightsContract, sizeWeightsContract } from './contract'
import { manifest } from './manifest'
import { costBySize, setSizeWeights, sizeWeights } from './weights'

/**
 * Size weights and the cost by size (B-W2b-420; FIN-016): a style's size mix per season or for every season, set as sent; a
 * cost sheet version's cost per size with its weighted cost and the surcharges suggested for the big sizes.
 */
export default defineRoutes('costing.size-weights', manifest, async (app) => {
  app.get('/costing/size-weights', { schema: sizeWeightsContract }, async (request) => sizeWeights(request, request.query))
  app.put('/costing/size-weights', { schema: setSizeWeightsContract }, async (request) => setSizeWeights(request, request.body, idempotencyKeyFrom(request)))
  app.get('/costing/cost-sheets/:sheetId/by-size', { schema: bySizeContract }, async (request) => costBySize(request, request.params.sheetId))
})
