import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createSeasonContract, getSeasonContract, listSeasonsContract, moveSeasonContract, setOrderSeasonContract, setQuoteSeasonContract, updateSeasonContract } from './contract'
import { manifest } from './manifest'
import { createSeason, getSeason, listSeasons, moveSeason, setOrderSeason, setQuoteSeason, updateSeason } from './seasons'

/** Seasons per company (B-W2b-303; SAL-277): ./seasons.ts. */
export default defineRoutes('sales.seasons', manifest, async (app) => {
  app.get('/sales/seasons', { schema: listSeasonsContract }, async (request) => listSeasons(request, request.query))
  app.get('/sales/seasons/:seasonId', { schema: getSeasonContract }, async (request) => getSeason(request, request.params.seasonId))
  app.post('/sales/seasons', { schema: createSeasonContract }, async (request, reply) => reply.code(201).send(await createSeason(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/sales/seasons/:seasonId', { schema: updateSeasonContract }, async (request) => updateSeason(request, request.params.seasonId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/seasons/:seasonId/close', { schema: moveSeasonContract }, async (request) => moveSeason(request, request.params.seasonId, 'CLOSED', request.body, idempotencyKeyFrom(request)))
  app.post('/sales/seasons/:seasonId/reopen', { schema: moveSeasonContract }, async (request) => moveSeason(request, request.params.seasonId, 'OPEN', request.body, idempotencyKeyFrom(request)))
  app.put('/sales/quotes/:quoteId/season', { schema: setQuoteSeasonContract }, async (request) => setQuoteSeason(request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))
  app.put('/sales/orders/:orderId/season', { schema: setOrderSeasonContract }, async (request) => setOrderSeason(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))
})
