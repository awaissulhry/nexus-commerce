import { defineManifest } from '../../../core/manifest'

/**
 * The product settings (B-W2b-221; PRD-105, PRD-182; design products.settings): read with product.styles.view, changed with
 * product.settings.manage. Office only. A company's row is checked with can() over the company; the tenant-wide row needs a
 * grant over every company to change (`record`).
 */
export const manifest = defineManifest({
  'GET /product/settings': { audiences: ['office'], permission: 'product.styles.view', scope: 'record' },
  'PUT /product/settings': { audiences: ['office'], permission: 'product.settings.manage', scope: 'record' },
})
