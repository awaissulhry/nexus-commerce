import { defineRoutes } from '../../../core/manifest'
import { whyIsItThisNumber } from './bridge'
import { whyContract } from './contract'
import { manifest } from './manifest'

/** The balance bridge of a stock figure (B-W2b-314; SCM-191): ./bridge.ts. */
export default defineRoutes('inventory.why', manifest, async (app) => {
  app.get('/inventory/why', { schema: whyContract }, async (request) => whyIsItThisNumber(request, request.query))
})
