import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { postShipment, reverseEntry } from './actions'
import { cogsListContract, cogsPostContract, cogsReverseContract } from './contract'
import { manifest } from './manifest'
import { cogsList } from './reads'

/**
 * Cost of goods sold at shipment (B-W2b-407; FIN-043): the entries the shipments that left posted (per line: garments,
 * material, labour, subcontract, overhead, cost per garment), a shipment's posted now, one reversed with a reason. A
 * repeated Idempotency-Key answers 200 from its receipt.
 */
export default defineRoutes('costing.costOfSales', manifest, async (app) => {
  app.get('/costing/cost-of-sales', { schema: cogsListContract }, async (request) => cogsList(request, request.query))

  app.post('/costing/cost-of-sales/post', { schema: cogsPostContract }, async (request, reply) => {
    const result = await postShipment(request, request.body.shipmentId, idempotencyKeyFrom(request))
    return reply.code(result.posted.length > 0 && !result.replayed ? 201 : 200).send(result)
  })

  app.post('/costing/cost-of-sales/:entryId/reverse', { schema: cogsReverseContract }, async (request, reply) => {
    const result = await reverseEntry(request, request.params.entryId, request.body.reason, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })
})
