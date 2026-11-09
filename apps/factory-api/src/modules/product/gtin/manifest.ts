import { defineManifest } from '../../../core/manifest'

/**
 * GTINs in depth (B-W2b-227; PRD-006): the company's GS1 ranges (read with product.styles.view, kept with
 * product.gtins.manage), GTINs from a range for a style's SKUs (product.gtins.manage; GATE-SPEND), and a brand's own
 * barcodes typed or imported (product.styles.manage, W1's "SKUs and barcodes"). Office only. Handlers check each range and
 * style with can() over its company (`record`).
 */
const view = { audiences: ['office'], permission: 'product.styles.view', scope: 'record' } as const
const gtins = { audiences: ['office'], permission: 'product.gtins.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/gtin-ranges': view,
  'POST /product/gtin-ranges': gtins,
  'PATCH /product/gtin-ranges/:rangeId': gtins,
  'POST /product/gtin-ranges/:rangeId/archive': gtins,
  'POST /product/gtin-ranges/:rangeId/restore': gtins,
  'POST /product/styles/:styleId/gtins/assign': gtins,
  'POST /product/gtins/import': { audiences: ['office'], permission: 'product.styles.manage', scope: 'record' },
})
