import { defineRoutes } from '../../../core/manifest'
import { overviewContract, reconcileContract, stockCardContract } from './contract'
import { hideRecord, listHides } from './hides'
import { explainFigure, ledgerCounts, ledgerMove, readLedger } from './ledger-read'
import { listStockLots, stockLotRecord } from './lots'
import { manifest } from './manifest'
import { explainContract, hideRecordContract, ledgerContract, ledgerCountsContract, ledgerMoveContract, listHidesContract, listStockLotsContract, stockLotRecordContract } from './reads-contract'
import { reconcile, stockCardOf, stockOverview } from './stock'

/**
 * The stock overview (B-W1-22; SCM-190, SCM-258, SCM-280: on hand, held and available per location, item, colour, lot
 * and hide, values with the cost grain), the stock card of an item (SCM-191) and the ledger check the golden flow's end
 * check calls (PLAN §4.7 "the stock ledger reconciles"); the warehouse screens' reads: Hides, Lots & traceability, the
 * Movements grid and "why is it this number" (read only).
 */
export default defineRoutes('inventory.stock', manifest, async (app) => {
  app.get('/inventory/stock', { schema: overviewContract }, async (request) => stockOverview(request, request.query))
  app.get('/inventory/stock/card', { schema: stockCardContract }, async (request) => stockCardOf(request, request.query))
  app.get('/inventory/stock/reconciliation', { schema: reconcileContract }, async (request) => reconcile(request, request.query))
  app.get('/inventory/stock/explain', { schema: explainContract }, async (request) => explainFigure(request, request.query))
  app.get('/inventory/hides', { schema: listHidesContract }, async (request) => listHides(request, request.query))
  app.get('/inventory/hides/:hideId', { schema: hideRecordContract }, async (request) => hideRecord(request, request.params.hideId))
  app.get('/inventory/lots', { schema: listStockLotsContract }, async (request) => listStockLots(request, request.query))
  app.get('/inventory/lots/:lotId', { schema: stockLotRecordContract }, async (request) => stockLotRecord(request, request.params.lotId))
  app.get('/inventory/ledger', { schema: ledgerContract }, async (request) => readLedger(request, request.query))
  app.get('/inventory/ledger/counts', { schema: ledgerCountsContract }, async (request) => ledgerCounts(request, request.query))
  app.get('/inventory/ledger/:moveId', { schema: ledgerMoveContract }, async (request) => ledgerMove(request, request.params.moveId))
})
