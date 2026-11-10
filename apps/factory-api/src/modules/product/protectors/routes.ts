import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { addPlacementContract, getPlacementsContract, orderPlacementsContract, removePlacementsContract, updatePlacementContract } from './contract'
import { manifest } from './manifest'
import { addPlacement, getPlacements, orderPlacements, removePlacements, updatePlacement } from './placements'

/**
 * Protector placement (product module, B-W2b-233; PRD-074; design products.styles › Sizes & measurements › "Protector
 * placement"): per draft style revision, which protector goes in which pocket for which sizes, with the standard and level
 * the certified type asks and where the pocket sits; checked against the revision's BOM, the protector's own properties and
 * certificate, and the style's certificate (findings, never blocking). A copied revision copies it
 * (../measures/copy.ts); the user information (B-W2b-258) and the tech pack read it.
 */
export default defineRoutes('product.protectors', manifest, async (app) => {
  app.get('/product/styles/:styleId/revisions/:revisionId/protectors', { schema: getPlacementsContract }, async (request) => ({ protectors: await getPlacements(request, request.params.styleId, request.params.revisionId) }))
  app.post('/product/styles/:styleId/revisions/:revisionId/protectors', { schema: addPlacementContract }, async (request, reply) =>
    reply.code(201).send({ protectors: await addPlacement(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }),
  )
  app.patch('/product/styles/:styleId/revisions/:revisionId/protectors/:placementId', { schema: updatePlacementContract }, async (request) => ({
    protectors: await updatePlacement(request, request.params.styleId, request.params.revisionId, request.params.placementId, request.body, idempotencyKeyFrom(request)),
  }))
  app.post('/product/styles/:styleId/revisions/:revisionId/protectors/remove', { schema: removePlacementsContract }, async (request) => ({ protectors: await removePlacements(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }))
  app.put('/product/styles/:styleId/revisions/:revisionId/protectors/order', { schema: orderPlacementsContract }, async (request) => ({ protectors: await orderPlacements(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }))
})
