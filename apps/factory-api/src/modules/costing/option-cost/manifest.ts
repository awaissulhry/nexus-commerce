import { defineManifest } from '../../../core/manifest'

/**
 * An option's own cost (B-W2b-423; FIN-018, KS4:01; design products.options › Price & BOM effects "Cost delta (cost)"). Office
 * only: the floor, partner and link sessions never see a cost (A1 §2.6), and the floor's grant leaves OptionValue.materialDelta
 * out. Reads costing.view over the style's or the group's company; a value's typed delta costing.sheets.manage over the group's
 * company (a tenant-wide group: a grant over every company), with the cost grain; checked in the handler (`record`).
 */
const view = { audiences: ['office'], permission: 'costing.view', scope: 'record' } as const
const sheets = { audiences: ['office'], permission: 'costing.sheets.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /costing/styles/:styleId/option-costs': view,
  'GET /costing/option-groups/:groupId/costs': view,
  'PUT /costing/option-groups/:groupId/values/:valueId/cost': sheets,
})
