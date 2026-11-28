import { defineManifest } from '../../../core/manifest'

/**
 * owb-pd3 (S4; design plan § 5zh "Price against cost"): a product's agreed prices against its cost. Office only (A1 §2.6: the floor,
 * partner and link sessions never see a cost). The handler checks costing.view over the style's company (and the brand wall),
 * then the price, the cost and the margin grains (403 in words otherwise), and reads the CUSTOMER price lists the person may see
 * (pricelists.view through scopeWhere).
 */
export const manifest = defineManifest({
  'GET /costing/styles/:styleId/price-against-cost': { audiences: ['office'], permission: 'costing.view', scope: 'record' },
})
