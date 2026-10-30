import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { cancelReworkContract, doneReworkContract, listReworkContract, openReworkContract, reworkRecordContract, startReworkContract } from './contract'
import { manifest } from './manifest'
import { listRework, moveRework, openRework, reworkRecord } from './rework'

/**
 * The rework loop (B-W2a-13; MES-126; design production.scrap, floor.operation "Rework"): the rework orders of the
 * caller's sites, one rework, and the floor's and office's open, start, done and cancel. Every write is one command
 * (./rework.ts); a repeated Idempotency-Key answers 200 from its receipt.
 */
export default defineRoutes('production.rework', manifest, async (app) => {
  app.get('/production/rework', { schema: listReworkContract }, async (request) => listRework(request, request.query))

  app.get('/production/rework/:reworkId', { schema: reworkRecordContract }, async (request) => reworkRecord(request, request.params.reworkId))

  app.post('/production/rework', { schema: openReworkContract }, async (request, reply) => {
    const result = await openRework(request, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/rework/:reworkId/start', { schema: startReworkContract }, async (request, reply) => {
    const result = await moveRework(request, request.params.reworkId, 'start', request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/rework/:reworkId/done', { schema: doneReworkContract }, async (request, reply) => {
    const result = await moveRework(request, request.params.reworkId, 'done', request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/rework/:reworkId/cancel', { schema: cancelReworkContract }, async (request, reply) => {
    const result = await moveRework(request, request.params.reworkId, 'cancel', request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })
})
