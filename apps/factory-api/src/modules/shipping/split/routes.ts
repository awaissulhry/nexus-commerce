import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { splitByRuleContract, splitContract, splitPreviewContract } from './contract'
import { manifest } from './manifest'
import { splitByRule, splitPreview, splitShipment } from './split'

/**
 * Split one order into several shipments (B-W2b-386; LOG-005): what can move and the rule's proposal, a split by hand (by
 * carrier, service, delivery address or another reason), and the split by rule (by promise date).
 */
export default defineRoutes('shipping.split', manifest, async (app) => {
  app.get('/shipping/shipments/:shipmentId/split', { schema: splitPreviewContract }, async (request) => splitPreview(request, request.params.shipmentId))

  app.post('/shipping/shipments/:shipmentId/split', { schema: splitContract }, async (request, reply) => reply.code(201).send(await splitShipment(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))))

  app.post('/shipping/shipments/:shipmentId/split-by-rule', { schema: splitByRuleContract }, async (request, reply) => reply.code(201).send(await splitByRule(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))))
})
