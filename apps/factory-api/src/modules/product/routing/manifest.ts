import { defineManifest } from '../../../core/manifest'

/**
 * The routing's routes (A2 SCR-043 "Style › Routing & minutes"). Office only: the floor reads the operations it scans
 * through its work order (B-W1-38, B-W1-42), never these routes. A routing belongs to its style, which belongs to one
 * company or to every company of the tenant, so each handler checks the style's company with can() (`record`).
 */
const view = { audiences: ['office'], permission: 'product.routing.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.routing.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles/:styleId/revisions/:revisionId/routing': view,
  'POST /product/styles/:styleId/revisions/:revisionId/routing/steps': manage,
  'PATCH /product/styles/:styleId/revisions/:revisionId/routing/steps/:stepId': manage,
  'DELETE /product/styles/:styleId/revisions/:revisionId/routing/steps/:stepId': manage,
  'PUT /product/styles/:styleId/revisions/:revisionId/routing/order': manage,
  'POST /product/styles/:styleId/revisions/:revisionId/routing/copy': manage,
  'GET /product/styles/:styleId/routing/compare': view,
})
