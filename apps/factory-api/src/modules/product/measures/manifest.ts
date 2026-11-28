import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * The points of measure and the measurement spec's routes (B-W2b-224; design products.sizes "Points of measure",
 * products.styles › Sizes & measurements › "Measurement spec"). Office only. The library as the size scales
 * (product.styles.view | manage); the spec as a part of the revision (product.bom.view | manage; approve and reopen
 * product.bom.release). A point and a style belong to one company or to every company of the tenant, so each handler
 * checks the record's company with can() (`record`).
 */
const libraryView = { audiences: ['office'], permission: 'product.styles.view', scope: 'record' } as const
const libraryManage = { audiences: ['office'], permission: 'product.styles.manage', scope: 'record' } as const
const specView = { audiences: ['office'], permission: 'product.bom.view', scope: 'record' } as const
const specManage = { audiences: ['office'], permission: 'product.bom.manage', scope: 'record' } as const
const specRelease = { audiences: ['office'], permission: 'product.bom.release', scope: 'record' } as const
// owb-pd1 1.4 (S4 settle 6): the size table of a DRAFT revision and a point's how-to words are the designer's too (product.drafts.edit)
// — the route asks the read right (every holder of the manage right holds it) and the handler the write (modules/product/drafts).
const specDraft = specView
const libraryHowTo = libraryView
// owb-pd4s s.2 (S4 products; design § 5q "Who": Sales reads the Sizes tab): the size table (and its points' how-to words) reads with
// product.bom.view OR product.styles.view over the style — one right per manifest entry, so the route asks a signed-in office
// person and the handler the right (../bom/store readRevisionForSizes: neither held 403, the style outside both 404). No money.
const specRead = { audiences: ['office'], permission: SIGNED_IN, scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/points-of-measure': libraryView,
  'POST /product/points-of-measure': libraryManage,
  'GET /product/points-of-measure/:pomId': libraryView,
  'PATCH /product/points-of-measure/:pomId': libraryHowTo,
  // The list's selection (Owner rule 2026-10-29): several points archived or restored.
  'POST /product/points-of-measure/status': libraryManage,
  'POST /product/points-of-measure/:pomId/picture': libraryManage,
  'POST /product/points-of-measure/:pomId/picture/:fileId/complete': libraryManage,
  'GET /product/points-of-measure/:pomId/picture': libraryView,
  'DELETE /product/points-of-measure/:pomId/picture': libraryManage,
  // B-W2b-283 (FU1:03): the measurement templates, listed for pickers (./templates.ts).
  'GET /product/measurement-templates': libraryView,
  // B-W2b-358 (B-W1-17): the template page and its writes (./templates-write.ts).
  'GET /product/measurement-templates/:templateId': libraryView,
  'POST /product/measurement-templates': libraryManage,
  'PATCH /product/measurement-templates/:templateId': libraryManage,
  'PUT /product/measurement-templates/:templateId/points': libraryManage,
  'POST /product/measurement-templates/:templateId/archive': libraryManage,
  'POST /product/measurement-templates/:templateId/restore': libraryManage,
  'GET /product/styles/:styleId/revisions/:revisionId/measurement-spec': specRead, // owb-pd4s s.2
  'POST /product/styles/:styleId/revisions/:revisionId/measurement-spec': specDraft,
  'PATCH /product/styles/:styleId/revisions/:revisionId/measurement-spec': specDraft,
  'PUT /product/styles/:styleId/revisions/:revisionId/measurement-spec/cells': specDraft,
  'POST /product/styles/:styleId/revisions/:revisionId/measurement-spec/points': specDraft,
  'POST /product/styles/:styleId/revisions/:revisionId/measurement-spec/points/remove': specDraft,
  'PUT /product/styles/:styleId/revisions/:revisionId/measurement-spec/points/order': specDraft,
  'POST /product/styles/:styleId/revisions/:revisionId/measurement-spec/approve': specRelease,
  'POST /product/styles/:styleId/revisions/:revisionId/measurement-spec/reopen': specRelease,
  'POST /product/styles/:styleId/revisions/:revisionId/measurement-spec/archive': specManage,
})
