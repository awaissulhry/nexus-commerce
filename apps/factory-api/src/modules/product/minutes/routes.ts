import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { approveContract, getOperationMinutesContract, proposeContract, rejectContract, routingTimesContract, stepMinutesContract, waitingContract } from './contract'
import { manifest } from './manifest'
import { getRoutingTimes, setStepMinutes } from './steps'
import { approveVersion, getOperationMinutes, listWaiting, proposeChange, rejectVersion } from './versions'

/**
 * Standard minutes and their governance (product module, B-W2b-215; features PRD-111, PRD-113, PRD-114, PRD-126): an
 * operation's SMV from basic minutes and allowances, a change proposed by one person and approved by a second, effective
 * from a day; a draft routing step's run (an approved version, its own allowances, or typed), its set-up, wait and move
 * minutes and its extra minutes per size; the routing's times per size and for a work order's quantity.
 */
export default defineRoutes('product.minutes', manifest, async (app) => {
  app.get('/product/operations/:operationId/minutes', { schema: getOperationMinutesContract }, async (request) => ({ minutes: await getOperationMinutes(request, request.params.operationId) }))

  app.post('/product/operations/:operationId/minutes/proposals', { schema: proposeContract }, async (request, reply) =>
    reply.code(201).send(await proposeChange(request, request.params.operationId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/product/operations/:operationId/minutes/versions/:versionId/approve', { schema: approveContract }, async (request) =>
    approveVersion(request, request.params.operationId, request.params.versionId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/product/operations/:operationId/minutes/versions/:versionId/reject', { schema: rejectContract }, async (request) =>
    rejectVersion(request, request.params.operationId, request.params.versionId, request.body, idempotencyKeyFrom(request)),
  )

  app.get('/product/minutes/waiting', { schema: waitingContract }, async (request) => listWaiting(request, request.query))

  app.get('/product/styles/:styleId/revisions/:revisionId/routing/times', { schema: routingTimesContract }, async (request) => ({
    times: await getRoutingTimes(request, request.params.styleId, request.params.revisionId, request.query),
  }))

  app.put('/product/styles/:styleId/revisions/:revisionId/routing/steps/:stepId/minutes', { schema: stepMinutesContract }, async (request) => ({
    times: await setStepMinutes(request, request.params.styleId, request.params.revisionId, request.params.stepId, request.body, idempotencyKeyFrom(request)),
  }))
})
