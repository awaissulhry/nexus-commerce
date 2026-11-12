import { defineManifest } from '../../../core/manifest'

/**
 * The markets a style is sold in (B-W2b-283, FU1:01; design products.styles rec:Style › Overview "Markets"): read with the
 * style library's product.styles.view, set with product.styles.manage. Office only. Handlers check the style with can()
 * over its company (`record`).
 */
export const manifest = defineManifest({
  'GET /product/styles/:styleId/markets': { audiences: ['office'], permission: 'product.styles.view', scope: 'record' },
  'PUT /product/styles/:styleId/markets': { audiences: ['office'], permission: 'product.styles.manage', scope: 'record' },
})
