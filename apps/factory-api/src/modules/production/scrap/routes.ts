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
})
