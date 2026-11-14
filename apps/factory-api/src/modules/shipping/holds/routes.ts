import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { getHoldsContract, listHoldsContract, placeHoldContract, placeHoldsContract, releaseHoldContract } from './contract'
import { getHolds, listHolds, placeHold, placeHolds, releaseHold } from './holds'
import { manifest } from './manifest'

/**
 * Hold and release a shipment (B-W2b-386; LOG-017, FIN-079): a shipment's holds, a hold placed or released with words, the
 * same hold on several shipments (the queue's selection row), and the holds list. The system's own holds (the balance
 * before shipping, the account on hold, over the credit limit) are placed and lifted by ./system.ts.
 */
export default defineRoutes('shipping.holds', manifest, async (app) => {
  app.get('/shipping/shipments/:shipmentId/holds', { schema: getHoldsContract }, async (request) => getHolds(request, request.params.shipmentId))

  app.post('/shipping/shipments/:shipmentId/holds', { schema: placeHoldContract }, async (request, reply) => reply.code(201).send(await placeHold(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))))

  app.post('/shipping/shipments/:shipmentId/holds/:holdId/release', { schema: releaseHoldContract }, async (request) =>
    releaseHold(request, request.params.shipmentId, request.params.holdId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/shipping/holds', { schema: placeHoldsContract }, async (request, reply) => reply.code(201).send(await placeHolds(request, request.body, idempotencyKeyFrom(request))))

  app.get('/shipping/holds', { schema: listHoldsContract }, async (request) => listHolds(request, request.query))
})
