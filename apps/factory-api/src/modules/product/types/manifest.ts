import { defineManifest } from '../../../core/manifest'

/**
 * Product types (B-W2b-221; PRD-008; design products.settings psettings.types): read with the style library's
 * product.styles.view, kept with product.settings.manage; a style's type is a field of the style (product.styles.manage).
 * Office only. Handlers check each type and style with can() over its company (`record`).
 */
const view = { audiences: ['office'], permission: 'product.styles.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.settings.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/types': view,
  'GET /product/types/:typeId': view,
  'POST /product/types': manage,
  'PATCH /product/types/:typeId': manage,
  'POST /product/types/:typeId/archive': manage,
  'POST /product/types/:typeId/restore': manage,
  'GET /product/styles/:styleId/type': view,
  'PUT /product/styles/:styleId/type': { audiences: ['office'], permission: 'product.styles.manage', scope: 'record' },
})
