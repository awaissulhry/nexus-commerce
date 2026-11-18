import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { applyChange, declineChange } from './apply'
import { applyContract, declineContract, getContract, listContract, proposeContract } from './contract'
import { manifest } from './manifest'
import { proposeChange } from './propose'
import { getChange, listChanges } from './read'

/**
 * B-SA-041 (sales page plan; 13-backend B4b): the gap between a sales order and its work orders as a record — list, one,
 * propose, apply, decline (./read, ./propose, ./apply). Accept of a customer's change proposes in its own command (B-SA-042).
 */
export default defineRoutes('production.work-order-changes', manifest, async (app) => {
  app.get('/production/work-order-changes', { schema: listContract }, async (request) => listChanges(request, request.query))

  app.get('/production/work-order-changes/:changeId', { schema: getContract }, async (request) => getChange(request, request.params.changeId))

  app.post('/production/work-order-changes', { schema: proposeContract }, async (request, reply) => reply.code(201).send(await proposeChange(request, request.body, idempotencyKeyFrom(request))))

  app.post('/production/work-order-changes/:changeId/apply', { schema: applyContract }, async (request) => applyChange(request, request.params.changeId, request.body, idempotencyKeyFrom(request)))

  app.post('/production/work-order-changes/:changeId/decline', { schema: declineContract }, async (request) => declineChange(request, request.params.changeId, request.body, idempotencyKeyFrom(request)))
})
