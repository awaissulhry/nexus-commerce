import { defineRoutes } from '../../../core/manifest'
import { glanceContract } from './contract'
import { readGlance } from './glance'
import { manifest } from './manifest'

/** Customer 360 (B-W2b-324): ./glance.ts — the customer at a glance for one company, in one read. */
export default defineRoutes('sales.customer360', manifest, async (app) => {
  app.get('/sales/customer-360/:partyId', { schema: glanceContract }, async (request) => readGlance(request, request.params.partyId, request.query))
})
