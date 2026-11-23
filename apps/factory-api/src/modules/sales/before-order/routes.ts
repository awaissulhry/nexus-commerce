import { defineRoutes } from '../../../core/manifest'
import { beforeOrderCountsContract } from './contract'
import { readBeforeOrderCounts } from './counts'
import { manifest } from './manifest'

/** Before an order (B-CQ-002): ./counts.ts — one customer's records before an order, counted per group, in one read. */
export default defineRoutes('sales.beforeOrder', manifest, async (app) => {
  app.get('/sales/before-order/counts', { schema: beforeOrderCountsContract }, async (request) => readBeforeOrderCounts(request, request.query))
})
