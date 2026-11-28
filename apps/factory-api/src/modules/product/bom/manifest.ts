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
// owb-pd1 1.4 (S4 settle 6): product.bom.manage, OR product.drafts.edit on a DRAFT revision — the route asks the read right (every
// holder of the manage right holds it) and the handler the write (modules/product/drafts/may-edit.ts).
const draft = view

export const manifest = defineManifest({
  'GET /product/styles/:styleId/revisions/:revisionId/bom': view,
  'PATCH /product/styles/:styleId/revisions/:revisionId': manage,
  'POST /product/styles/:styleId/revisions/:revisionId/bom/lines': draft,
  'PATCH /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId': draft,
  'DELETE /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId': draft,
  'PUT /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/sizes': draft,
  'PUT /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/colours': draft,
  'POST /product/styles/:styleId/revisions/:revisionId/copy': draft,
  'GET /product/styles/:styleId/bom/compare': view,
  // W2a (PRD-090): one revision's BOM as CSV / XLSX (the import's columns) or PDF; the import is the imports routes'.
  'GET /product/styles/:styleId/revisions/:revisionId/bom/export': view,
  'POST /product/styles/:styleId/revisions/:revisionId/release': release,
  // Abandoning a draft is product.bom.manage; withdrawing the released revision also needs product.bom.release (handler).
  'POST /product/styles/:styleId/revisions/:revisionId/obsolete': manage,
})
