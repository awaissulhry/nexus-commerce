import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { finishedContract, reportContract, reverseContract } from './contract'
import { finishedOf, reportFinished, reverseReport } from './finished'
import { manifest } from './manifest'

/**
 * Report finished to stock (B-W2a-12; GAP-003 work order completion into finished-goods stock, MES-011 partial
 * completion; design production.workorders pop-up "Report finished to stock"): per size the released garments not in
 * stock yet, a report of all or part of them into a finished-goods place (one PRODUCTION_RECEIPT per cell, valued at the
 * standard cost), and taking a report back with the reason.
 */
export default defineRoutes('production.completion', manifest, async (app) => {
  app.get('/production/work-orders/:workOrderId/finished', { schema: finishedContract }, async (request) => finishedOf(request, request.params.workOrderId))

  app.post('/production/work-orders/:workOrderId/finished', { schema: reportContract }, async (request, reply) =>
    reply.code(201).send(await reportFinished(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/production/work-orders/:workOrderId/finished/:reportId/reverse', { schema: reverseContract }, async (request) =>
    reverseReport(request, request.params.workOrderId, request.params.reportId, request.body, idempotencyKeyFrom(request)),
  )
})
