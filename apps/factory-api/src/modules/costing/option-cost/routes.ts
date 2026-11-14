import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { groupCostsContract, setValueDeltaContract, styleOptionCostsContract } from './contract'
import { groupOptionCosts, setValueDelta, styleOptionCosts } from './costs'
import { manifest } from './manifest'

/**
 * An option's own cost (B-W2b-423; FIN-018, KS4:01): what each value a style offers adds to one garment of each size, the
 * library's view of a group's values (the Effects tab's cost column), and a value's typed material and minutes delta. The write
 * takes an Idempotency-Key (a repeat answers from its receipt) and the value's version.
 */
export default defineRoutes('costing.option-cost', manifest, async (app) => {
  app.get('/costing/styles/:styleId/option-costs', { schema: styleOptionCostsContract }, async (request) => styleOptionCosts(request, request.params.styleId, request.query))
  app.get('/costing/option-groups/:groupId/costs', { schema: groupCostsContract }, async (request) => groupOptionCosts(request, request.params.groupId, request.query))
  app.put('/costing/option-groups/:groupId/values/:valueId/cost', { schema: setValueDeltaContract }, async (request) => setValueDelta(request, request.params.groupId, request.params.valueId, request.body, idempotencyKeyFrom(request)))
})
