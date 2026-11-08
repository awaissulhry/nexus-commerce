import { defineRoutes } from '../../../core/manifest'
import { cuttingBoard } from './board'
import { boardContract, workOrderLeatherContract, yieldReportContract } from './contract'
import { workOrderLeather } from './leather'
import { manifest } from './manifest'
import { yieldReport } from './yield'

/**
 * The cutting room board and the cutting and yield report (B-W2b-130; MES-163 "Cutting room board", MES-302 "Cutting and yield
 * report"; design production.floor "Cutting room", production.reports "Cutting and yield", production.workorders › Leather "W2b one
 * shade lot rule"). Reads only: nothing is written, so no command and no event; the screens re-read on the cutting room's events
 * (cut_order.changed, cut_ticket.changed, lay.changed, cut_consumption.changed, cut_order.reconciled, production.cut_logged).
 */
export default defineRoutes('production.cutboard', manifest, async (app) => {
  app.get('/production/cutboard', { schema: boardContract }, async (request) => cuttingBoard(request, request.query))
  app.get('/production/cutboard/yield', { schema: yieldReportContract }, async (request) => yieldReport(request, request.query))
  app.get('/production/cutboard/work-orders/:workOrderId/leather', { schema: workOrderLeatherContract }, async (request) => workOrderLeather(request, request.params.workOrderId))
})
