import { defineManifest } from '../../../core/manifest'

/**
 * The BOM structure's routes (B-W2b-223; PRD-077, PRD-078, PRD-087, PRD-106; design style.bom: the Section column and group
 * rows, the Sub-assemblies tree, the BOM check). Office only: the floor reads a BOM through its work order's frozen
 * specification. The structure is a part of the revision's BOM, so the BOM's permissions decide (product.bom.view |
 * manage); a style belongs to one company or to every company of the tenant, so each handler checks the style's company
 * with can() (`record`). Releasing is W1's route (product.bom.release), which reads the same check.
 */
const view = { audiences: ['office'], permission: 'product.bom.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.bom.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles/:styleId/revisions/:revisionId/bom/structure': view,
  'GET /product/styles/:styleId/revisions/:revisionId/bom/check': view,
  'GET /product/styles/:styleId/revisions/:revisionId/bom/explosion': view,
  'PUT /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/structure': manage,
  // The list's selection (Owner rule 2026-10-29: bulk actions on selected rows): several lines filed or grouped at once.
  'POST /product/styles/:styleId/revisions/:revisionId/bom/structure/change': manage,
  // "Made once, used in several jackets": the revisions of other styles that take this style as a sub-assembly.
  'GET /product/styles/:styleId/used-in': view,
})
