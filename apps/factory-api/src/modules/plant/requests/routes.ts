import type { FastifyRequest } from 'fastify'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireFloorStepUp } from '../../../platform/auth/floor/step-up'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { acknowledgeContract, closeRequestContract, listRequestsContract, makeJobContract, mergeContract, reportContract, requestCountsContract, requestRecordContract, signSafeContract } from '../contract'
import { manifest } from './manifest'
import { acknowledgeRequest, closeRequest, listRequests, makeJobOfRequest, mergeRequest, report, requestCounts, requestRecord, signSafe } from './requests'
// B-W2b-96: the requests in depth and a site's plant settings.
import {
  addRuleContract,
  announceRequestFileContract,
  changeRuleContract,
  completeRequestFileContract,
  duplicatesContract,
  listRoutingContract,
  lockFromRequestContract,
  locksContract,
  mergeManyContract,
  onTheWayContract,
  orderRulesContract,
  previewRoutingContract,
  readLockContract,
  removeRuleContract,
  setLockContract,
  worksAgainContract,
} from './contract-depth'
import { duplicatesRead, lockFromRequest, locksRead, mergeMany, stepRequest } from './depth'
import { announceMedia, completeMedia } from './files'
import { addRule, changeRule, listRouting, orderRules, previewRouting, readLockSettings, removeRule, setLockSettings } from './settings'

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

  // ---- B-W2b-96 -------------------------------------------------------------------------------------------------------
  app.get('/plant/requests/duplicates', { schema: duplicatesContract }, async (request) => duplicatesRead(request, request.query))
  app.get('/plant/requests/locks', { schema: locksContract }, async (request) => locksRead(request, request.query))
  app.post('/plant/requests/merge', { schema: mergeManyContract }, async (request) => mergeMany(request, request.body, idempotencyKeyFrom(request)))
  app.post('/plant/requests/:requestId/on-the-way', { schema: onTheWayContract }, async (request) => stepRequest(request, request.params.requestId, 'ON_THE_WAY', request.body, idempotencyKeyFrom(request)))
  app.post('/plant/requests/:requestId/works', { schema: worksAgainContract }, async (request) => stepRequest(request, request.params.requestId, 'WORKS_AGAIN', request.body, idempotencyKeyFrom(request)))
  app.post('/plant/requests/:requestId/lock', { schema: lockFromRequestContract }, async (request, reply) => {
    const answer = await lockFromRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.post('/plant/requests/:requestId/files', { schema: announceRequestFileContract }, async (request, reply) => reply.code(201).send(await announceMedia(request, 'MaintenanceRequest', request.params.requestId, request.body, idempotencyKeyFrom(request))))
  app.post('/plant/requests/:requestId/files/:fileId/complete', { schema: completeRequestFileContract }, async (request) => completeMedia(request, 'MaintenanceRequest', request.params.requestId, request.params.fileId, idempotencyKeyFrom(request)))

  app.get('/plant/settings/routing', { schema: listRoutingContract }, async (request) => listRouting(request, request.query))
  app.get('/plant/settings/routing/preview', { schema: previewRoutingContract }, async (request) => previewRouting(request, request.query))
  app.post('/plant/settings/routing', { schema: addRuleContract }, async (request, reply) => {
    const answer = await addRule(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.patch('/plant/settings/routing/:ruleId', { schema: changeRuleContract }, async (request) => changeRule(request, request.params.ruleId, request.body, idempotencyKeyFrom(request)))
  app.post('/plant/settings/routing/:ruleId/remove', { schema: removeRuleContract }, async (request) => removeRule(request, request.params.ruleId, request.body, idempotencyKeyFrom(request)))
  app.post('/plant/settings/routing/order', { schema: orderRulesContract }, async (request) => orderRules(request, request.body, idempotencyKeyFrom(request)))
  app.get('/plant/settings/lock', { schema: readLockContract }, async (request) => readLockSettings(request, request.query))
  // Loosening a safety rule (the hazard report switched off) is a signing act: the office's fresh code.
  app.put('/plant/settings/lock', { schema: setLockContract }, async (request) => setLockSettings(request, request.body, () => requireStepUp(officeAuthOf(app), request), idempotencyKeyFrom(request)))
})
