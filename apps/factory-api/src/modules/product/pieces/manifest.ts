import { defineManifest } from '../../../core/manifest'

/**
 * The pattern pieces' routes (B-W2b-95; SCR-271 "Style › Files & patterns", section Pattern pieces). Office only: the
 * cutting table reads a piece's minimum grade through its own floor route (B-W2b-103), never these. The pieces are a part
 * of the revision like its BOM lines, so the BOM's permissions decide (product.bom.view | manage); a style belongs to one
 * company or to every company of the tenant, so each handler checks the style's company with can() (`record`).
 */
const view = { audiences: ['office'], permission: 'product.bom.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.bom.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles/:styleId/revisions/:revisionId/pieces': view,
  'POST /product/styles/:styleId/revisions/:revisionId/pieces': manage,
  'PATCH /product/styles/:styleId/revisions/:revisionId/pieces/:pieceId': manage,
  'DELETE /product/styles/:styleId/revisions/:revisionId/pieces/:pieceId': manage,
  'PUT /product/styles/:styleId/revisions/:revisionId/pieces/order': manage,
  // The list's selection (Owner rule 2026-10-29: bulk actions on selected rows): several removed, or one change to several.
  'POST /product/styles/:styleId/revisions/:revisionId/pieces/remove': manage,
  'POST /product/styles/:styleId/revisions/:revisionId/pieces/change': manage,
})
