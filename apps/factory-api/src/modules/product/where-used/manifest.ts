import { defineManifest } from '../../../core/manifest'

/**
 * Where a style is used (B-W2b-227; PRD-021): office, product.styles.view over the style's company (`record`); each kind
 * of record only with its own view permission and scope (./where-used.ts).
 */
export const manifest = defineManifest({
  'GET /product/styles/:styleId/where-used': { audiences: ['office'], permission: 'product.styles.view', scope: 'record' },
})
