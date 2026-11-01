import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  approveReplacementContract,
  askReplacementContract,
  cancelReplacementContract,
  doneReplacementContract,
  listReplacementsContract,
  refuseReplacementContract,
  replacementRecordContract,
  scrapListContract,
  scrapStockContract,
} from './contract'
import { manifest } from './manifest'
// B-W2b-53 (MES-128): scrap above a site's limit waits for the team leader's approval.
import { approveManyOverLimitContract, approveOverLimitContract, floorWaitingContract, officeWaitingContract, refuseOverLimitContract } from './contract'
import { floorDecide, floorWaiting, officeApproveMany, officeDecide, officeWaitingRows } from './over-limit'
import { requireFloorStepUp } from '../../../platform/auth/floor/step-up'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { askReplacement, changeReplacement, listReplacements, replacementRecord } from './replacements'
import { scrapStock } from './stock'
import { scrapList } from './views'

/**
 * Scrap & rework in the office (B-W2a-13; MES-129, MES-130; design production.scrap): the scrap list with the leather
 * each scrapped garment held per lot and hide, material scrapped for a work order posted out of stock by lot, and the
 * replacements of scrapped garments (recuts, order reductions). Every write is one command; a repeated Idempotency-Key
 * answers 200 from its receipt.
 */
export default defineRoutes('production.scrap', manifest, async (app) => {
  app.get('/production/scrap', { schema: scrapListContract }, async (request) => scrapList(request, request.query))

  app.post('/production/scrap/stock', { schema: scrapStockContract }, async (request, reply) => reply.code(201).send(await scrapStock(request, request.body, idempotencyKeyFrom(request))))

  app.get('/production/replacements', { schema: listReplacementsContract }, async (request) => listReplacements(request, request.query))

  app.get('/production/replacements/:replacementId', { schema: replacementRecordContract }, async (request) => replacementRecord(request, request.params.replacementId))

  app.post('/production/replacements', { schema: askReplacementContract }, async (request, reply) => {
    const result = await askReplacement(request, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/replacements/:replacementId/approve', { schema: approveReplacementContract }, async (request, reply) => {
    const result = await changeReplacement(request, request.params.replacementId, 'approve', request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/replacements/:replacementId/refuse', { schema: refuseReplacementContract }, async (request, reply) => {
    const result = await changeReplacement(request, request.params.replacementId, 'refuse', request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/replacements/:replacementId/done', { schema: doneReplacementContract }, async (request, reply) => {
    const result = await changeReplacement(request, request.params.replacementId, 'done', request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  app.post('/production/replacements/:replacementId/cancel', { schema: cancelReplacementContract }, async (request, reply) => {
    const result = await changeReplacement(request, request.params.replacementId, 'cancel', request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })

  // B-W2b-53 (MES-128): the office decides scrap above a site's limit (production.scrap.overLimit); the scrap list shows it.
  app.get('/production/scrap/over-limit', { schema: officeWaitingContract }, async (request) => officeWaitingRows(request, request.query))

  app.post('/production/scrap/over-limit/approve', { schema: approveManyOverLimitContract }, async (request) => officeApproveMany(request, request.body, idempotencyKeyFrom(request)))

  app.post('/production/scrap/over-limit/:scanId/approve', { schema: approveOverLimitContract }, async (request) =>
    officeDecide(request, request.params.scanId, { decision: 'APPROVED', ...(request.body.note ? { note: request.body.note } : {}) }, idempotencyKeyFrom(request)),
  )

  app.post('/production/scrap/over-limit/:scanId/refuse', { schema: refuseOverLimitContract }, async (request) =>
    officeDecide(request, request.params.scanId, { decision: 'REFUSED', reason: request.body.reason, ...(request.body.note ? { note: request.body.note } : {}) }, idempotencyKeyFrom(request)),
  )

  // B-W2b-53 (MES-128): the team leader on the tablet (floor.lead, the device's site); approving signs with the PIN.
  app.get('/production/scrap/floor/waiting', { schema: floorWaitingContract }, async (request) => floorWaiting(request, request.query))

  app.post('/production/scrap/floor/waiting/:scanId/approve', { schema: approveOverLimitContract }, async (request) =>
    floorDecide(request, request.params.scanId, { decision: 'APPROVED', ...(request.body.note ? { note: request.body.note } : {}) }, { stepUp: () => requireFloorStepUp(officeAuthOf(app), request), idempotencyKey: idempotencyKeyFrom(request) }),
  )

  app.post('/production/scrap/floor/waiting/:scanId/refuse', { schema: refuseOverLimitContract }, async (request) =>
    floorDecide(request, request.params.scanId, { decision: 'REFUSED', reason: request.body.reason, ...(request.body.note ? { note: request.body.note } : {}) }, { idempotencyKey: idempotencyKeyFrom(request) }),
  )
})
