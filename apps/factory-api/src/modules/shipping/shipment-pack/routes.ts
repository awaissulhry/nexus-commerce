import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { systemCallerOf } from '../../../platform/files/files'
import { attachmentDisposition } from '../../../platform/files/rules'
import { processFiles } from '../../../platform/files/service'
import { makePackContract, packPdfContract, packStateContract } from './contract'
import { manifest } from './manifest'
import { makePack, packPdf, packState } from './pack'

/**
 * One PDF per shipment (B-W2b-391; LOG-031): what the pack holds, the pack made (one print job in the office), and its PDF for
 * the tablet's viewer.
 */
export default defineRoutes('shipping.shipmentPack', manifest, async (app) => {
  app.get('/shipping/shipments/:shipmentId/pack', { schema: packStateContract }, async (request) => packState({ caller: request, system: systemCallerOf(request) }, request.params.shipmentId))

  app.post('/shipping/shipments/:shipmentId/pack', { schema: makePackContract }, async (request) =>
    makePack(processFiles(), { caller: request, system: systemCallerOf(request) }, request.params.shipmentId, request.body, idempotencyKeyFrom(request)),
  )

  app.get('/shipping/shipments/:shipmentId/pack/pdf', { schema: packPdfContract }, async (request, reply) => {
    const { pdf, fileName } = await packPdf(processFiles(), { caller: request, system: systemCallerOf(request) }, request.params.shipmentId, request.query)
    return reply.type('application/pdf').header('content-disposition', attachmentDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
})
