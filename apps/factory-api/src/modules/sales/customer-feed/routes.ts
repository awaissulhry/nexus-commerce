import { defineRoutes } from '../../../core/manifest'
import { customerFeedContract } from './contract'
import { readCustomerFeed } from './feed'
import { manifest } from './manifest'

/** B-SA-060: ./feed.ts — the customer's conversations merged in one read-only feed ("All of <Customer>"). */
export default defineRoutes('sales.customerFeed', manifest, async (app) => {
  app.get('/sales/customers/:partyId/feed', { schema: customerFeedContract }, async (request) => readCustomerFeed(request, request.params.partyId, request.query))
})
