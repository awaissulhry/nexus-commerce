import { defineRoutes } from '../../../core/manifest'
import { compareContract, incomingContract, kpisContract, trendContract } from './contract'
import { manifest } from './manifest'
import { compareAnswer, incomingAnswer, kpisAnswer, trendAnswer } from './reads'

/**
 * Quality reports (B-W2b-138; QHS-147; design quality.reports SCR-147): the headline numbers, the trend per week, the
 * comparison by line, operation, supplier and style, and incoming quality per supplier, read from what the earlier quality
 * steps signed. Office only, read only: nothing here writes, so there is no command, audit row or event. Never per worker.
 */
export default defineRoutes('quality.reports', manifest, async (app) => {
  app.get('/quality/reports/kpis', { schema: kpisContract }, async (request) => kpisAnswer(request, request.query))
  app.get('/quality/reports/trend', { schema: trendContract }, async (request) => trendAnswer(request, request.query))
  app.get('/quality/reports/compare', { schema: compareContract }, async (request) => compareAnswer(request, request.query))
  app.get('/quality/reports/incoming', { schema: incomingContract }, async (request) => incomingAnswer(request, request.query))
})
