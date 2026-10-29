import { defineRoutes } from '../../core/manifest'
import { compareCostContract, costCellsContract, getCostSheetContract } from './contract'
import { manifest } from './manifest'
import { compareCostSheets, costCells, costSheetOf } from './sheets'

/**
 * The style cost sheet (costing module, B-W1-16; A2 SCR-044 "Style › Cost"; features FIN-001, FIN-002, FIN-004,
 * GAP-006, PLT-034): material from the BOM by size at each material's standard purchase price, labour from the routing's
 * standard minutes at the cost per minute of each kind of work centre, overhead; the waterfall, what is missing and the
 * inputs used; two revisions compared; the cells a quote asks for. Every cost figure is money.cost (the grain filter
 * drops it for a caller without the cost grain).
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
})
