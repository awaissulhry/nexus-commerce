import { defineRoutes } from '../../../core/manifest'
import { listFinishedContract } from './contract'
import { manifest } from './manifest'
import { listFinished } from './read'

/**
 * Finished goods (B-W2a-12; GAP-003, MES-011): the finished garments a site holds per SKU, place and batch. They come in
 * from a work order's "Report finished to stock" (modules/production/completion, which posts through ./post).
 */
export default defineRoutes('inventory.finished', manifest, async (app) => {
  app.get('/inventory/finished', { schema: listFinishedContract }, async (request) => listFinished(request, request.query))
})
