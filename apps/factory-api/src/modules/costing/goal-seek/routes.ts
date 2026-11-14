import { defineRoutes } from '../../../core/manifest'
import { goalSeekContract } from './contract'
import { goalSeekOf } from './goal-seek'
import { manifest } from './manifest'

/** Target price and goal-seek (B-W2b-420; FIN-013): a version's allowed cost for a target price and margin, and the lines that must change. */
export default defineRoutes('costing.goal-seek', manifest, async (app) => {
  app.get('/costing/cost-sheets/:sheetId/goal-seek', { schema: goalSeekContract }, async (request) => goalSeekOf(request, request.params.sheetId, request.query))
})
