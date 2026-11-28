import { defineRoutes } from '../../../core/manifest'
import { catalogueSizesContract } from './contract'
import { manifest } from './manifest'
import { catalogueSizes } from './sizes'

/**
 * owb-pd4s s.3 (S4 products; design § 5q "Customer"): the product's Sizes for its customer — the size table of the newest released
 * revision, how to measure each point, the protectors and the main picture. Its own module beside the catalogue's (as
 * compliance/textile-rules serves the fibres at /portal/catalogue/:styleId/composition); the reach is the catalogue's own check.
 */
export default defineRoutes('product.portal-sizes', manifest, async (app) => {
  app.get('/portal/catalogue/:styleId/sizes', { schema: catalogueSizesContract }, async (request) => catalogueSizes(app, request, request.params.styleId))
})
