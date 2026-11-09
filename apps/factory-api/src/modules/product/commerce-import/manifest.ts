import { defineManifest } from '../../../core/manifest'

/**
 * Start a style from a Nexus Commerce product (B-W2b-209; PRD-265; design products.styles: New style › "Nexus Commerce
 * product" and the header's Import). Office only. The export file itself goes through the imports routes (`POST
 * /imports` with importer `product.commerceStyles`); these two read what the screen needs around it: the sources (the
 * file on, the live read OFF with its reason) and the styles a job started. No route reads or writes Commerce.
 */
const view = { audiences: ['office'], permission: 'product.styles.view', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/commerce-import': view,
  'GET /product/commerce-import/jobs/:jobId': view,
})
