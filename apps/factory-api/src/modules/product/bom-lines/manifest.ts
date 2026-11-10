import { defineManifest } from '../../../core/manifest'

/**
 * The routes of BOM lines in depth (B-W2b-228; PRD-083, PRD-084, PRD-099, PRD-108; design style.bom.lines "Alternates (W2b)",
 * "Customer-supplied (W2b)", styles.bomLine "Alternates (W2b)"). Office only: the floor reads a BOM through its work order's
 * frozen specification. Alternates, the customer, the workshop mark and the output are parts of the revision's BOM, so the
 * BOM's permissions decide (product.bom.view | manage); a style belongs to one company or to every company of the tenant, so
 * each handler checks the style's company with can() (`record`).
 */
const view = { audiences: ['office'], permission: 'product.bom.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.bom.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles/:styleId/revisions/:revisionId/bom/depth': view,
  'POST /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/alternates': manage,
  'PATCH /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/alternates/:alternateId': manage,
  'DELETE /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/alternates/:alternateId': manage,
  'PUT /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/alternate-order': manage,
  'PUT /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/supply': manage,
  // The list's selection (Owner rule 2026-10-29: bulk actions on selected rows): several lines' customer or workshop mark at once.
  'POST /product/styles/:styleId/revisions/:revisionId/bom/supply/change': manage,
  'PUT /product/styles/:styleId/revisions/:revisionId/bom/output': manage,
})
