import { defineManifest } from '../../../core/manifest'

/**
 * A style's texts per language and its private label (B-W2b-227; PRD-019, PRD-010): read with the style library's
 * product.styles.view, written with product.styles.manage. Office only. Handlers check each style with can() over its
 * company (`record`).
 */
const view = { audiences: ['office'], permission: 'product.styles.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.styles.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles/:styleId/texts': view,
  'PUT /product/styles/:styleId/texts/:language': manage,
  'POST /product/styles/:styleId/texts/:language/remove': manage,
  'GET /product/styles/:styleId/private-label': view,
  'PUT /product/styles/:styleId/private-label': manage,
})
