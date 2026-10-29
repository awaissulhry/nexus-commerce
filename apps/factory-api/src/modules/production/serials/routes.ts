import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { labelsViewContract, printLabelsContract, reprintCellContract, reprintSerialContract, scanContract, voidSerialContract, workOrderSerialsContract } from './contract'
import { printLabels, reprintCellLabels, reprintSerial, voidSerial } from './labels'
import { manifest } from './manifest'
import { labelsOfWorkOrder, scanForLabels, workOrderSerials } from './views'

/**
 * Batch or serial at the final operation and the garment labels behind the certificate gate (B-W1-44; MES-076,
 * PRD-348, QHS-051, PRD-331; A2 SCR-096, SCR-072): a work order's labels at the final operation, a scanned code, the
 * floor's "print the labels" (a size, or all), the reprint of a BATCH cell's labels or of a serial's label with a reason,
 * the void of a MADE serial, and for the office a work order's serials and label log. Every write is one command
 * (./labels.ts); a repeated Idempotency-Key answers 200 from its receipt and queues the same jobs.
 */
export default defineRoutes('production.serials', manifest, async (app) => {
  app.get('/production/serials/work-orders/:workOrderId', { schema: labelsViewContract }, async (request) => labelsOfWorkOrder(request, request.params.workOrderId, request.query))

  app.get('/production/serials/scan', { schema: scanContract }, async (request) => scanForLabels(request, request.query.code))

  app.post('/production/serials/work-orders/:workOrderId/labels', { schema: printLabelsContract }, async (request, reply) => {
    const result = await printLabels(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/serials/work-orders/:workOrderId/reprint', { schema: reprintCellContract }, async (request, reply) => {
    const result = await reprintCellLabels(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/serials/:serialId/reprint', { schema: reprintSerialContract }, async (request, reply) => {
    const result = await reprintSerial(request, request.params.serialId, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/serials/:serialId/void', { schema: voidSerialContract }, async (request, reply) => {
    const result = await voidSerial(request, request.params.serialId, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.get('/production/serials/work-orders/:workOrderId/serials', { schema: workOrderSerialsContract }, async (request) => workOrderSerials(request, request.params.workOrderId))
})
