import { defineManifest } from '../../../core/manifest'

/**
 * The BOM's routes (A2 SCR-042 "Style › BOM", SCR-046 "Style release & versions"). Office only: the floor reads a BOM
 * through its work order's frozen specification (later steps), never these routes. A BOM belongs to its style, which
 * belongs to one company or to every company of the tenant, so each handler checks the style's company with can()
 * (`record`).
 */
const view = { audiences: ['office'], permission: 'product.bom.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.bom.manage', scope: 'record' } as const
const release = { audiences: ['office'], permission: 'product.bom.release', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles/:styleId/revisions/:revisionId/bom': view,
  'PATCH /product/styles/:styleId/revisions/:revisionId': manage,
  'POST /product/styles/:styleId/revisions/:revisionId/bom/lines': manage,
  'PATCH /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId': manage,
  'DELETE /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId': manage,
  'PUT /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/sizes': manage,
  'PUT /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/colours': manage,
  'POST /product/styles/:styleId/revisions/:revisionId/copy': manage,
  'GET /product/styles/:styleId/bom/compare': view,
  'POST /product/styles/:styleId/revisions/:revisionId/release': release,
  // Abandoning a draft is product.bom.manage; withdrawing the released revision also needs product.bom.release (handler).
  'POST /product/styles/:styleId/revisions/:revisionId/obsolete': manage,
})
