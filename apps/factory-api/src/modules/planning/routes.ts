import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { explainContract, latestPlanContract, listRunsContract, reopenContract, runPlanContract, runPlanViewContract, setAsideContract, unusableStockContract } from './contract'
import { manifest } from './manifest'
import { explainLine, latestPlan, listRuns, planOfRun, reopen, setAside, unusableStock } from './requirements'
import { runPlan } from './run'

/**
 * What to buy and make (B-W1-29; PLN-062 to PLN-066; A2 SCR-055, design 02): run the plan for a site, read the latest
 * plan (or one run) with its tiles and lines, explain a line, set lines aside and open them again, and list the stock
 * the plan may not use. Turning a line into a purchase order line is purchasing's (B-W1-30), through ./hooks.
 */
export default defineRoutes('planning', manifest, async (app) => {
  app.post('/planning/runs', { schema: runPlanContract }, async (request, reply) => reply.code(201).send(await runPlan(request, request.body, idempotencyKeyFrom(request))))
  app.get('/planning/runs', { schema: listRunsContract }, async (request) => listRuns(request, request.query))
  app.get('/planning/runs/latest', { schema: latestPlanContract }, async (request) => latestPlan(request, request.query))
  app.get('/planning/runs/:runId', { schema: runPlanViewContract }, async (request) => planOfRun(request, request.params.runId, request.query))
  app.get('/planning/requirements/:requirementId', { schema: explainContract }, async (request) => explainLine(request, request.params.requirementId))
  app.post('/planning/requirements/set-aside', { schema: setAsideContract }, async (request) => setAside(request, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/requirements/reopen', { schema: reopenContract }, async (request) => reopen(request, request.body, idempotencyKeyFrom(request)))
  app.get('/planning/unusable-stock', { schema: unusableStockContract }, async (request) => unusableStock(request, request.query))
})
