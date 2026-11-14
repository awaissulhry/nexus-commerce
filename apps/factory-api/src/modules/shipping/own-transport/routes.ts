import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { arrangeTransportContract, getOwnTransportContract, typeStatusContract, typeTrackingNumberContract } from './contract'
import { manifest } from './manifest'
import { arrangeTransport, getOwnTransport, typeStatus, typeTrackingNumber } from './own-transport'

/**
 * A manual carrier or our own van (B-W2b-390; LOG-122): how the goods travel, the manual carrier's tracking number, and the
 * status typed when no carrier tracks the goods (delivered and returned move the shipment). The DDT and the ship step are
 * W1's routes.
 */
export default defineRoutes('shipping.own-transport', manifest, async (app) => {
  app.get('/shipping/shipments/:shipmentId/own-transport', { schema: getOwnTransportContract }, async (request) => getOwnTransport(request, request.params.shipmentId))

  app.put('/shipping/shipments/:shipmentId/own-transport', { schema: arrangeTransportContract }, async (request) =>
    arrangeTransport(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)),
  )

  app.put('/shipping/shipments/:shipmentId/own-transport/tracking', { schema: typeTrackingNumberContract }, async (request) =>
    typeTrackingNumber(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/shipping/shipments/:shipmentId/own-transport/events', { schema: typeStatusContract }, async (request, reply) =>
    reply.code(201).send(await typeStatus(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))),
  )
})
