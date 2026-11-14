import { defineRoutes } from '../../../core/manifest'
import { mtmCostContract } from './contract'
import { unitCost } from './cost'
import { manifest } from './manifest'

/**
 * One made-to-measure unit's cost (B-W2b-423; FIN-017): the base size's cost, the extra material of the lines that scale with
 * the rider's measures, the alteration minutes and the unit's options, read only (nothing is written). Refused in words while
 * made-to-measure has not started for the style's template (GATE-MTM).
 */
export default defineRoutes('costing.mtm-cost', manifest, async (app) => {
  app.post('/costing/made-to-measure/cost', { schema: mtmCostContract }, async (request) => unitCost(request, request.body))
})
