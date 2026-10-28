import { defineRoutes } from '../../../core/manifest'
import { overviewContract, reconcileContract, stockCardContract } from './contract'
import { manifest } from './manifest'
import { reconcile, stockCardOf, stockOverview } from './stock'

/**
 * The stock overview (B-W1-22; SCM-190, SCM-258, SCM-280: on hand, held and available per location, item, colour, lot
 * and hide, values with the cost grain), the stock card of an item (SCM-191) and the ledger check the golden flow's end
 * check calls (PLAN §4.7 "the stock ledger reconciles").
 */
export default defineRoutes('inventory.stock', manifest, async (app) => {
  app.get('/inventory/stock', { schema: overviewContract }, async (request) => stockOverview(request, request.query))
  app.get('/inventory/stock/card', { schema: stockCardContract }, async (request) => stockCardOf(request, request.query))
  app.get('/inventory/stock/reconciliation', { schema: reconcileContract }, async (request) => reconcile(request, request.query))
})
