import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { makeBundles, reprintBundle, voidBundle } from './bundles'
import { bundlesViewContract, bundleWorkOrdersContract, makeBundlesContract, reprintBundleContract, scanBundleContract, voidBundleContract, workOrderBundlesContract } from './contract'
import { manifest } from './manifest'
import { bundlesOfWorkOrder, bundleWorkOrders, scanBundle, workOrderBundles } from './views'

/**
 * Bundles and bundle tickets from a cut (B-W1-41; MES-065, MES-066, MES-068, MES-073; A2 SCR-095, SCR-072): the work
 * orders whose cut waits for bundles, a work order at the bundles step, the floor's "make bundles and print their
 * tickets", a scanned ticket, the reprint of a ticket with a new code and the void of a bundle made by mistake, and for
 * the office a work order's bundles. Every write is one command (./bundles.ts); a repeated Idempotency-Key answers 200
 * from its receipt.
 */
export default defineRoutes('production.bundles', manifest, async (app) => {
  app.get('/production/bundles/work-orders', { schema: bundleWorkOrdersContract }, async (request) => bundleWorkOrders(request, request.query))

  app.get('/production/bundles/work-orders/:workOrderId', { schema: bundlesViewContract }, async (request) => bundlesOfWorkOrder(request, request.params.workOrderId, request.query))

  app.post('/production/bundles/work-orders/:workOrderId/bundles', { schema: makeBundlesContract }, async (request, reply) => {
    const result = await makeBundles(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.get('/production/bundles/scan', { schema: scanBundleContract }, async (request) => scanBundle(request, request.query))

  app.post('/production/bundles/:bundleId/reprint', { schema: reprintBundleContract }, async (request, reply) => {
    const result = await reprintBundle(request, request.params.bundleId, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/bundles/:bundleId/void', { schema: voidBundleContract }, async (request, reply) => {
    const result = await voidBundle(request, request.params.bundleId, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.get('/production/bundles/work-orders/:workOrderId/bundles', { schema: workOrderBundlesContract }, async (request) => workOrderBundles(request, request.params.workOrderId))
})
