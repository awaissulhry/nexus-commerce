import { defineRoutes } from '../../../core/manifest'
import { whereUsedContract } from './contract'
import { manifest } from './manifest'
import { whereUsed } from './where-used'

/** Where a style is used (B-W2b-227; PRD-021): quotes, orders, work orders, stock, price lists, sample rounds, certificates. */
export default defineRoutes('product.where-used', manifest, async (app) => {
  app.get('/product/styles/:styleId/where-used', { schema: whereUsedContract }, async (request) => ({ whereUsed: await whereUsed(request, request.params.styleId) }))
})
