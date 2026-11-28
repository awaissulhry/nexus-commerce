import { defineManifest } from '../../../core/manifest'

/**
 * The model and customer routes of a style revision and the routes of other products (owb-pd2 2.3; design § 5u, § 5w). Office only:
 * the floor follows a line's route through its basket, never these routes; the customer never reads a route. Read with
 * product.routing.view, changed with product.routing.manage (the production manager: S4 settle 5); the style's company and brand
 * are checked by the handler (`record`).
 */
const view = { audiences: ['office'], permission: 'product.routing.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.routing.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles/:styleId/revisions/:revisionId/routes': view,
  'POST /product/styles/:styleId/revisions/:revisionId/routes': manage,
  'PUT /product/styles/:styleId/revisions/:revisionId/routes/:routeId': manage,
  'DELETE /product/styles/:styleId/revisions/:revisionId/routes/:routeId': manage,
  'GET /product/route-sources': view,
})
