import { defineRoutes } from '../../../core/manifest'
import { cr6Contract, expiriesContract, gapsContract, kpisContract, registerContract } from './contract'
import { manifest } from './manifest'
import { cr6Answer, expiriesAnswer, gapsAnswer, kpisAnswer, registerAnswer } from './reads'

/**
 * Compliance reports (B-W2b-272; ANA-025; design compliance.reports SCR-261): certificate coverage of styles and markets and
 * the main gaps, the open gaps by type, the 12-month expiry calendar, chromium VI results per supplier against the limit and
 * the register summary, read from what the earlier compliance steps recorded (the status board's matrix, gate refusals,
 * certificates, supplier declarations, lots and lab results, the PPE register with its recalls and authority requests). Office
 * only, read only: nothing here writes, so there is no command, audit row or event.
 */
export default defineRoutes('compliance.reports', manifest, async (app) => {
  app.get('/compliance/reports/kpis', { schema: kpisContract }, async (request) => kpisAnswer(request, request.query))
  app.get('/compliance/reports/gaps', { schema: gapsContract }, async (request) => gapsAnswer(request, request.query))
  app.get('/compliance/reports/expiries', { schema: expiriesContract }, async (request) => expiriesAnswer(request, request.query))
  app.get('/compliance/reports/cr6', { schema: cr6Contract }, async (request) => cr6Answer(request, request.query))
  app.get('/compliance/reports/register', { schema: registerContract }, async (request) => registerAnswer(request, request.query))
})
