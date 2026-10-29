import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import {
  addLinesContract,
  cancelShipmentContract,
  changeLineContract,
  createShipmentContract,
  getShipmentContract,
  listShipmentsContract,
  packingListContract,
  readyContract,
  removeLineContract,
  updateShipmentContract,
} from './contract'
import { manifest } from './manifest'
import { packingList } from './packing-list'
import { readyToShip } from './ready'
import { addLines, cancelShipment, changeLine, createShipment, getShipment, listShipments, removeLine, updateShipment } from './shipments'

/**
 * Shipments from released goods only (B-W1-46; LOG-001, LOG-002, LOG-039, GAP-002; A2 SCR-066, SCR-067): what is ready
 * to ship, the shipments list and record, a DRAFT planned from a sales order, its lines and delivery details,
 * cancelling, the packing list. Packing (parcels, serials, packed) is ../packing; leaving with the DDT is B-W1-47.
 */
export default defineRoutes('shipping.shipments', manifest, async (app) => {
  app.get('/shipping/ready', { schema: readyContract }, async (request) => readyToShip(request, request.query))

  app.get('/shipping/shipments', { schema: listShipmentsContract }, async (request) => listShipments(request, request.query))

  app.get('/shipping/shipments/:shipmentId', { schema: getShipmentContract }, async (request) => getShipment(request, request.params.shipmentId))

  app.post('/shipping/shipments', { schema: createShipmentContract }, async (request, reply) => reply.code(201).send(await createShipment(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/shipping/shipments/:shipmentId', { schema: updateShipmentContract }, async (request) => updateShipment(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.post('/shipping/shipments/:shipmentId/lines', { schema: addLinesContract }, async (request) => addLines(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.patch('/shipping/shipments/:shipmentId/lines/:lineId', { schema: changeLineContract }, async (request) =>
    changeLine(request, request.params.shipmentId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  )

  app.delete('/shipping/shipments/:shipmentId/lines/:lineId', { schema: removeLineContract }, async (request) =>
    removeLine(request, request.params.shipmentId, request.params.lineId, request.query, idempotencyKeyFrom(request)),
  )

  app.post('/shipping/shipments/:shipmentId/cancel', { schema: cancelShipmentContract }, async (request) => cancelShipment(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.post('/shipping/shipments/:shipmentId/packing-list', { schema: packingListContract }, async (request, reply) =>
    reply.code(201).send(await packingList(processFiles(), request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))),
  )
})
