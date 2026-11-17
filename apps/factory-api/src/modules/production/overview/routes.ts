import { defineRoutes } from '../../../core/manifest'
import { overviewContract } from './contract'
import { manifest } from './manifest'
import { productionOverview } from './read'

/**
 * B-PR-33 — Production › Overview, the office's all-customers read (./read): waiting on us, the customer, a supplier, a workshop;
 * late and at risk; blocked by a hold, the customer, material, a gate, or a split it needs; WIP by stage in pieces; the customers'
 * open requests by kind and the ones the reader answers in Home › Approvals; one row per customer, the mixed ones made before the
 * rule, and the Total; Most urgent paged with its count; `?supervisor=me` for "Only mine". Read only.
 */
export default defineRoutes('production.overview', manifest, async (app) => {
  app.get('/production/overview', { schema: overviewContract }, async (request) => productionOverview(request, request.query))
})
