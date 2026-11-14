import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { closeCheckContract, closesContract, reopenContract, scrapReworkContract, undoContract } from './contract'
import { manifest } from './manifest'
import { closeCheck, scrapReworkCost, workOrderCloses } from './reads'
import { reopenWorkOrder, undoClose } from './take-back'

/**
 * The work order close (B-W2b-411; MES-012, MES-013, FIN-029, FIN-030, FIN-034): what the close dialog shows before the
 * close, the closer's Undo for a few seconds and a later reopen with a reason, the closes with their variance split, and
 * the cost of scrap and rework per reason. The close is POST /production/work-orders/:workOrderId/close
 * (modules/production/work-orders/close.ts). A repeated Idempotency-Key answers from its receipt.
 */
export default defineRoutes('costing.close', manifest, async (app) => {
  app.get('/production/work-orders/:workOrderId/close-check', { schema: closeCheckContract }, async (request) => closeCheck(request, request.params.workOrderId))

  app.post('/production/work-orders/:workOrderId/close/undo', { schema: undoContract }, async (request) => undoClose(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request)))

  app.post('/production/work-orders/:workOrderId/reopen', { schema: reopenContract }, async (request) => reopenWorkOrder(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request)))

  app.get('/costing/work-orders/:workOrderId/close', { schema: closesContract }, async (request) => workOrderCloses(request, request.params.workOrderId))

  app.get('/costing/work-orders/:workOrderId/scrap-rework', { schema: scrapReworkContract }, async (request) => scrapReworkCost(request, request.params.workOrderId))
})
