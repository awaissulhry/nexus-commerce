import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import {
  addLineContract,
  cancelContract,
  createOrderContract,
  documentsContract,
  draftFromPlanContract,
  editLineContract,
  getOrderContract,
  listOrdersContract,
  removeLineContract,
  sendCheckContract,
  sendContract,
  sendLinkContract,
  supplierViewContract,
  undoDraftContract,
  updateOrderContract,
} from './contract'
import { listDocuments } from './documents'
import { draftFromPlan, undoDraftFromPlan } from './from-plan'
import { addLine, editLine, removeLine } from './lines'
import { manifest } from './manifest'
import { cancelOrder, createOrder, getOrder, listOrders, updateOrder } from './orders'
import { sendCheck, sendNewLink, sendOrder } from './send'
import { previewSupplierView } from './supplier-view'

/**
 * Purchase orders, part 1 (B-W1-30): the list ("Where POs stand") and the record, a new draft, its header, its lines (with
 * the leather specs), "Draft PO" from the plan's lines to buy and its Undo, the send (PDF, one-off confirm link, mail on
 * the order's thread), a new link, the cancellation, the documents and sends, and the office's preview of what the
 * supplier sees (no price). The supplier's answer through the link is B-W1-31; receipts against the order B-W1-32.
 */
export default defineRoutes('purchasing', manifest, async (app) => {
  app.get('/purchasing/orders', { schema: listOrdersContract }, async (request) => listOrders(request, request.query))

  app.get('/purchasing/orders/:purchaseOrderId', { schema: getOrderContract }, async (request) => getOrder(request, request.params.purchaseOrderId))

  app.post('/purchasing/orders', { schema: createOrderContract }, async (request, reply) => reply.code(201).send(await createOrder(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/purchasing/orders/:purchaseOrderId', { schema: updateOrderContract }, async (request) => updateOrder(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/orders/:purchaseOrderId/lines', { schema: addLineContract }, async (request, reply) => reply.code(201).send(await addLine(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request))))

  app.patch('/purchasing/orders/:purchaseOrderId/lines/:lineId', { schema: editLineContract }, async (request) => editLine(request, request.params.purchaseOrderId, request.params.lineId, request.body, idempotencyKeyFrom(request)))

  app.delete('/purchasing/orders/:purchaseOrderId/lines/:lineId', { schema: removeLineContract }, async (request) => removeLine(request, request.params.purchaseOrderId, request.params.lineId, request.query, idempotencyKeyFrom(request)))

  app.post('/purchasing/from-plan', { schema: draftFromPlanContract }, async (request) => draftFromPlan(request, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/from-plan/undo', { schema: undoDraftContract }, async (request) => undoDraftFromPlan(request, request.body, idempotencyKeyFrom(request)))

  app.get('/purchasing/orders/:purchaseOrderId/send-check', { schema: sendCheckContract }, async (request) => sendCheck(request, request.params.purchaseOrderId))

  app.post('/purchasing/orders/:purchaseOrderId/send', { schema: sendContract }, async (request) => sendOrder(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/orders/:purchaseOrderId/send-link', { schema: sendLinkContract }, async (request) => sendNewLink(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/orders/:purchaseOrderId/cancel', { schema: cancelContract }, async (request) => cancelOrder(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))

  app.get('/purchasing/orders/:purchaseOrderId/documents', { schema: documentsContract }, async (request) => listDocuments(request, request.params.purchaseOrderId))

  app.get('/purchasing/orders/:purchaseOrderId/supplier-view', { schema: supplierViewContract }, async (request) => previewSupplierView(request, request.params.purchaseOrderId))
})
