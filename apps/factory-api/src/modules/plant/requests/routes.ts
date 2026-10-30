import type { FastifyRequest } from 'fastify'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireFloorStepUp } from '../../../platform/auth/floor/step-up'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { acknowledgeContract, closeRequestContract, listRequestsContract, makeJobContract, mergeContract, reportContract, requestCountsContract, requestRecordContract, signSafeContract } from '../contract'
import { manifest } from './manifest'
import { acknowledgeRequest, closeRequest, listRequests, makeJobOfRequest, mergeRequest, report, requestCounts, requestRecord, signSafe } from './requests'

/**
 * Machine requests (B-W2a-35; ./requests.ts): the report from the station or the office, the office's queue and triage,
 * and the technician's sign-safe (Owner answer H1), a signing act: the office's fresh code (requireStepUp) or the
 * floor's PIN (requireFloorStepUp), asked after every other check. Each write is one command with an Idempotency-Key;
 * a repeated key answers from its receipt (a queued floor report sent twice is reported once).
 */
export default defineRoutes('plant.requests', manifest, async (app) => {
  const sign = (request: FastifyRequest) => () => (request.factoryContext?.audience === 'floor' ? requireFloorStepUp(officeAuthOf(app), request) : requireStepUp(officeAuthOf(app), request))

  app.get('/plant/requests', { schema: listRequestsContract }, async (request) => listRequests(request, request.query))

  app.get('/plant/requests/counts', { schema: requestCountsContract }, async (request) => requestCounts(request, request.query))

  app.get('/plant/requests/:requestId', { schema: requestRecordContract }, async (request) => requestRecord(request, request.params.requestId))

  app.post('/plant/requests', { schema: reportContract }, async (request, reply) => {
    const answer = await report(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })

  app.post('/plant/requests/:requestId/acknowledge', { schema: acknowledgeContract }, async (request) => acknowledgeRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))

  app.post('/plant/requests/:requestId/job', { schema: makeJobContract }, async (request, reply) => {
    const answer = await makeJobOfRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed || request.body.jobId ? 200 : 201).send(answer)
  })

  app.post('/plant/requests/:requestId/merge', { schema: mergeContract }, async (request) => mergeRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))

  app.post('/plant/requests/:requestId/close', { schema: closeRequestContract }, async (request) => closeRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))

  app.post('/plant/requests/:requestId/sign-safe', { schema: signSafeContract }, async (request) => signSafe(request, request.params.requestId, request.body, sign(request), idempotencyKeyFrom(request)))
})
