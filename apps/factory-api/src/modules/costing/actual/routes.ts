import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { ledgerContract, postNowContract, reverseContract, workOrderCostContract, workOrderCostsContract } from './contract'
import { manifest } from './manifest'
import { ledger, workOrderCost, workOrderCosts } from './reads'
import { postNow, reverseEntry } from './reverse'

/**
 * Standard vs actual (B-W2a-21; design finance.costing "Cost at a glance", "Work orders: standard vs actual", "WO — cost",
 * "Cost ledger"; production.workorders "Labour & cost"): the work orders with their standard, estimate at release, actual
 * so far, variance and its biggest reason, and the tiles; one work order's bridge, materials, labour per operation and
 * scrap; the ledger; posting a work order's ledger now (the worker does it after each event) and reversing an entry with
 * a reason. A repeated Idempotency-Key answers 200 from its receipt.
 */
export default defineRoutes('costing.actual', manifest, async (app) => {
  app.get('/costing/work-orders', { schema: workOrderCostsContract }, async (request) => workOrderCosts(request, request.query))

  app.get('/costing/work-orders/:workOrderId', { schema: workOrderCostContract }, async (request) => ({ detail: await workOrderCost(request, request.params.workOrderId) }))

  app.get('/costing/ledger', { schema: ledgerContract }, async (request) => ledger(request, request.query))

  app.post('/costing/work-orders/:workOrderId/post', { schema: postNowContract }, async (request, reply) => {
    const result = await postNow(request, request.params.workOrderId, idempotencyKeyFrom(request))
    return reply.code(result.posted.length > 0 && !result.replayed ? 201 : 200).send(result)
  })

  app.post('/costing/entries/:entryId/reverse', { schema: reverseContract }, async (request, reply) => {
    const result = await reverseEntry(request, request.params.entryId, request.body.reason, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })
})
