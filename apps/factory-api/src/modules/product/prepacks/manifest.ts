import { defineManifest } from '../../../core/manifest'

/**
 * The prepacks' routes (B-W2b-233; design products.styles › Sizes & measurements › "Prepacks"). Office only. Read with the
 * style (product.styles.view); kept with product.prepacks.manage. A prepack belongs to its style's company (a style's) or
 * its scale's (a scale's), each one company or every company of the tenant, so each handler checks it with can()
 * (`record`).
 */
const view = { audiences: ['office'], permission: 'product.styles.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'product.prepacks.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/styles/:styleId/prepacks': view,
  'POST /product/styles/:styleId/prepacks': manage,
  'GET /product/prepacks/:prepackId': view,
  'PATCH /product/prepacks/:prepackId': manage,
  // The section's selection (Owner rule 2026-10-29): several prepacks archived or restored.
  'POST /product/prepacks/status': manage,
})
