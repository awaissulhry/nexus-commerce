import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  addShipmentContract,
  cancelRoundContract,
  createRoundContract,
  listRoundsContract,
  makeWorkOrderContract,
  moveRoundContract,
  readRoundContract,
  removeShipmentContract,
  updateRoundContract,
  updateShipmentContract,
  workOrderOptionsContract,
} from './contract'
import { manifest } from './manifest'
import { cancelRound, createRound, listRounds, moveRound, readRound, updateRound } from './rounds'
import { addShipment, removeShipment, updateShipment } from './shipments'
import { makeWorkOrder, workOrderOptions } from './work-orders'

/**
 * Sample rounds (B-W2b-246): ./rounds.ts (the board, the list, the request, the moves, cancel), ./work-orders.ts (the sample work
 * order through W1's create), ./shipments.ts (courier, tracking, sent, received). The thread of a round is the platform's
 * (record type SampleRound: platform/threads/records.ts).
 */
export default defineRoutes('sales.samples', manifest, async (app) => {
  app.get('/sales/samples/rounds', { schema: listRoundsContract }, async (request) => listRounds(request, request.query))
  app.get('/sales/samples/rounds/:roundId', { schema: readRoundContract }, async (request) => ({ round: await readRound(request, request.params.roundId) }))
  app.post('/sales/samples/rounds', { schema: createRoundContract }, async (request, reply) => reply.code(201).send({ round: await createRound(request, request.body, idempotencyKeyFrom(request)) }))
  app.patch('/sales/samples/rounds/:roundId', { schema: updateRoundContract }, async (request) => ({ round: await updateRound(request, request.params.roundId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/sales/samples/rounds/:roundId/move', { schema: moveRoundContract }, async (request) => ({ round: await moveRound(request, request.params.roundId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/sales/samples/rounds/:roundId/cancel', { schema: cancelRoundContract }, async (request) => ({ round: await cancelRound(request, request.params.roundId, request.body, idempotencyKeyFrom(request)) }))
  app.get('/sales/samples/rounds/:roundId/work-order-options', { schema: workOrderOptionsContract }, async (request) => workOrderOptions(request, request.params.roundId))
  app.post('/sales/samples/rounds/:roundId/work-orders', { schema: makeWorkOrderContract }, async (request, reply) =>
    reply.code(201).send(await makeWorkOrder(request, request.params.roundId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/sales/samples/rounds/:roundId/shipments', { schema: addShipmentContract }, async (request, reply) =>
    reply.code(201).send(await addShipment(request, request.params.roundId, request.body, idempotencyKeyFrom(request))),
  )
  app.patch('/sales/samples/shipments/:shipmentId', { schema: updateShipmentContract }, async (request) => updateShipment(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))
  app.delete('/sales/samples/shipments/:shipmentId', { schema: removeShipmentContract }, async (request) => removeShipment(request, request.params.shipmentId, request.query.version, idempotencyKeyFrom(request)))
})
