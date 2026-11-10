import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  addLineContract,
  approverOptionsContract,
  approversContract,
  cancelContract,
  createOrderContract,
  createRequestContract,
  decideContract,
  draftRevisionContract,
  floorPhotoCompleteContract,
  floorPhotoContract,
  floorRequestContract,
  listOrdersContract,
  listRequestsContract,
  moveRequestContract,
  orderRequestsContract,
  readOrderContract,
  readRequestContract,
  releaseContract,
  releasedContract,
  removeLineContract,
  submitContract,
  updateLineContract,
  updateOrderContract,
  updateRequestContract,
  workInProgressContract,
  workOrderChangesContract,
} from './contract'
import { announceFloorPhoto, completeFloorPhoto, reportFromFloor } from './floor'
import { manifest } from './manifest'
import {
  addLine,
  cancelOrder,
  createOrder,
  decideOrder,
  listOrders,
  readOrder,
  releaseOrder,
  removeLine,
  setApprovers,
  setOrderRequests,
  setWorkInProgress,
  startDraftRevision,
  submitOrder,
  updateLine,
  updateOrder,
} from './orders'
import { createRequest, listRequests, moveRequest, readRequest, updateRequest, workOrderChanges } from './requests'
import { approverOptions, listReleased } from './screens'

/**
 * Change requests and change orders (B-W2b-226): ./requests.ts (the office's requests), ./floor.ts (the floor's spec problem
 * with a photo), ./orders.ts (change orders), ./hooks.ts (the seams in W1's revision copy and release), ./notices.ts (who is
 * told). The floor's queue applies ./floor.ts through platform/floor-sync (kind product.change.report).
 */
export default defineRoutes('product.changes', manifest, async (app) => {
  app.get('/product/change-requests', { schema: listRequestsContract }, async (request) => listRequests(request, request.query))
  app.get('/product/change-requests/:changeRequestId', { schema: readRequestContract }, async (request) => ({ changeRequest: await readRequest(request, request.params.changeRequestId) }))
  app.post('/product/change-requests', { schema: createRequestContract }, async (request, reply) => reply.code(201).send({ changeRequest: await createRequest(request, request.body, idempotencyKeyFrom(request)) }))
  app.patch('/product/change-requests/:changeRequestId', { schema: updateRequestContract }, async (request) => ({ changeRequest: await updateRequest(request, request.params.changeRequestId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/change-requests/:changeRequestId/move', { schema: moveRequestContract }, async (request) => ({ changeRequest: await moveRequest(request, request.params.changeRequestId, request.body, idempotencyKeyFrom(request)) }))
  app.get('/product/change-requests/work-orders/:workOrderId', { schema: workOrderChangesContract }, async (request) => workOrderChanges(request, request.params.workOrderId))

  app.post('/product/floor/change-requests', { schema: floorRequestContract }, async (request, reply) => reply.code(201).send(await reportFromFloor(request, request.body)))
  app.post('/product/floor/change-requests/:changeRequestId/photos', { schema: floorPhotoContract }, async (request, reply) =>
    reply.code(201).send(await announceFloorPhoto(request, request.params.changeRequestId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/product/floor/change-requests/:changeRequestId/photos/:fileId/complete', { schema: floorPhotoCompleteContract }, async (request) =>
    completeFloorPhoto(request, request.params.changeRequestId, request.params.fileId, idempotencyKeyFrom(request)),
  )

  app.get('/product/change-orders', { schema: listOrdersContract }, async (request) => listOrders(request, request.query))
  app.get('/product/change-orders/:changeOrderId', { schema: readOrderContract }, async (request) => ({ changeOrder: await readOrder(request, request.params.changeOrderId) }))
  app.post('/product/change-orders', { schema: createOrderContract }, async (request, reply) => reply.code(201).send({ changeOrder: await createOrder(request, request.body, idempotencyKeyFrom(request)) }))
  app.patch('/product/change-orders/:changeOrderId', { schema: updateOrderContract }, async (request) => ({ changeOrder: await updateOrder(request, request.params.changeOrderId, request.body, idempotencyKeyFrom(request)) }))
  app.put('/product/change-orders/:changeOrderId/requests', { schema: orderRequestsContract }, async (request) => ({ changeOrder: await setOrderRequests(request, request.params.changeOrderId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/change-orders/:changeOrderId/lines', { schema: addLineContract }, async (request) => ({ changeOrder: await addLine(request, request.params.changeOrderId, request.body, idempotencyKeyFrom(request)) }))
  app.patch('/product/change-orders/:changeOrderId/lines/:lineId', { schema: updateLineContract }, async (request) => ({
    changeOrder: await updateLine(request, request.params.changeOrderId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  }))
  app.delete('/product/change-orders/:changeOrderId/lines/:lineId', { schema: removeLineContract }, async (request) => ({
    changeOrder: await removeLine(request, request.params.changeOrderId, request.params.lineId, request.query.version, idempotencyKeyFrom(request)),
  }))
  app.put('/product/change-orders/:changeOrderId/work-in-progress', { schema: workInProgressContract }, async (request) => ({ changeOrder: await setWorkInProgress(request, request.params.changeOrderId, request.body, idempotencyKeyFrom(request)) }))
  app.put('/product/change-orders/:changeOrderId/approvers', { schema: approversContract }, async (request) => ({ changeOrder: await setApprovers(request, request.params.changeOrderId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/change-orders/:changeOrderId/draft-revision', { schema: draftRevisionContract }, async (request) => ({ changeOrder: await startDraftRevision(request, request.params.changeOrderId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/change-orders/:changeOrderId/submit', { schema: submitContract }, async (request) => ({ changeOrder: await submitOrder(request, request.params.changeOrderId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/change-orders/:changeOrderId/decide', { schema: decideContract }, async (request) => ({ changeOrder: await decideOrder(request, request.params.changeOrderId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/change-orders/:changeOrderId/cancel', { schema: cancelContract }, async (request) => ({ changeOrder: await cancelOrder(request, request.params.changeOrderId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/product/change-orders/:changeOrderId/release', { schema: releaseContract }, async (request) => ({ changeOrder: await releaseOrder(request, request.params.changeOrderId, request.body, idempotencyKeyFrom(request)) }))
  // B-W2b-244 (Changes & versions, SCR-117): the released versions list and the approver picker (./screens.ts).
  app.get('/product/released-versions', { schema: releasedContract }, async (request) => listReleased(request, request.query))
  app.get('/product/change-orders/:changeOrderId/approver-options', { schema: approverOptionsContract }, async (request) => approverOptions(request, request.params.changeOrderId))
})
