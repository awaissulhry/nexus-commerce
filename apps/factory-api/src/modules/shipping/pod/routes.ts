import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import { downloadPodContract, getPodContract, recordPodContract } from './contract'
import { manifest } from './manifest'
import { downloadPod, getPod, recordPod } from './pod'

/**
 * The proof of delivery on the shipment (B-W2b-398; LOG-065): read it, record it by hand, download its image. The worker
 * asks the carrier for it when tracking says delivered (handler.ts, in background.ts).
 */
export default defineRoutes('shipping.pod', manifest, async (app) => {
  app.get('/shipping/shipments/:shipmentId/pod', { schema: getPodContract }, async (request) => getPod(request, request.params.shipmentId))

  app.put('/shipping/shipments/:shipmentId/pod', { schema: recordPodContract }, async (request) => recordPod(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)))

  app.get('/shipping/shipments/:shipmentId/pod/file', { schema: downloadPodContract }, async (request) => downloadPod(processFiles(), request, request.params.shipmentId))
})
