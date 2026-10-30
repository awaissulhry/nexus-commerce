import { RENEW_ANSWER } from '@nexus/factory-domain/purchasing/confirm/renew'
import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { AUTH_RATE_LIMITS, officeAuthOf } from '../../platform/auth/sessions/office-auth'
import { processEmail } from '../../platform/email-out/service'
import { confirmByLink, declineByLink } from './confirm/answer'
import {
  acceptProposalContract,
  announceConfirmationContract,
  completeConfirmationContract,
  confirmLinkOrderContract,
  declineLinkOrderContract,
  openLinkOrderContract,
  orderAnswerContract,
  refuseProposalContract,
  renewLinkOrderContract,
} from './confirm/contract'
import { acceptProposal, refuseProposal } from './confirm/decide'
import { orderAnswer } from './confirm/office'
import { linkView } from './confirm/read'
import { linkTokenOf, renewConfirmLink } from './confirm/renew'
import { announceConfirmation, completeConfirmation } from './confirm/upload'
import {
  addLineContract,
  cancelContract,
  createOrderContract,
  documentsContract,
  draftFromPlanContract,
  editLineContract,
  getOrderContract,
  listOrdersContract,
  previewContract,
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
import { inlineDisposition, previewOrderPdf, sendCheck, sendNewLink, sendOrder } from './send'
import { previewSupplierView } from './supplier-view'

/**
 * Purchase orders, part 1 (B-W1-30): the list ("Where POs stand") and the record, a new draft, its header, its lines (with
 * the leather specs), "Draft PO" from the plan's lines to buy and its Undo, the send (PDF, one-off confirm link, mail on
 * the order's thread), a new link, the cancellation, the documents and sends, and the office's preview of what the
 * supplier sees (no price). Receipts against the order are B-W1-32's.
 *
 * B-W1-31, the supplier's answer (./confirm): office GET …/answer (where the answer stands, asked against proposed and
 * confirmed per line, the link evidence), POST …/proposal/accept | refuse (the buyer decides on the supplier's changes,
 * purchasing.send); the PO_CONFIRM link: GET /link/purchase-order (the order, price-free), POST
 * /link/purchase-order/confirm (all as asked, or line by line) | decline, and the public POST /link/purchase-order/renew
 * ("ask for a new link": one answer whatever the token; a new link only to the address on file). Link routes are rate
 * limited like every link route.
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

  app.get('/purchasing/orders/:purchaseOrderId/preview', { schema: previewContract }, async (request, reply) => {
    const { pdf, fileName } = await previewOrderPdf(request, request.params.purchaseOrderId, request.query.language)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.get('/purchasing/orders/:purchaseOrderId/send-check', { schema: sendCheckContract }, async (request) => sendCheck(request, request.params.purchaseOrderId))

  app.post('/purchasing/orders/:purchaseOrderId/send', { schema: sendContract }, async (request) => sendOrder(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/orders/:purchaseOrderId/send-link', { schema: sendLinkContract }, async (request) => sendNewLink(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/orders/:purchaseOrderId/cancel', { schema: cancelContract }, async (request) => cancelOrder(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))

  app.get('/purchasing/orders/:purchaseOrderId/documents', { schema: documentsContract }, async (request) => listDocuments(request, request.params.purchaseOrderId))

  app.get('/purchasing/orders/:purchaseOrderId/supplier-view', { schema: supplierViewContract }, async (request) => previewSupplierView(request, request.params.purchaseOrderId))

  app.get('/purchasing/orders/:purchaseOrderId/answer', { schema: orderAnswerContract }, async (request) => orderAnswer(request, request.params.purchaseOrderId))

  app.post('/purchasing/orders/:purchaseOrderId/proposal/accept', { schema: acceptProposalContract }, async (request) => acceptProposal(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/orders/:purchaseOrderId/proposal/refuse', { schema: refuseProposalContract }, async (request) => refuseProposal(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))

  const linkUse = app.officeAuth?.rateLimits.linkUse ?? AUTH_RATE_LIMITS.linkUse
  const limited = { rateLimit: { max: linkUse.max, timeWindow: linkUse.timeWindowMs } }

  app.get('/link/purchase-order', { schema: openLinkOrderContract, config: limited }, async (request) => linkView(request))

  app.post('/link/purchase-order/confirm', { schema: confirmLinkOrderContract, config: limited }, async (request) => confirmByLink(request, request.body))

  app.post('/link/purchase-order/decline', { schema: declineLinkOrderContract, config: limited }, async (request) => declineByLink(request, request.body))

  app.post('/link/purchase-order/confirmation', { schema: announceConfirmationContract, config: limited }, async (request, reply) => reply.code(201).send(await announceConfirmation(request, request.body)))

  app.post('/link/purchase-order/confirmation/:fileId/complete', { schema: completeConfirmationContract, config: limited }, async (request) => completeConfirmation(request, request.params.fileId))

  app.post('/link/purchase-order/renew', { schema: renewLinkOrderContract, config: limited }, async (request, reply) => {
    const auth = officeAuthOf(app)
    const token = linkTokenOf(request)
    // The work runs after the answer: neither what it says nor when it comes tells anything about the token.
    auth.afterAnswer(async () => {
      const outcome = await renewConfirmLink(processEmail(), request, token)
      request.log.info({ outcome }, 'a new confirm link was asked for')
    }, request.log)
    return reply.code(202).send({ status: 'requested' as const, message: RENEW_ANSWER })
  })
})
