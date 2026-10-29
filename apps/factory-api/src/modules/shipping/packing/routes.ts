import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  addParcelContract,
  changeParcelContract,
  packContract,
  packingQueueContract,
  packingViewContract,
  packSerialContract,
  placeLineContract,
  removeParcelContract,
  unpackSerialContract,
} from './contract'
import { manifest } from './manifest'
import { addParcel, changeParcel, getPacking, packingQueue, packSerial, packShipment, placeLine, removeParcel, unpackSerial, unpackShipment } from './packing'

/**
 * Packing a shipment (B-W1-46; LOG-039, LOG-002, QHS-073; A2 SCR-098, SCR-067): the queue, the packing view, parcels,
 * garments into parcels, serials, DRAFT ⇄ PACKED. For the office and a floor device at its own site.
 */
export default defineRoutes('shipping.packing', manifest, async (app) => {
  app.get('/shipping/packing', { schema: packingQueueContract }, async (request) => packingQueue(request, request.query))

  app.get('/shipping/packing/:shipmentId', { schema: packingViewContract }, async (request) => getPacking(request, request.params.shipmentId))

  app.post('/shipping/packing/:shipmentId/parcels', { schema: addParcelContract }, async (request, reply) =>
    reply.code(201).send(await addParcel(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))),
  )

  app.patch('/shipping/packing/:shipmentId/parcels/:parcelId', { schema: changeParcelContract }, async (request) =>
    changeParcel(request, request.params.shipmentId, request.params.parcelId, request.body, idempotencyKeyFrom(request)),
  )

  app.delete('/shipping/packing/:shipmentId/parcels/:parcelId', { schema: removeParcelContract }, async (request) =>
    removeParcel(request, request.params.shipmentId, request.params.parcelId, request.query, idempotencyKeyFrom(request)),
  )

  app.put('/shipping/packing/:shipmentId/lines/:lineId/parcel', { schema: placeLineContract }, async (request) =>
    placeLine(request, request.params.shipmentId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/shipping/packing/:shipmentId/serials', { schema: packSerialContract }, async (request) => packSerial(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.delete('/shipping/packing/:shipmentId/serials/:serialId', { schema: unpackSerialContract }, async (request) =>
    unpackSerial(request, request.params.shipmentId, request.params.serialId, request.query, idempotencyKeyFrom(request)),
  )

  app.post('/shipping/packing/:shipmentId/pack', { schema: packContract }, async (request) => packShipment(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.post('/shipping/packing/:shipmentId/unpack', { schema: packContract }, async (request) => unpackShipment(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))
})
