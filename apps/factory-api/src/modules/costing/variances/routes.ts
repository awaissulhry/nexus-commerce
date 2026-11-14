import { defineRoutes } from '../../../core/manifest'
import { variancesContract } from './contract'
import { manifest } from './manifest'
import { listVariances } from './reads'

/**
 * The variances per work order (B-W2b-411; FIN-030): the variance lines of the closes across work orders, newest close
 * first, with their totals per currency and category. One work order's closes are GET /costing/work-orders/:id/close
 * (modules/costing/close).
 */
export default defineRoutes('costing.variances', manifest, async (app) => {
  app.get('/costing/variances', { schema: variancesContract }, async (request) => listVariances(request, request.query))
})
