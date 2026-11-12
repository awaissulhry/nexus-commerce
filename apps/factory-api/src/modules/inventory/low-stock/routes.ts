import { defineRoutes } from '../../../core/manifest'
import { lowStockContract } from './contract'
import { manifest } from './manifest'
import { lowStockList } from './read'

/** Below the minimum (B-W2b-314; SCM-281): the tile and its list (./read.ts); the LOW_STOCK alert's finder is ./alerts.ts. */
export default defineRoutes('inventory.lowStock', manifest, async (app) => {
  app.get('/inventory/low-stock', { schema: lowStockContract }, async (request) => lowStockList(request, request.query))
})
