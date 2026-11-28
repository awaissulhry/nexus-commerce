import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * The route of each order line (owb-pd2 2.4; S4 settles 2, 3, 5). Office only: the customer never reads a route, the floor follows a
 * line's route through its basket. The order's company and customer are checked by the handler (`record`):
 *   the read     orders.view OR orders.view.own and on the order — ONE permission per manifest entry, so `signed-in` and the
 *                handler asks them (S2's sales/orders/access assertOrdersReader + assertSees, as the order's own reads)
 *   the pick     orders.manage (sales picks a model route)
 *   exception    product.routing.manage — `signed-in` here, so sales is refused by the handler in words (403
 *                ONLY_PRODUCTION_MANAGER "Only the production manager changes the route of one line."), not by a bare 403
 */
const read = { audiences: ['office'], permission: SIGNED_IN, scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/orders/:orderId/line-routes': read,
  'PUT /sales/orders/:orderId/lines/:lineId/route': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'PUT /sales/orders/:orderId/lines/:lineId/route-exception': read,
  'DELETE /sales/orders/:orderId/lines/:lineId/route-exception': read,
})
