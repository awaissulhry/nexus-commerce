import { defineManifest } from '../../../core/manifest'

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

export const manifest = defineManifest({
  'GET /product/points-of-measure': libraryView,
  'POST /product/points-of-measure': libraryManage,
  'GET /product/points-of-measure/:pomId': libraryView,
  'PATCH /product/points-of-measure/:pomId': libraryManage,
  // The list's selection (Owner rule 2026-10-29): several points archived or restored.
  'POST /product/points-of-measure/status': libraryManage,
  'POST /product/points-of-measure/:pomId/picture': libraryManage,
  'POST /product/points-of-measure/:pomId/picture/:fileId/complete': libraryManage,
  'GET /product/points-of-measure/:pomId/picture': libraryView,
  'DELETE /product/points-of-measure/:pomId/picture': libraryManage,
  // B-W2b-283 (FU1:03): the measurement templates, listed for pickers (./templates.ts).
  'GET /product/measurement-templates': libraryView,
  'GET /product/styles/:styleId/revisions/:revisionId/measurement-spec': specView,
  'POST /product/styles/:styleId/revisions/:revisionId/measurement-spec': specManage,
  'PATCH /product/styles/:styleId/revisions/:revisionId/measurement-spec': specManage,
  'PUT /product/styles/:styleId/revisions/:revisionId/measurement-spec/cells': specManage,
  'POST /product/styles/:styleId/revisions/:revisionId/measurement-spec/points': specManage,
  'POST /product/styles/:styleId/revisions/:revisionId/measurement-spec/points/remove': specManage,
  'PUT /product/styles/:styleId/revisions/:revisionId/measurement-spec/points/order': specManage,
  'POST /product/styles/:styleId/revisions/:revisionId/measurement-spec/approve': specRelease,
  'POST /product/styles/:styleId/revisions/:revisionId/measurement-spec/reopen': specRelease,
  'POST /product/styles/:styleId/revisions/:revisionId/measurement-spec/archive': specManage,
})
