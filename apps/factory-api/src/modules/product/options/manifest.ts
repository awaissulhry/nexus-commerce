import { defineManifest } from '../../../core/manifest'

/**
 * Options and configuration rules (B-W2b-229; PRD-081, PRD-206, PRD-207, PRD-208, PRD-211; design products.options, SCR-114).
 * Office only. Reading the library, a style's offers and the configuration check is product.styles.view; the library's writes
 * product.options.manage, an option's price surcharge product.options.price (with money.price); a style's offers
 * product.styles.manage (its spec, under its edit rule); a draft BOM line's option product.bom.manage. Every handler checks the
 * group's or the style's company with can() (`record`).
 */
const view = { audiences: ['office'], permission: 'product.styles.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.options.manage', scope: 'record' } as const
const price = { audiences: ['office'], permission: 'product.options.price', scope: 'record' } as const
const styles = { audiences: ['office'], permission: 'product.styles.manage', scope: 'record' } as const
const bom = { audiences: ['office'], permission: 'product.bom.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/option-groups': view,
  'GET /product/option-groups/:groupId': view,
  'POST /product/option-groups': manage,
  'PATCH /product/option-groups/:groupId': manage,
  'POST /product/option-groups/:groupId/archive': manage,
  'POST /product/option-groups/:groupId/restore': manage,
  'POST /product/option-groups/:groupId/values': manage,
  'PATCH /product/option-groups/:groupId/values/:valueId': manage,
  'POST /product/option-groups/:groupId/values/:valueId/archive': manage,
  'POST /product/option-groups/:groupId/values/:valueId/restore': manage,
  'PUT /product/option-groups/:groupId/rules': manage,
  'POST /product/option-groups/:groupId/values/:valueId/effects': manage,
  'PATCH /product/option-groups/:groupId/values/:valueId/effects/:effectId': manage,
  'DELETE /product/option-groups/:groupId/values/:valueId/effects/:effectId': manage,
  'PUT /product/option-groups/:groupId/values/:valueId/price': price,
  'GET /product/styles/:styleId/options': view,
  'PUT /product/styles/:styleId/options/:groupId': styles,
  'POST /product/styles/:styleId/options/:groupId/withdraw': styles,
  'POST /product/styles/:styleId/options/check': view,
  'PUT /product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/option': bom,
  // B-W2b-374 (XF3:05): what a chosen value of the group takes with it.
  'GET /product/option-groups/:groupId/takes': view,
  'PUT /product/option-groups/:groupId/takes': manage,
})
