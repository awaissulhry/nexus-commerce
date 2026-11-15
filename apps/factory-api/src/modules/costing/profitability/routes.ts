import { defineRoutes } from '../../../core/manifest'
import { orderDocumentsContract } from './contract'
import { orderDocuments } from './documents'
import { manifest } from './manifest'

/**
 * The order profitability report with every document (B-W2b-416; FIN-053; design finance.margins pop:order "Documents (W2b):
 * invoices, credit notes, cost entries, freight, payments — each a link"). Reads only.
 */
export default defineRoutes('costing.profitability', manifest, async (app) => {
  app.get('/costing/margins/orders/:orderId/documents', { schema: orderDocumentsContract }, async (request) => orderDocuments(request, request.params.orderId))
})
