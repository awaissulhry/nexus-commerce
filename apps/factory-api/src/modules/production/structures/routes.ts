import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  closeRuleContract,
  closeStructureContract,
  createRuleContract,
  createStructureContract,
  customerRulesContract,
  endOrderStructureContract,
  listRulesContract,
  listStructuresContract,
  orderRulesContract,
  orderStructureContract,
  putOrderStructureContract,
  tryRulesContract,
  updateRuleContract,
  updateStructureContract,
} from './contract'
import { manifest } from './manifest'
import { endOrderStructure, orderStructure, putOrderStructure } from './order'
import { closeRule, createRule, customerRules, listRules, orderRules, tryRules, updateRule } from './rules'
import { closeStructure, createStructure, listStructures, updateStructure } from './structures'

/** Order structures (./structures.ts), their rules (./rules.ts) and one order's structure (./order.ts). Each write is one command with an Idempotency-Key. */
export default defineRoutes('production.structures', manifest, async (app) => {
  app.get('/production/order-structures', { schema: listStructuresContract }, async (request) => listStructures(request))
  app.post('/production/order-structures', { schema: createStructureContract }, async (request, reply) => {
    const { result, replayed } = await createStructure(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(result)
  })
  app.patch('/production/order-structures/:structureId', { schema: updateStructureContract }, async (request) => updateStructure(request, request.params.structureId, request.body, idempotencyKeyFrom(request)))
  app.post('/production/order-structures/:structureId/close', { schema: closeStructureContract }, async (request) => closeStructure(request, request.params.structureId, false, request.body, idempotencyKeyFrom(request)))
  app.post('/production/order-structures/:structureId/reopen', { schema: closeStructureContract }, async (request) => closeStructure(request, request.params.structureId, true, request.body, idempotencyKeyFrom(request)))

  app.get('/production/structure-rules', { schema: listRulesContract }, async (request) => listRules(request))
  app.post('/production/structure-rules', { schema: createRuleContract }, async (request, reply) => {
    const { result, replayed } = await createRule(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(result)
  })
  app.patch('/production/structure-rules/:ruleId', { schema: updateRuleContract }, async (request) => updateRule(request, request.params.ruleId, request.body, idempotencyKeyFrom(request)))
  app.put('/production/structure-rules/order', { schema: orderRulesContract }, async (request) => orderRules(request, request.body, idempotencyKeyFrom(request)))
  app.post('/production/structure-rules/:ruleId/close', { schema: closeRuleContract }, async (request) => closeRule(request, request.params.ruleId, false, request.body, idempotencyKeyFrom(request)))
  app.post('/production/structure-rules/:ruleId/reopen', { schema: closeRuleContract }, async (request) => closeRule(request, request.params.ruleId, true, request.body, idempotencyKeyFrom(request)))
  app.post('/production/structure-rules/try', { schema: tryRulesContract }, async (request) => tryRules(request, request.body))

  app.get('/production/orders/:orderId/structure', { schema: orderStructureContract }, async (request) => orderStructure(request, request.params.orderId))
  app.put('/production/orders/:orderId/structure', { schema: putOrderStructureContract }, async (request) => putOrderStructure(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))
  app.delete('/production/orders/:orderId/structure', { schema: endOrderStructureContract }, async (request) => endOrderStructure(request, request.params.orderId, idempotencyKeyFrom(request)))

  app.get('/production/customers/:partyId/structure-rules', { schema: customerRulesContract }, async (request) => customerRules(request, request.params.partyId))
})
