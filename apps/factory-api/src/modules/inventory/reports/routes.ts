import { defineRoutes } from '../../../core/manifest'
import { ageingContract, leatherContract } from './contract'
import { manifest } from './manifest'
import { ageingAnswer, leatherAnswer } from './reads'

/**
 * Warehouse reports (B-W2b-356; design warehouse.reports SCR-257): stock ageing by material type (what lies in stock at the end
 * of the period, by age bucket) and leather use by article and supplier lot (received, cut, back as remnant, scrapped, on hand),
 * read from the stock ledger. Office only, read only: nothing here writes, so there is no command, audit row or event.
 */
export default defineRoutes('inventory.reports', manifest, async (app) => {
  app.get('/inventory/reports/ageing', { schema: ageingContract }, async (request) => ageingAnswer(request, request.query))
  app.get('/inventory/reports/leather', { schema: leatherContract }, async (request) => leatherAnswer(request, request.query))
})
