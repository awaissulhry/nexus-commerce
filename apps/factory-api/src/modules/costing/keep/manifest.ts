import { defineManifest } from '../../../core/manifest'

/**
 * owb-pd3 (S4 settle 9; design plan § 5zh "Keep"): the cost now kept as a product's standard cost. Office only. The handler checks
 * costing.view over the style's company (the brand wall), costing.sheets.manage over it and the cost grain; approving alone also
 * asks costing.sheets.approve and the company's own switch "one person may keep a cost".
 */
export const manifest = defineManifest({
  'POST /costing/styles/:styleId/revisions/:revisionId/keep': { audiences: ['office'], permission: 'costing.sheets.manage', scope: 'record' },
})
