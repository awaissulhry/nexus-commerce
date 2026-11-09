import { defineRoutes } from '../../../core/manifest'
import { commerceImportContract, startedStylesContract } from './contract'
import { manifest } from './manifest'
import { commerceImport, startedStyles } from './read'

/**
 * Start a style from a Nexus Commerce product (B-W2b-209; PRD-265): the sources and the styles a job started. The
 * importer itself is `./importer` (registered in platform/imports/registry.ts).
 */
export default defineRoutes('product.commerce-import', manifest, async (app) => {
  app.get('/product/commerce-import', { schema: commerceImportContract }, async () => ({ commerceImport: commerceImport() }))

  app.get('/product/commerce-import/jobs/:jobId', { schema: startedStylesContract }, async (request) => startedStyles(request, request.params.jobId))
})
