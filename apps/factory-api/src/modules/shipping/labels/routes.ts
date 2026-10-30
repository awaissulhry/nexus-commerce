import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { systemCallerOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { processCarrier } from './carrier'
import { buyLabelsContract, getLabelsContract, printLabelsContract, trackingContract, voidAllLabelsContract, voidLabelContract } from './contract'
import { buyLabels, getLabels, printLabels, voidAllLabels, voidLabel } from './labels'
import { manifest } from './manifest'
import { getTracking } from './tracking'

/**
 * Carrier labels and tracking (B-W1-48): read a shipment's labels (with their files, print state and today's cut-off),
 * buy them through the company's Sendcloud account (201 when one was bought; a partial buy says which parcels still need
 * one; nothing to buy: 200), print them on the site's label printer, void one before the goods leave, and read the
 * tracking. Sendcloud's webhooks arrive through the inbound ledger (POST /inbound/sendcloud/<tenant>/<account>).
 */
export default defineRoutes('shipping.labels', manifest, async (app) => {
  app.get('/shipping/shipments/:shipmentId/labels', { schema: getLabelsContract }, async (request) => getLabels(request, request.params.shipmentId))

  app.post('/shipping/shipments/:shipmentId/labels', { schema: buyLabelsContract }, async (request, reply) => {
    const { created, answer } = await buyLabels({ carrier: processCarrier(), files: processFiles() }, request, request.params.shipmentId, request.body, idempotencyKeyFrom(request), (error) =>
      request.log.warn({ err: error }, 'a carrier label step failed'),
    )
    return reply.code(created ? 201 : 200).send(answer)
  })

  app.post('/shipping/shipments/:shipmentId/labels/print', { schema: printLabelsContract }, async (request, reply) =>
    reply.code(201).send(await printLabels(processFiles(), { caller: request, system: systemCallerOf(request) }, request.params.shipmentId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/shipping/shipments/:shipmentId/parcels/:parcelId/label/void', { schema: voidLabelContract }, async (request) =>
    voidLabel(processCarrier(), request, request.params.shipmentId, request.params.parcelId, request.body, idempotencyKeyFrom(request)),
  )

  // B-W2a-48 (LOG-028): every label of the shipment at once.
  app.post('/shipping/shipments/:shipmentId/labels/void', { schema: voidAllLabelsContract }, async (request) =>
    voidAllLabels(processCarrier(), request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)),
  )

  app.get('/shipping/shipments/:shipmentId/tracking', { schema: trackingContract }, async (request) => getTracking(request, request.params.shipmentId))
})
