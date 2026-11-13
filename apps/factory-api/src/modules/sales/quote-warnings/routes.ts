import { defineRoutes } from '../../../core/manifest'
import { warningsContract } from './contract'
import { manifest } from './manifest'
import { quoteWarnings } from './warnings'

/**
 * The quote's Warnings section (B-W2b-294; SAL-147; follow-ups QT1:01, QT1:02): what could stop the deal before anyone sends it,
 * from the line rules (modules/sales/line-checks, the same for orders) and the quote's own checks.
 */
export default defineRoutes('sales.quoteWarnings', manifest, async (app) => {
  app.get('/sales/quotes/:quoteId/warnings', { schema: warningsContract }, async (request) => quoteWarnings(request, request.params.quoteId))
})
