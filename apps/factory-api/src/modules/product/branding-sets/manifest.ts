import { defineManifest } from '../../../core/manifest'

/**
 * The branding sets of private-label customers (B-W2b-247; PRD-045; design products.colours sec:colours.branding,
 * pop:colours.branding). Office only. Read with product.styles.view (a style's labels and tech pack read its brand's set),
 * kept with product.branding.manage. A set belongs to one company and one brand: each handler checks both with can()
 * (`record`). Its files are sent through the files platform (files.upload) as files of the set.
 */
const view = { audiences: ['office'], permission: 'product.styles.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.branding.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/branding-sets': view,
  // New branding set: the customers and brands it may be for.
  'GET /product/branding-sets/brands': manage,
  'GET /product/branding-sets/:setId': view,
  'POST /product/branding-sets': manage,
  'PATCH /product/branding-sets/:setId': manage,
  'POST /product/branding-sets/:setId/files': manage,
  'POST /product/branding-sets/:setId/archive': manage,
  'POST /product/branding-sets/:setId/restore': manage,
})
