import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { correctContract, cutContract, cutLogContract, cutsListContract, cuttingViewContract, cuttingWorkOrdersContract, remnantContract, scanHideContract, undoContract } from './contract'
import { correctCut, logCut, undoCut } from './cut'
import { manifest } from './manifest'
import { cutsList } from './office'
import { cutLog, cuttingView, cuttingWorkOrders, scanHide } from './views'

/**
 * The cutting log per hide (B-W1-40; MES-051, MES-056, MES-058, SCM-194, SCM-253; A2 SCR-094, SCR-071): the work orders
 * to cut for, a work order at the cutting table, a scanned hide, a cut (the scan issues a hide still in stock in the same
 * command), Hide done with its remnant back to stock, the undo of one's own last cut, and for the office the cut log of
 * a work order and the correction of an entry. Every write is one command (./cut.ts); a resent floor event (the same
 * client event id) answers 200 with the entry recorded before.
 */
export default defineRoutes('production.cutting', manifest, async (app) => {
  app.get('/production/cutting/work-orders', { schema: cuttingWorkOrdersContract }, async (request) => cuttingWorkOrders(request, request.query))

  app.get('/production/cutting/work-orders/:workOrderId', { schema: cuttingViewContract }, async (request) => cuttingView(request, request.params.workOrderId))

  app.get('/production/cutting/hides', { schema: scanHideContract }, async (request) => scanHide(request, request.query))

  app.post('/production/cutting/work-orders/:workOrderId/cuts', { schema: cutContract }, async (request, reply) => {
    const result = await logCut(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/cutting/work-orders/:workOrderId/hides/:hideId/remnant', { schema: remnantContract }, async (request, reply) => {
    const { remnant, note, clientEventId, occurredAt } = request.body
    const result = await logCut(
      request,
      request.params.workOrderId,
      { hideId: request.params.hideId, lines: [], done: { remnant }, note, clientEventId, ...(occurredAt ? { occurredAt } : {}) },
      idempotencyKeyFrom(request),
    )
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/cutting/cuts/:cutLogId/undo', { schema: undoContract }, async (request, reply) =>
    reply.code(201).send(await undoCut(request, request.params.cutLogId, idempotencyKeyFrom(request))),
  )

  app.get('/production/cutting/work-orders/:workOrderId/cut-log', { schema: cutLogContract }, async (request) => cutLog(request, request.params.workOrderId))

  app.post('/production/cutting/cuts/:cutLogId/correct', { schema: correctContract }, async (request, reply) =>
    reply.code(201).send(await correctCut(request, request.params.cutLogId, request.body, idempotencyKeyFrom(request))),
  )

  // B-W2a-60: the cutting office's list of cuts (office.ts).
  app.get('/production/cutting/cuts', { schema: cutsListContract }, async (request) => cutsList(request, request.query))
})
