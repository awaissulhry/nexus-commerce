import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { liftContract, listContract, placeContract, placeManyContract } from './contract'
import { liftWorkOrderHold, listWorkOrderHolds, placeWorkOrderHold, placeWorkOrderHolds } from './holds'
import { manifest } from './manifest'

/**
 * B-PR-21: the plain production hold (./holds.ts). The office's ONE "Put on hold" dialog sends a reason of the HOLD list to
 * /quality/holds and a reason of the PRODUCTION_HOLD list here (factory-domain production/holds/rules `holdKindOfList`); the
 * list's Hold N does the same, with `POST /production/work-orders/holds` for N work orders.
 */
export default defineRoutes('production.holds', manifest, async (app) => {
  app.get('/production/work-orders/:workOrderId/holds', { schema: listContract }, async (request) => listWorkOrderHolds(request, request.params.workOrderId))

  app.post('/production/work-orders/holds', { schema: placeManyContract }, async (request, reply) => reply.code(201).send(await placeWorkOrderHolds(request, request.body, idempotencyKeyFrom(request))))

  app.post('/production/work-orders/:workOrderId/holds', { schema: placeContract }, async (request, reply) =>
    reply.code(201).send(await placeWorkOrderHold(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/production/work-orders/:workOrderId/holds/:holdId/lift', { schema: liftContract }, async (request) =>
    liftWorkOrderHold(request, request.params.workOrderId, request.params.holdId, request.body, idempotencyKeyFrom(request)),
  )
})
