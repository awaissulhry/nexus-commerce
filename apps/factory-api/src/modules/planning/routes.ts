import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { explainContract, latestPlanContract, listRunsContract, reopenContract, runPlanContract, runPlanViewContract, setAsideContract, unusableStockContract } from './contract'
import { manifest } from './manifest'
import { explainLine, latestPlan, listRuns, planOfRun, reopen, setAside, unusableStock } from './requirements'
import { runPlan } from './run'
// B-W2a-16: planning settings and capacity (./settings, ./capacity).
import { capacity, capacityCell } from './capacity/capacity'
import { capacityCellContract, capacityContract } from './capacity/contract'
import {
  createItemParametersContract,
  deleteItemParametersContract,
  editItemParametersContract,
  editLineCapacityContract,
  editSettingsContract,
  editWorkCentreCapacityContract,
  getItemParametersContract,
  getSettingsContract,
  lanesContract,
  listItemParametersContract,
  listSettingsContract,
  reorderRulesContract,
} from './settings/contract'
import { createItemParameters, deleteItemParameters, editItemParameters, getItemParameters, listItemParameters, reorderRules } from './settings/items'
import { editLineCapacity, editWorkCentreCapacity, listLanes } from './settings/lanes'
import { editSettings, getSettings, listSettings } from './settings/settings'

/**
 * What to buy and make (B-W1-29; PLN-062 to PLN-066; A2 SCR-055, design 02): run the plan for a site, read the latest
 * plan (or one run) with its tiles and lines, explain a line, set lines aside and open them again, and list the stock
 * the plan may not use. Turning a line into a purchase order line is purchasing's (B-W1-30), through ./hooks.
 *
 * B-W2a-16 (PLN-003, PLN-005, PLN-014, PLN-099, PLN-115, PLN-116; design planning.settings and planning.capacity): a
 * site's planning settings (horizon, buckets, default efficiency, nightly run time), its item parameters and reorder
 * rules, its lanes' planned efficiency and people, and Capacity & load (available against booked standard minutes per
 * lane and bucket, and the orders behind a cell). The route folder has its own routes file, so the parts' routes are
 * listed here (as purchasing lists ./confirm's).
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

  // ---- B-W2a-16: planning settings and capacity --------------------------------------------------------------------
  app.get('/planning/settings', { schema: listSettingsContract }, async (request) => listSettings(request, request.query))
  app.get('/planning/settings/:siteId', { schema: getSettingsContract }, async (request) => getSettings(request, request.params.siteId))
  app.patch('/planning/settings/:siteId', { schema: editSettingsContract }, async (request) => editSettings(request, request.params.siteId, request.body, idempotencyKeyFrom(request)))
  app.get('/planning/item-parameters', { schema: listItemParametersContract }, async (request) => listItemParameters(request, request.query))
  app.post('/planning/item-parameters', { schema: createItemParametersContract }, async (request, reply) => reply.code(201).send(await createItemParameters(request, request.body, idempotencyKeyFrom(request))))
  app.get('/planning/item-parameters/:itemPlanningId', { schema: getItemParametersContract }, async (request) => getItemParameters(request, request.params.itemPlanningId))
  app.patch('/planning/item-parameters/:itemPlanningId', { schema: editItemParametersContract }, async (request) => editItemParameters(request, request.params.itemPlanningId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/item-parameters/:itemPlanningId/delete', { schema: deleteItemParametersContract }, async (request) => deleteItemParameters(request, request.params.itemPlanningId, request.body, idempotencyKeyFrom(request)))
  app.get('/planning/reorder-rules', { schema: reorderRulesContract }, async (request) => reorderRules(request, request.query.siteId))
  app.get('/planning/lanes', { schema: lanesContract }, async (request) => listLanes(request, request.query.siteId))
  app.patch('/planning/lines/:lineId/capacity', { schema: editLineCapacityContract }, async (request) => editLineCapacity(request, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.patch('/planning/work-centres/:workCentreId/capacity', { schema: editWorkCentreCapacityContract }, async (request) => editWorkCentreCapacity(request, request.params.workCentreId, request.body, idempotencyKeyFrom(request)))
  app.get('/planning/capacity', { schema: capacityContract }, async (request) => capacity(request, request.query))
  app.get('/planning/capacity/cell', { schema: capacityCellContract }, async (request) => capacityCell(request, request.query))
})
