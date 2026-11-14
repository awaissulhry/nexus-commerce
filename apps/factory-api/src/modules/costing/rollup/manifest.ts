import { defineManifest } from '../../../core/manifest'

/**
 * The multi-level cost roll-up (B-W2b-423; FIN-019, KS4:02; design products.styles › Materials (BOM) › "Sub-assemblies" cost
 * column, Cost tab). Office only: the floor, partner and link sessions never see a cost (A1 §2.6). Read with costing.view over
 * the style's company (a tenant-wide style: over the company asked for), checked in the handler (`record`).
 */
const view = { audiences: ['office'], permission: 'costing.view', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /costing/styles/:styleId/revisions/:revisionId/rollup': view,
})
