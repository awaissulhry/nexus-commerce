import { defineManifest } from '../../../core/manifest'

/**
 * A style's lifecycle (B-W2b-221; PRD-007, PRD-182): read with the style library's product.styles.view, moved with
 * product.styles.lifecycle. Office only. Handlers check each style with can() over its company (`record`).
 */
export const manifest = defineManifest({
  'GET /product/styles/:styleId/lifecycle': { audiences: ['office'], permission: 'product.styles.view', scope: 'record' },
  'POST /product/styles/:styleId/lifecycle': { audiences: ['office'], permission: 'product.styles.lifecycle', scope: 'record' },
  'PUT /product/styles/:styleId/replaced-by': { audiences: ['office'], permission: 'product.styles.lifecycle', scope: 'record' },
})
