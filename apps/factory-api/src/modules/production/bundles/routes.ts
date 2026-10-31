import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { makeBundles, reprintBundle, voidBundle } from './bundles'
import {
  bundleRecordContract,
  bundleRulesContract,
  bundlesViewContract,
  bundleTilesContract,
  bundleWorkOrdersContract,
  changeBundleRulesContract,
  checkSetContract,
  findingsSummaryContract,
  issueCouponsContract,
  listBundlesContract,
  listFindingsContract,
  makeBundlesContract,
  reprintBundleContract,
  reprintCouponContract,
  reviewFindingContract,
  scanBundleContract,
  showWhoContract,
  splitBundleContract,
  stuckBundlesContract,
  voidBundleContract,
  voidCouponContract,
  workOrderBundlesContract,
  workOrderSetsContract,
} from './contract'
// W2b B-W2b-41.
import { issueCoupons, reprintCoupon, voidCoupon } from './coupons'
import { findingsSummary, listFindings, reviewFinding, showWho } from './findings'
import { checkSet, workOrderSets } from './matching'
import { bundleRules, changeBundleRules } from './site-rules'
import { bundleRecord, bundleTiles, listBundles, stuckBundles } from './tracked'
import { manifest } from './manifest'
import { splitBundle } from './split'
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

  // W2a B-W2a-13 (MES-071): split pieces off into a child bundle with its own ticket.
  app.post('/production/bundles/:bundleId/split', { schema: splitBundleContract }, async (request, reply) => {
    const result = await splitBundle(request, request.params.bundleId, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  // ---- W2b B-W2b-41: bundles tracked ----------------------------------------------------------------------------------------
  app.get('/production/bundles', { schema: listBundlesContract }, async (request) => listBundles(request, request.query))
  app.get('/production/bundles/tiles', { schema: bundleTilesContract }, async (request) => bundleTiles(request, request.query))
  app.get('/production/bundles/stuck', { schema: stuckBundlesContract }, async (request) => stuckBundles(request, request.query))
  app.get('/production/bundles/:bundleId', { schema: bundleRecordContract }, async (request) => bundleRecord(request, request.params.bundleId))

  app.post('/production/bundles/work-orders/:workOrderId/coupons', { schema: issueCouponsContract }, async (request, reply) => {
    const result = await issueCoupons(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })
  app.post('/production/bundles/coupons/:couponId/reprint', { schema: reprintCouponContract }, async (request, reply) => {
    const result = await reprintCoupon(request, request.params.couponId, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })
  app.post('/production/bundles/coupons/:couponId/void', { schema: voidCouponContract }, async (request, reply) => {
    const result = await voidCoupon(request, request.params.couponId, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.get('/production/bundles/sites/:siteId/rules', { schema: bundleRulesContract }, async (request) => bundleRules(request, request.params.siteId))
  app.post('/production/bundles/sites/:siteId/rules', { schema: changeBundleRulesContract }, async (request) => changeBundleRules(request, request.params.siteId, request.body, idempotencyKeyFrom(request)))

  app.get('/production/bundles/findings/summary', { schema: findingsSummaryContract }, async (request) => findingsSummary(request, request.query))
  app.get('/production/bundles/findings', { schema: listFindingsContract }, async (request) => listFindings(request, request.query))
  app.post('/production/bundles/findings/:findingId/review', { schema: reviewFindingContract }, async (request, reply) => reply.code(201).send(await reviewFinding(request, request.params.findingId, request.body, idempotencyKeyFrom(request))))
  // No Idempotency-Key is kept for "Show who": a receipt would store the names it answers.
  app.post('/production/bundles/findings/:findingId/who', { schema: showWhoContract }, async (request, reply) => reply.code(201).send(await showWho(request, request.params.findingId, request.body)))

  app.get('/production/bundles/work-orders/:workOrderId/sets', { schema: workOrderSetsContract }, async (request) => workOrderSets(request, request.params.workOrderId))
  app.get('/production/bundles/sets/check', { schema: checkSetContract }, async (request) => checkSet(request, request.query))
})
