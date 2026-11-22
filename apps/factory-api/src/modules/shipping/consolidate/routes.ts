import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { mergeShipment, moveGarments, moveTargets, takeOrderOff } from './consolidate'
import { mergeContract, moveContract, moveTargetsContract, takeOffContract } from './contract'
import { manifest } from './manifest'

/**
 * Consolidate and split (B-OS-011 … B-OS-013): the DRAFTs a shipment's garments may move to, moving garments onto one, merging
 * into one, and taking one order off a shared DRAFT — each ONE command.
 */
export default defineRoutes('shipping.consolidate', manifest, async (app) => {
  app.get('/shipping/shipments/:shipmentId/move-targets', { schema: moveTargetsContract }, async (request) => moveTargets(request, request.params.shipmentId))

  app.post('/shipping/shipments/:shipmentId/move', { schema: moveContract }, async (request) => moveGarments(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.post('/shipping/shipments/:shipmentId/merge', { schema: mergeContract }, async (request) => mergeShipment(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.post('/shipping/shipments/:shipmentId/orders/:salesOrderId/take-off', { schema: takeOffContract }, async (request) =>
    takeOrderOff(request, request.params.shipmentId, request.params.salesOrderId, request.body, idempotencyKeyFrom(request)),
  )
})
