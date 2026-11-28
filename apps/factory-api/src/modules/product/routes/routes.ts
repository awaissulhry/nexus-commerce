import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createStyleRouteContract, deleteStyleRouteContract, listStyleRoutesContract, routeSourcesContract, updateStyleRouteContract } from './contract'
import { manifest } from './manifest'
import { routeSources } from './sources'
import { createStyleRoute, deleteStyleRoute, listStyleRoutes, updateStyleRoute } from './style-routes'

/**
 * owb-pd2 2.3 (S4 products): the model and customer routes of a style revision (StyleRoute), and the routes of other products for
 * "Start from a copy". The revision's own routing is modules/product/routing; the ready-made routes modules/product/route-templates.
 */
export default defineRoutes('product.routes', manifest, async (app) => {
  app.get('/product/styles/:styleId/revisions/:revisionId/routes', { schema: listStyleRoutesContract }, async (request) => ({
    routes: await listStyleRoutes(request, request.params.styleId, request.params.revisionId),
  }))

  app.post('/product/styles/:styleId/revisions/:revisionId/routes', { schema: createStyleRouteContract }, async (request, reply) =>
    reply.code(201).send({ route: await createStyleRoute(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)) }),
  )

  app.put('/product/styles/:styleId/revisions/:revisionId/routes/:routeId', { schema: updateStyleRouteContract }, async (request) => ({
    route: await updateStyleRoute(request, request.params.styleId, request.params.revisionId, request.params.routeId, request.body, idempotencyKeyFrom(request)),
  }))

  app.delete('/product/styles/:styleId/revisions/:revisionId/routes/:routeId', { schema: deleteStyleRouteContract }, async (request) => ({
    routes: await deleteStyleRoute(request, request.params.styleId, request.params.revisionId, request.params.routeId, request.query.version, idempotencyKeyFrom(request)),
  }))

  app.get('/product/route-sources', { schema: routeSourcesContract }, async (request) => ({ products: await routeSources(request, request.query.q) }))
})
