import { defineManifest } from '../../../core/manifest'

/**
 * Protector placement's routes (B-W2b-233; design products.styles › Sizes & measurements › "Protector placement"). Office
 * only; a part of the style's revision, as its BOM, pattern pieces and measurement spec: product.bom.view | manage. A style
 * belongs to one company or to every company of the tenant, so each handler checks the style's company with can()
 * (`record`).
 */
const view = { audiences: ['office'], permission: 'product.bom.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.bom.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles/:styleId/revisions/:revisionId/protectors': view,
  'POST /product/styles/:styleId/revisions/:revisionId/protectors': manage,
  'PATCH /product/styles/:styleId/revisions/:revisionId/protectors/:placementId': manage,
  // The list's selection (Owner rule 2026-10-29): several placements removed at once.
  'POST /product/styles/:styleId/revisions/:revisionId/protectors/remove': manage,
  'PUT /product/styles/:styleId/revisions/:revisionId/protectors/order': manage,
})
