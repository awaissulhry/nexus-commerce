import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { dropLineExceptionContract, lineRoutesContract, pickLineRouteContract, putLineExceptionContract } from './contract'
import { dropLineException, pickLineRoute, putLineException, readLineRoutes } from './lines'
import { manifest } from './manifest'

/**
 * owb-pd2 2.4 (S4 products): the route of each order line — read (the order's Production tab, S2's slot RouteOfEachLinePart), a
 * model picked by sales, the production manager's exception and its way back (./lines.ts). `lineRouteFacts` (./facts.ts) is the ONE
 * read S2, S3 and S5 use for a line's route.
 */
export default defineRoutes('product.line-routes', manifest, async (app) => {
  app.get('/sales/orders/:orderId/line-routes', { schema: lineRoutesContract }, async (request) => readLineRoutes(request, request.params.orderId))

  app.put('/sales/orders/:orderId/lines/:lineId/route', { schema: pickLineRouteContract }, async (request) =>
    pickLineRoute(request, request.params.orderId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  )

  app.put('/sales/orders/:orderId/lines/:lineId/route-exception', { schema: putLineExceptionContract }, async (request) =>
    putLineException(request, request.params.orderId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  )

  app.delete('/sales/orders/:orderId/lines/:lineId/route-exception', { schema: dropLineExceptionContract }, async (request) =>
    dropLineException(request, request.params.orderId, request.params.lineId, request.query.version, idempotencyKeyFrom(request)),
  )
})
