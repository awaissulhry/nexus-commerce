import { defineManifest } from '../../../core/manifest'

/**
 * Made-to-measure rules' routes (B-W2b-248; PRD-017, PRD-201 … PRD-204). Office only. A template's rules are the size
 * library's (product.styles.view | manage, as the size scales and points of measure); turning them on or off is the Owner's
 * word (product.mtm.switch, GATE-MTM); the check reads (product.styles.view; a profile's measures also sales.measurements.view,
 * the consumption product.bom.view); marking a BOM line to scale is a part of the revision's BOM (product.bom.manage). A
 * template and a style belong to one company or to every company, so each handler checks the record's company with can().
 */
const view = { audiences: ['office'], permission: 'product.styles.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.styles.manage', scope: 'record' } as const
const toggle = { audiences: ['office'], permission: 'product.mtm.switch', scope: 'record' } as const
const bomManage = { audiences: ['office'], permission: 'product.bom.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/measurement-templates/:templateId/mtm-rules': view,
  'PUT /product/measurement-templates/:templateId/mtm-rules': manage,
  'PUT /product/measurement-templates/:templateId/mtm-rules/switch': toggle,
  // Read only (a POST for its body): the one check of a measurement set.
  'POST /product/made-to-measure/check': view,
  'PUT /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/mtm-scale': bomManage,
})
