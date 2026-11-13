import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { applyPricedChange, depositKinds, listOrderChanges, previewPricedChange, putBackChange } from './changes'
import {
  applyPricedChangeContract,
  createFreezeRuleContract,
  depositKindsContract,
  listChangesContract,
  listFreezeRulesContract,
  orderFreezeContract,
  previewPricedChangeContract,
  putBackContract,
  updateFreezeRuleContract,
} from './contract'
import { createFreezeRule, listFreezeRules, orderFreeze, updateFreezeRule } from './freeze'
import { manifest } from './manifest'

/** Order changes (B-W2b-309): the freeze rules (./freeze.ts), priced changes, the order's changes and the put-back (./changes.ts). */
export default defineRoutes('sales.order-changes', manifest, async (app) => {
  app.get('/sales/order-freeze-rules', { schema: listFreezeRulesContract }, async (request) => listFreezeRules(request, request.query))
  app.post('/sales/order-freeze-rules', { schema: createFreezeRuleContract }, async (request, reply) => reply.code(201).send(await createFreezeRule(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/sales/order-freeze-rules/:ruleId', { schema: updateFreezeRuleContract }, async (request) => updateFreezeRule(request, request.params.ruleId, request.body, idempotencyKeyFrom(request)))
  app.get('/sales/orders/:orderId/freeze', { schema: orderFreezeContract }, async (request) => orderFreeze(request, request.params.orderId))
  app.post('/sales/orders/:orderId/priced-changes/preview', { schema: previewPricedChangeContract }, async (request) => previewPricedChange(request, request.params.orderId, request.body))
  app.post('/sales/orders/:orderId/priced-changes', { schema: applyPricedChangeContract }, async (request, reply) => reply.code(201).send(await applyPricedChange(request, request.params.orderId, request.body, idempotencyKeyFrom(request))))
  app.get('/sales/orders/:orderId/changes', { schema: listChangesContract }, async (request) => listOrderChanges(request, request.params.orderId))
  app.post('/sales/orders/:orderId/changes/:amendmentId/put-back', { schema: putBackContract }, async (request, reply) => reply.code(201).send(await putBackChange(request, request.params.orderId, request.params.amendmentId, request.body, idempotencyKeyFrom(request))))
  app.get('/sales/deposit-kinds', { schema: depositKindsContract }, async (request) => depositKinds(request, request.query))
})
