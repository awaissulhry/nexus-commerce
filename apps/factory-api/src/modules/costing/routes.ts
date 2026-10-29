import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import {
  archiveRateContract,
  compareCostContract,
  costCellsContract,
  createRateContract,
  getCostSheetContract,
  getSettingsContract,
  listRatesContract,
  saveSettingsContract,
  updateRateContract,
} from './contract'
import { manifest } from './manifest'
import { archiveRate, createRate, getSettings, listRates, saveSettings, updateRate } from './rates'
import { compareCostSheets, costCells, costSheetOf } from './sheets'

/**
 * The style cost sheet (costing module, B-W1-16; A2 SCR-044 "Style › Cost"; features FIN-001, FIN-002, FIN-004,
 * GAP-006, PLT-034): material from the BOM by size at each material's standard purchase price, labour from the routing's
 * standard minutes at the cost per minute of each kind of work centre, overhead; the waterfall, what is missing and the
 * inputs used; two revisions compared; the cells a quote asks for; the labour rates per kind of work centre and the
 * overhead setting they are priced with. Every cost figure is money.cost (the grain filter drops it for a caller
 * without the cost grain, and refuses a body that sends one).
 */
export default defineRoutes('costing', manifest, async (app) => {
  app.get('/costing/styles/:styleId/revisions/:revisionId/cost-sheet', { schema: getCostSheetContract }, async (request) => ({
    sheet: await costSheetOf(request, request.params.styleId, request.params.revisionId, request.query),
  }))

  app.get('/costing/styles/:styleId/cost-sheet/compare', { schema: compareCostContract }, async (request) => ({
    diff: await compareCostSheets(request, request.params.styleId, request.query),
  }))

  app.post('/costing/cells', { schema: costCellsContract }, async (request) => ({
    batch: await costCells(request, request.body),
  }))

  app.get('/costing/rates', { schema: listRatesContract }, async (request) => listRates(request, request.query))

  app.post('/costing/rates', { schema: createRateContract }, async (request, reply) =>
    reply.code(201).send({ rate: await createRate(request, request.body, idempotencyKeyFrom(request)) }),
  )

  app.patch('/costing/rates/:rateId', { schema: updateRateContract }, async (request) => ({
    rate: await updateRate(request, request.params.rateId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/costing/rates/:rateId/archive', { schema: archiveRateContract }, async (request) => ({
    rate: await archiveRate(request, request.params.rateId, request.body, idempotencyKeyFrom(request)),
  }))

  app.get('/costing/settings', { schema: getSettingsContract }, async (request) => ({ settings: await getSettings(request, request.query) }))

  app.put('/costing/settings', { schema: saveSettingsContract }, async (request) => ({
    settings: await saveSettings(request, request.body, idempotencyKeyFrom(request)),
  }))
})
