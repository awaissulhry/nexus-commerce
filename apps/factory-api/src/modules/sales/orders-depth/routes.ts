import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { processFiles } from '../../../platform/files/service'
import { approvalState, askAgain, withdrawApproval } from './approval'
import { getConfirmation, makeConfirmation, sendConfirmation } from './confirmation'
import {
  approvalStateContract,
  askApprovalContract,
  getConfirmationContract,
  makeConfirmationContract,
  orderDepthContract,
  ordersDepthContract,
  sendConfirmationContract,
  setPrioritiesContract,
  setPriorityContract,
  splitContract,
  withdrawApprovalContract,
} from './contract'
import { orderDepth, ordersDepth } from './depth'
import { manifest } from './manifest'
import { setPriorities, setPriority } from './priority'
import { splitOrder } from './split'

/**
 * Orders in depth (B-W2b-303): ./depth.ts (the record's and the list's W2b facts), ./priority.ts (priority and the urgent
 * flag), ./split.ts (several orders from one), ./approval.ts (an order waiting for a yes), ./confirmation.ts (the order
 * confirmation PDF and its mail). Seasons are modules/sales/seasons; the sheet import modules/sales/order-import.
 */
export default defineRoutes('sales.orders-depth', manifest, async (app) => {
  app.get('/sales/orders/depth', { schema: ordersDepthContract }, async (request) => ordersDepth(request, request.query))
  app.get('/sales/orders/:orderId/depth', { schema: orderDepthContract }, async (request) => orderDepth(request, request.params.orderId))
  app.put('/sales/orders/:orderId/priority', { schema: setPriorityContract }, async (request) => setPriority(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/orders/priority', { schema: setPrioritiesContract }, async (request) => setPriorities(request, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/orders/:orderId/split', { schema: splitContract }, async (request, reply) => reply.code(201).send(await splitOrder(request, request.params.orderId, request.body, idempotencyKeyFrom(request))))
  app.get('/sales/orders/:orderId/approval', { schema: approvalStateContract }, async (request) => approvalState(request, request.params.orderId))
  app.post('/sales/orders/:orderId/approval', { schema: askApprovalContract }, async (request, reply) => reply.code(201).send(await askAgain(request, request.params.orderId, request.body, idempotencyKeyFrom(request))))
  app.post('/sales/orders/:orderId/approval/withdraw', { schema: withdrawApprovalContract }, async (request) => withdrawApproval(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))
  app.get('/sales/orders/:orderId/confirmation', { schema: getConfirmationContract }, async (request) => getConfirmation(request, request.params.orderId))
  app.post('/sales/orders/:orderId/confirmation', { schema: makeConfirmationContract }, async (request, reply) => reply.code(201).send(await makeConfirmation(processFiles(), request, request.params.orderId, request.body, idempotencyKeyFrom(request))))
  app.post('/sales/orders/:orderId/confirmation/send', { schema: sendConfirmationContract }, async (request, reply) => reply.code(201).send(await sendConfirmation(processFiles(), request, request.params.orderId, request.body, idempotencyKeyFrom(request))))
})
