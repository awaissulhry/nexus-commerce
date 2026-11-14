import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { atRiskContract, getCutOffsContract, saveCutOffsContract, searchContract, shipTodayContract } from './contract'
import { getCutOffs, saveCutOffs } from './cutoffs'
import { manifest } from './manifest'
import { atRisk, shipToday } from './queue'
import { searchShipments } from './search'

/**
 * The shipment queue in depth (B-W2b-386; LOG-018, LOG-110, LOG-120): what must leave a site today by each carrier's
 * cut-off, what is at risk of missing its promise, the search by any number a shipment carries, and a site's carrier
 * cut-offs.
 */
export default defineRoutes('shipping.queue', manifest, async (app) => {
  app.get('/shipping/queue/today', { schema: shipTodayContract }, async (request) => shipToday(request, request.query))

  app.get('/shipping/queue/at-risk', { schema: atRiskContract }, async (request) => atRisk(request, request.query))

  app.get('/shipping/queue/search', { schema: searchContract }, async (request) => searchShipments(request, request.query))

  app.get('/shipping/sites/:siteId/cut-offs', { schema: getCutOffsContract }, async (request) => getCutOffs(request, request.params.siteId))

  app.put('/shipping/sites/:siteId/cut-offs', { schema: saveCutOffsContract }, async (request) => saveCutOffs(request, request.params.siteId, request.body, idempotencyKeyFrom(request)))
})
