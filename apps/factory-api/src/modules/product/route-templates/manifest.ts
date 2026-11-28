import { defineManifest } from '../../../core/manifest'

/**
 * The factory's ready-made routes (owb-pd2 2.3; design § 5w "Start from a copy", "Save as ready-made…"). Office only. Read with
 * product.routing.view, kept with product.routing.manage (the production manager); a ready-made route of the whole factory is kept by
 * a grant over every company (the handler, `record`).
 */
const view = { audiences: ['office'], permission: 'product.routing.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.routing.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/route-templates': view,
  'POST /product/route-templates': manage,
  'PATCH /product/route-templates/:templateId': manage,
  'POST /product/route-templates/:templateId/close': manage,
  'POST /product/route-templates/:templateId/open': manage,
})
