import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { printAgain } from './again'
import { listPlacementsContract, printAgainContract, printSheetContract, savePlacementContract } from './contract'
import { manifest } from './manifest'
import { listPlacements, savePlacement } from './placements'
import { printSheet } from './sheet'

/**
 * "Print again" (the same codes, a reason; a small change tells the floor; PAPER calls solved) and the print sheet the browser draws
 * (owb- order workflow, S3 ss2 step 2.3). The FIRST print is ../print-start.
 */
export default defineRoutes('production.prints', manifest, async (app) => {
  app.post('/production/orders/:orderId/prints', { schema: printAgainContract }, async (request, reply) => reply.code(201).send(await printAgain(request, request.params.orderId, request.body, idempotencyKeyFrom(request))))

  app.get('/production/orders/:orderId/print-sheet', { schema: printSheetContract }, async (request) => printSheet(request, request.params.orderId, request.query))

  // owb-ss2b: Place the scan code.
  app.get('/production/orders/:orderId/placements', { schema: listPlacementsContract }, async (request) => listPlacements(request, request.params.orderId))

  app.put('/production/orders/:orderId/placements/:salesOrderLineId', { schema: savePlacementContract }, async (request) =>
    savePlacement(request, request.params.orderId, request.params.salesOrderLineId, request.body, idempotencyKeyFrom(request)),
  )
})
