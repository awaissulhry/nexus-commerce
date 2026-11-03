import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createRule, deleteRule, editRule, orderRules } from './commands'
import { createContract, deleteContract, editContract, listContract, orderContract, pickContract, previewContract, ruleContract } from './contract'
import { manifest } from './manifest'
import { pickRoute } from './pick'
import { previewRule } from './preview'
import { getRule, listRules } from './read'

/**
 * Inspection triggers (B-W2b-101; QHS-010, QHS-011): the reads in ./read.ts, the writes in ./commands.ts, the preview in
 * ./preview.ts, the pick in ./pick.ts, the worker's handler in ./handler.ts (opening in ./open.ts).
 */
export default defineRoutes('quality.triggers', manifest, async (app) => {
  app.get('/quality/inspection-triggers', { schema: listContract }, async (request) => listRules(request, request.query))

  app.post('/quality/inspection-triggers', { schema: createContract }, async (request, reply) => reply.code(201).send(await createRule(request, request.body, idempotencyKeyFrom(request))))

  app.post('/quality/inspection-triggers/order', { schema: orderContract }, async (request) => orderRules(request, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/inspection-triggers/preview', { schema: previewContract }, async (request) => previewRule(request, request.body))

  app.get('/quality/inspection-triggers/pick', { schema: pickContract }, async (request) => pickRoute(request, request.query))

  app.get('/quality/inspection-triggers/:triggerId', { schema: ruleContract }, async (request) => getRule(request, request.params.triggerId))

  app.patch('/quality/inspection-triggers/:triggerId', { schema: editContract }, async (request) => editRule(request, request.params.triggerId, request.body, idempotencyKeyFrom(request)))

  app.delete('/quality/inspection-triggers/:triggerId', { schema: deleteContract }, async (request) => deleteRule(request, request.params.triggerId, request.query, idempotencyKeyFrom(request)))
})
