import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { listProblemsContract, resolveProblemContract, shipmentProblemsContract } from './contract'
import { getShipmentProblems, listProblems, resolveProblem } from './exceptions'
import { manifest } from './manifest'

/**
 * Tracking problems (B-W2b-398; LOG-063): a shipment's problems, the open problems of the shipments the reader sees, and
 * resolve one. The worker raises them from the carrier's news and the scheduler's daily check (check.ts, in background.ts).
 */
export default defineRoutes('shipping.exceptions', manifest, async (app) => {
  app.get('/shipping/shipments/:shipmentId/tracking-problems', { schema: shipmentProblemsContract }, async (request) => getShipmentProblems(request, request.params.shipmentId))

  app.get('/shipping/tracking-problems', { schema: listProblemsContract }, async (request) => listProblems(request, request.query))

  app.post('/shipping/shipments/:shipmentId/tracking-problems/:exceptionId/resolve', { schema: resolveProblemContract }, async (request) =>
    resolveProblem(request, request.params.shipmentId, request.params.exceptionId, request.body, idempotencyKeyFrom(request)),
  )
})
