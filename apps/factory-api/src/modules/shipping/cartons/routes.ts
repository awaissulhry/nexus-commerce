import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { systemCallerOf } from '../../../platform/files/files'
import { attachmentDisposition } from '../../../platform/files/rules'
import { scanIntoCarton } from '../packing/scan'
import { closeCarton, getBench, getShipmentCartons, takeOut } from './cartons'
import { benchContract, closeContract, marksPdfContract, printMarksContract, scanContract, takeOutContract } from './contract'
import { manifest } from './manifest'
import { marksPdfOf, printMarks } from './marks'

/**
 * Packing in depth (B-W2b-384; LOG-007, LOG-003, LOG-010, LOG-013): the bench's view, a garment scanned into a carton or
 * taken out, Close carton, the cartons' shipping marks on the label printer or as a PDF, and the office's read of the
 * cartons of a shipment.
 */
export default defineRoutes('shipping.cartons', manifest, async (app) => {
  app.get('/shipping/packing/:shipmentId/cartons', { schema: benchContract }, async (request) => getBench(request, request.params.shipmentId))

  app.post('/shipping/packing/:shipmentId/scan', { schema: scanContract }, async (request) => scanIntoCarton(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.post('/shipping/packing/:shipmentId/cartons/:parcelId/take-out', { schema: takeOutContract }, async (request) =>
    takeOut(request, request.params.shipmentId, request.params.parcelId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/shipping/packing/:shipmentId/cartons/:parcelId/close', { schema: closeContract }, async (request) =>
    closeCarton({ caller: request, system: systemCallerOf(request) }, request.params.shipmentId, request.params.parcelId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/shipping/packing/:shipmentId/cartons/marks/print', { schema: printMarksContract }, async (request, reply) =>
    reply.code(201).send(await printMarks({ caller: request, system: systemCallerOf(request) }, request.params.shipmentId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/shipping/packing/:shipmentId/cartons/marks/pdf', { schema: marksPdfContract }, async (request, reply) => {
    const { pdf, fileName } = await marksPdfOf({ caller: request, system: systemCallerOf(request) }, request.params.shipmentId, request.body, idempotencyKeyFrom(request))
    return reply.type('application/pdf').header('content-disposition', attachmentDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.get('/shipping/shipments/:shipmentId/cartons', { schema: benchContract }, async (request) => getShipmentCartons(request, request.params.shipmentId))
})
