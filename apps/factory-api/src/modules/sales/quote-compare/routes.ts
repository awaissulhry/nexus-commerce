import { defineRoutes } from '../../../core/manifest'
import { compareVersions } from './compare'
import { compareVersionsContract } from './contract'
import { manifest } from './manifest'

/** Two versions of a quote compared (B-W2b-302; SAL-158): lines, sizes, prices and terms added, removed and changed. */
export default defineRoutes('sales.quoteCompare', manifest, async (app) => {
  app.get('/sales/quotes/:quoteId/versions/compare', { schema: compareVersionsContract }, async (request) => compareVersions(request, request.params.quoteId, request.query))
})
