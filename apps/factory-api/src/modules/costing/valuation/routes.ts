import { defineRoutes } from '../../../core/manifest'
import { layersContract, leatherContract, valuationContract } from './contract'
import { manifest } from './manifest'
import { leatherByArea, valuationLayers } from './reads'
import { stockValuation } from './valuation'

/**
 * Stock valuation at any date (B-W2a-29; FIN-039; design finance.reports "Stock valuation", its pop-up "How this lot is
 * valued" and its print tab), and value by hide area (SCM-256; warehouse.hides "Leather dashboard", area value). Reads
 * only: the values are the stock ledger's (StockValuation) and the work orders' cost ledger, as of the end of a day.
 */
export default defineRoutes('costing.valuation', manifest, async (app) => {
  app.get('/costing/valuation', { schema: valuationContract }, async (request) => stockValuation(request, request.query))

  app.get('/costing/valuation/layers', { schema: layersContract }, async (request) => valuationLayers(request, request.query))

  app.get('/costing/valuation/leather', { schema: leatherContract }, async (request) => leatherByArea(request, request.query))
})
