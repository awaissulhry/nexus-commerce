import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createPickListsContract, issueContract, pickingWorkOrdersContract, pickListContract, pickListSheetsContract, pickListsContract, returnContract, reversePickContract, undoContract } from './contract'
import { issue, returnStock, reversePick, undoIssue } from './issue'
import { manifest } from './manifest'
import { createPickLists, listPickLists, pickListSheets } from './kits'
import { getPickList, pickingWorkOrders } from './picking'

/**
 * Pick and issue to the work order (B-W1-39; SCM-215, SCM-194, SCM-216; A2 SCR-093): the work orders to pick for, a work
 * order's pick list, issue a scanned hide (whole), lot or material, return what it did not use, undo one's own last
 * issue, and the office's reversal of any issue or return. Every write posts through the ledger's postMoves inside one
 * command (./issue.ts); the worker starts a released work order on its first issue (./start.ts).
 */
export default defineRoutes('inventory.issue', manifest, async (app) => {
  app.get('/inventory/picking/work-orders', { schema: pickingWorkOrdersContract }, async (request) => pickingWorkOrders(request, request.query))

  app.get('/inventory/picking/work-orders/:workOrderId', { schema: pickListContract }, async (request) => getPickList(request, request.params.workOrderId))

  app.post('/inventory/picking/work-orders/:workOrderId/issue', { schema: issueContract }, async (request, reply) =>
    reply.code(201).send(await issue(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/inventory/picking/work-orders/:workOrderId/return', { schema: returnContract }, async (request, reply) =>
    reply.code(201).send(await returnStock(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request))),
  )

  app.post('/inventory/picking/issues/:issueId/undo', { schema: undoContract }, async (request, reply) =>
    reply.code(201).send(await undoIssue(request, request.params.issueId, idempotencyKeyFrom(request))),
  )

  app.post('/inventory/picking/moves/:moveId/reverse', { schema: reversePickContract }, async (request, reply) =>
    reply.code(201).send(await reversePick(request, request.params.moveId, request.body, idempotencyKeyFrom(request))),
  )

  // B-W2a-58: Picking & kits (SCR-237) — the pick lists of many work orders, their sheets, and Create pick lists.
  app.get('/inventory/picking/pick-lists', { schema: pickListsContract }, async (request) => listPickLists(request, request.query))

  app.get('/inventory/picking/pick-lists/sheet', { schema: pickListSheetsContract }, async (request) => pickListSheets(request, request.query))

  app.post('/inventory/picking/pick-lists', { schema: createPickListsContract }, async (request, reply) =>
    reply.code(201).send(await createPickLists(request, request.body, idempotencyKeyFrom(request))),
  )
})
