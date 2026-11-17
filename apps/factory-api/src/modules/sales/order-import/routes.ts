import { defineRoutes } from '../../../core/manifest'
import { rememberedMappingContract } from './contract'
import { manifest } from './manifest'
import { rememberedMapping } from './mapping-memory'

/** B-TH-101 (threads plan TH-9): order import remembers a customer's columns. */
export default defineRoutes('sales.order-import', manifest, async (app) => {
  app.get('/sales/order-import/:importId/remembered-mapping', { schema: rememberedMappingContract }, async (request) => rememberedMapping(request, request.params.importId, request.query.partyId))
})
