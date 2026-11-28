import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Protector placement's routes (B-W2b-233; design products.styles › Sizes & measurements › "Protector placement"). Office
 * only; a part of the style's revision, as its BOM, pattern pieces and measurement spec: product.bom.view | manage. A style
 * belongs to one company or to every company of the tenant, so each handler checks the style's company with can()
 * (`record`).
 */
const view = { audiences: ['office'], permission: 'product.bom.view', scope: 'record' } as const
// owb-pd1 1.4 (S4 settle 6): product.bom.manage, OR product.drafts.edit on a DRAFT revision — the route asks the read right (every
// holder of the manage right holds it) and the handler the write (./placements.ts writer, modules/product/drafts/may-edit.ts).
const manage = view
// owb-pd4s s.2 (design § 5q "Who": Sales reads the Sizes tab): the placement reads with product.bom.view OR product.styles.view —
// the route asks a signed-in office person and the handler the right (../bom/store readRevisionForSizes). No money in it.
const read = { audiences: ['office'], permission: SIGNED_IN, scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles/:styleId/revisions/:revisionId/protectors': read, // owb-pd4s s.2
  'POST /product/styles/:styleId/revisions/:revisionId/protectors': manage,
  'PATCH /product/styles/:styleId/revisions/:revisionId/protectors/:placementId': manage,
  // The list's selection (Owner rule 2026-10-29): several placements removed at once.
  'POST /product/styles/:styleId/revisions/:revisionId/protectors/remove': manage,
  'PUT /product/styles/:styleId/revisions/:revisionId/protectors/order': manage,
})
