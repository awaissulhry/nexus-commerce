import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { labelJobsContract, reprintContract } from './contract'
import { manifest } from './manifest'
import { labelJobs, reprintLabels } from './reprint'

/**
 * Reprint a label with a reason (B-W2b-391; LOG-027): a shipment's label jobs with who, when and why, and the reprint of the
 * ones chosen (new print jobs copying their ZPL; nothing bought again).
 */
export default defineRoutes('shipping.reprint', manifest, async (app) => {
  app.get('/shipping/shipments/:shipmentId/label-jobs', { schema: labelJobsContract }, async (request) => labelJobs(request, request.params.shipmentId))

  app.post('/shipping/shipments/:shipmentId/label-jobs/reprint', { schema: reprintContract }, async (request, reply) =>
    reply.code(201).send(await reprintLabels(request, request.params.shipmentId, request.body, idempotencyKeyFrom(request))),
  )
})
