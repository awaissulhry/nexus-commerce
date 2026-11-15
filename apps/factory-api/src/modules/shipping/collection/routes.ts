import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import { downloadCollectionSignature, getCollection, recordCollection } from './collection'
import { downloadSignatureContract, getCollectionContract, recordCollectionContract } from './contract'
import { manifest } from './manifest'

/**
 * The customer's own carrier collects (B-W2b-395; LOG-053): who collected, the plate and the signed DDT, read and recorded;
 * the signed DDT's download. The goods leave by W1's routes (they refuse a collection not complete); the delivery follows.
 */
export default defineRoutes('shipping.collection', manifest, async (app) => {
  app.get('/shipping/shipments/:shipmentId/collection', { schema: getCollectionContract }, async (request) => getCollection(request, request.params.shipmentId))

  app.put('/shipping/shipments/:shipmentId/collection', { schema: recordCollectionContract }, async (request) =>
    recordCollection(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request)),
  )

  app.get('/shipping/shipments/:shipmentId/collection/signature', { schema: downloadSignatureContract }, async (request) => downloadCollectionSignature(processFiles(), request, request.params.shipmentId))
})
