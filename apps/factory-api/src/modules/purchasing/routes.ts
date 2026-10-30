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
  counterProposalContract,
} from './confirm/contract'
import { counterPropose } from './confirm/counter'
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
  // B-W2a-52: changes after the send, expected deliveries, Send n, reminders.
  cancelLinesContract,
  changeContract,
  closeShortContract,
  dueRemindersContract,
  expectedContract,
  moveConfirmByContract,
  reachContract,
  remindContract,
  remindersContract,
  revisionsContract,
  sendChecksContract,
  sendManyContract,
} from './contract'
import { listDocuments } from './documents'
import { draftFromPlan, undoDraftFromPlan } from './from-plan'
import { addLine, editLine, removeLine } from './lines'
import { manifest } from './manifest'
import { cancelOrder, createOrder, expectedDeliveries, getOrder, listOrders, updateOrder } from './orders'
import { inlineDisposition, previewOrderPdf, sendCheck, sendChecksOf, sendMany, sendNewLink, sendOrder } from './send'
import { changeOrder } from './revisions/change'
import { cancelLines, closeShort, reachOfAction } from './revisions/ending'
import { listRevisions } from './revisions/read'
import { dueReminders } from './reminders/daily'
import { moveConfirmBy, orderReminders } from './reminders/deadline'
import { remindSupplier } from './reminders/remind'
import { previewSupplierView } from './supplier-view'
import { convertRequestsContract, getRequestContract, listRequestsContract, previewConversionContract, requestCountsContract } from './requests/contract'
import { convertRequests, previewConversion } from './requests/convert'
import { getRequest, listRequests, requestCounts } from './requests/queue'
import { archiveSourceContract, createSourceContract, getSourceContract, listSourcesContract, restoreSourceContract, updateSourceContract } from './supplier-items/contract'
import { archiveSource, createSource, getSource, listSources, restoreSource, updateSource } from './supplier-items/supplier-items'
// B-W2a-25: subcontracting (./subcontracting).
import {
  addKitLinesContract,
  addOperationContract,
  cancelOrderContract as cancelSubcontractContract,
  closeOrderContract as closeSubcontractContract,
  createOrderContract as createSubcontractContract,
  editKitLineContract,
  editOperationContract,
  getOrderContract as getSubcontractContract,
  issueOrderContract as issueSubcontractContract,
  listOrdersContract as listSubcontractsContract,
  orderCountsContract as subcontractCountsContract,
  outsideOperationsContract,
  planKitContract,
  receiveContract as receiveSubcontractContract,
  removeKitLineContract,
  removeOperationContract,
  reopenOrderContract as reopenSubcontractContract,
  returnKitLineContract,
  sendKitContract,
  stockContract as subcontractorStockContract,
  updateOrderContract as updateSubcontractContract,
} from './subcontracting/contract'
import { returnKitLine, sendKit } from './subcontracting/kit'
import * as subcontracts from './subcontracting/orders'
import { receiveBack } from './subcontracting/receive'
import { subcontractorStock } from './subcontracting/stock'
// B-W2a-44: supplier claims and returns to the supplier (./claims).
import * as claims from './claims/claims'
import {
  addLinesContract as addClaimLinesContract,
  answerClaimContract,
  cancelClaimContract,
  claimCountsContract,
  closeClaimContract,
  createClaimContract,
  editLineContract as editClaimLineContract,
  getClaimContract,
  listClaimsContract,
  removeLineContract as removeClaimLineContract,
  returnGoodsContract,
  returnToSupplierContract,
  sendCheckContract as claimSendCheckContract,
  sendClaimContract,
  updateClaimContract,
} from './claims/contract'
import { returnGoods, returnToSupplier } from './claims/returns'
import { sendCheck as claimSendCheck, sendClaim } from './claims/send'
import { processFiles } from '../../platform/files/service'

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
 *
 * B-W2a-10: approved sources (./supplier-items: list, read, add, change, archive, approve again) and requests to buy
 * (./requests: the queue, its tiles, one request, the "Draft POs for n" preview and the conversion).
 *
 * B-W2a-25: subcontract orders (./subcontracting: the list and its tiles, the record, what a work order may send out, a
 * new draft, its header, operations and kit plan, issue / back to draft / cancel / close, the kit out with its DDT, a kit
 * line back unsent, goods back by bundle) and the stock at each subcontractor.
 *
 * B-W2a-44: supplier claims (./claims: the list and its tiles, the record, a draft from discrepancies, a lot or typed
 * lines, its header and lines, the send-check and the send by e-mail, the supplier's answer, close, cancel), the goods of
 * a return back with the return DDT, and "Return to supplier" in one go.
 *
 * B-W2a-52: a sent order's changes — Change (the next revision as a draft; ./revisions/change.ts), the buyer's
 * counter-proposal (./confirm/counter.ts), the revisions with their diff (./revisions/read.ts), cancel lines and close
 * lines short with what they reach (./revisions/ending.ts); the confirm-by deadline, reminders by hand and the due list
 * (./reminders); the expected deliveries (orders.ts); Send n and its cards (send.ts).
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

  // B-W2a-52 (SCM-058, SCM-059, SCM-060, SCM-067, SCM-087): changes after the send, expected deliveries, Send n, reminders.
  app.post('/purchasing/orders/:purchaseOrderId/proposal/counter', { schema: counterProposalContract }, async (request) => counterPropose(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/orders/:purchaseOrderId/change', { schema: changeContract }, async (request) => changeOrder(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))
  app.get('/purchasing/orders/:purchaseOrderId/revisions', { schema: revisionsContract }, async (request) => listRevisions(request, request.params.purchaseOrderId, request.query.language))
  app.post('/purchasing/orders/:purchaseOrderId/lines/cancel', { schema: cancelLinesContract }, async (request) => cancelLines(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/orders/:purchaseOrderId/lines/close-short', { schema: closeShortContract }, async (request) => closeShort(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))
  app.get('/purchasing/orders/:purchaseOrderId/reach', { schema: reachContract }, async (request) => reachOfAction(request, request.params.purchaseOrderId, request.query))
  app.post('/purchasing/orders/:purchaseOrderId/confirm-by', { schema: moveConfirmByContract }, async (request) => moveConfirmBy(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/orders/:purchaseOrderId/remind', { schema: remindContract }, async (request) => remindSupplier(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))
  app.get('/purchasing/orders/:purchaseOrderId/reminders', { schema: remindersContract }, async (request) => orderReminders(request, request.params.purchaseOrderId))
  app.get('/purchasing/reminders/due', { schema: dueRemindersContract }, async (request) => dueReminders(request, request.query))
  app.get('/purchasing/expected', { schema: expectedContract }, async (request) => expectedDeliveries(request, request.query))
  app.post('/purchasing/orders/send-checks', { schema: sendChecksContract }, async (request) => sendChecksOf(request, request.body))
  app.post('/purchasing/orders/send-many', { schema: sendManyContract }, async (request) => sendMany(request, request.body, idempotencyKeyFrom(request)))

  // B-W2a-10 (SCM-005): approved sources.
  app.get('/purchasing/supplier-items', { schema: listSourcesContract }, async (request) => listSources(request, request.query))

  app.get('/purchasing/supplier-items/:supplierItemId', { schema: getSourceContract }, async (request) => getSource(request, request.params.supplierItemId))

  app.post('/purchasing/supplier-items', { schema: createSourceContract }, async (request, reply) => reply.code(201).send(await createSource(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/purchasing/supplier-items/:supplierItemId', { schema: updateSourceContract }, async (request) => updateSource(request, request.params.supplierItemId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/supplier-items/:supplierItemId/archive', { schema: archiveSourceContract }, async (request) => archiveSource(request, request.params.supplierItemId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/supplier-items/:supplierItemId/restore', { schema: restoreSourceContract }, async (request) => restoreSource(request, request.params.supplierItemId, request.body, idempotencyKeyFrom(request)))

  // B-W2a-10 (SCM-034, SCM-036): requests to buy.
  app.get('/purchasing/requests', { schema: listRequestsContract }, async (request) => listRequests(request, request.query))

  app.get('/purchasing/requests/counts', { schema: requestCountsContract }, async (request) => requestCounts(request, request.query))

  app.get('/purchasing/requests/:kind/:refId', { schema: getRequestContract }, async (request) => getRequest(request, request.params.kind, request.params.refId))

  app.post('/purchasing/requests/preview', { schema: previewConversionContract }, async (request) => previewConversion(request, request.body))

  app.post('/purchasing/requests/convert', { schema: convertRequestsContract }, async (request) => convertRequests(request, request.body, idempotencyKeyFrom(request)))

  // B-W2a-25 (SCM-138, SCM-140, SCM-141, SCM-142): subcontract orders and the stock at each subcontractor.
  app.get('/purchasing/subcontracting/orders', { schema: listSubcontractsContract }, async (request) => subcontracts.listOrders(request, request.query))
  app.get('/purchasing/subcontracting/orders/counts', { schema: subcontractCountsContract }, async (request) => subcontracts.orderCounts(request, request.query))
  app.get('/purchasing/subcontracting/orders/:subcontractOrderId', { schema: getSubcontractContract }, async (request) => subcontracts.getOrder(request, request.params.subcontractOrderId))
  app.get('/purchasing/subcontracting/work-orders/:workOrderId/outside-operations', { schema: outsideOperationsContract }, async (request) => subcontracts.outsideOperations(request, request.params.workOrderId))
  app.get('/purchasing/subcontracting/stock', { schema: subcontractorStockContract }, async (request) => subcontractorStock(request, request.query))
  app.post('/purchasing/subcontracting/orders', { schema: createSubcontractContract }, async (request, reply) => reply.code(201).send(await subcontracts.createOrder(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/purchasing/subcontracting/orders/:subcontractOrderId', { schema: updateSubcontractContract }, async (request) => subcontracts.updateOrder(request, request.params.subcontractOrderId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/operations', { schema: addOperationContract }, async (request, reply) =>
    reply.code(201).send(await subcontracts.addOperation(request, request.params.subcontractOrderId, request.body, idempotencyKeyFrom(request))),
  )
  app.patch('/purchasing/subcontracting/orders/:subcontractOrderId/operations/:operationId', { schema: editOperationContract }, async (request) =>
    subcontracts.editOperation(request, request.params.subcontractOrderId, request.params.operationId, request.body, idempotencyKeyFrom(request)),
  )
  app.delete('/purchasing/subcontracting/orders/:subcontractOrderId/operations/:operationId', { schema: removeOperationContract }, async (request) =>
    subcontracts.removeOperation(request, request.params.subcontractOrderId, request.params.operationId, request.query, idempotencyKeyFrom(request)),
  )
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/kit', { schema: addKitLinesContract }, async (request, reply) =>
    reply.code(201).send(await subcontracts.addKitLines(request, request.params.subcontractOrderId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/kit/from-work-order', { schema: planKitContract }, async (request) => subcontracts.planKit(request, request.params.subcontractOrderId, request.body, idempotencyKeyFrom(request)))
  app.patch('/purchasing/subcontracting/orders/:subcontractOrderId/kit/:lineId', { schema: editKitLineContract }, async (request) =>
    subcontracts.editKitLine(request, request.params.subcontractOrderId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  )
  app.delete('/purchasing/subcontracting/orders/:subcontractOrderId/kit/:lineId', { schema: removeKitLineContract }, async (request) =>
    subcontracts.removeKitLine(request, request.params.subcontractOrderId, request.params.lineId, request.query, idempotencyKeyFrom(request)),
  )
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/issue', { schema: issueSubcontractContract }, async (request) => subcontracts.issueOrder(request, request.params.subcontractOrderId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/reopen', { schema: reopenSubcontractContract }, async (request) => subcontracts.reopenOrder(request, request.params.subcontractOrderId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/cancel', { schema: cancelSubcontractContract }, async (request) => subcontracts.cancelOrder(request, request.params.subcontractOrderId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/close', { schema: closeSubcontractContract }, async (request) => subcontracts.closeOrder(request, request.params.subcontractOrderId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/kit/send', { schema: sendKitContract }, async (request, reply) =>
    reply
      .code(201)
      .send(await sendKit(processFiles(), request, request.params.subcontractOrderId, request.body, idempotencyKeyFrom(request), (error) => request.log.error({ err: error }, 'the kit DDT is issued; its PDF was not stored'))),
  )
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/kit/:lineId/return', { schema: returnKitLineContract }, async (request) =>
    returnKitLine(request, request.params.subcontractOrderId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  )
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/receive', { schema: receiveSubcontractContract }, async (request, reply) =>
    reply.code(201).send(await receiveBack(request, request.params.subcontractOrderId, request.body, idempotencyKeyFrom(request))),
  )

  // B-W2a-44 (SCM-134): supplier claims and returns to the supplier.
  app.get('/purchasing/claims', { schema: listClaimsContract }, async (request) => claims.listClaims(request, request.query))
  app.get('/purchasing/claims/counts', { schema: claimCountsContract }, async (request) => claims.claimCounts(request, request.query))
  app.get('/purchasing/claims/:claimId', { schema: getClaimContract }, async (request) => claims.getClaim(request, request.params.claimId))
  app.post('/purchasing/claims', { schema: createClaimContract }, async (request, reply) => reply.code(201).send(await claims.createClaim(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/purchasing/claims/:claimId', { schema: updateClaimContract }, async (request) => claims.updateClaim(request, request.params.claimId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/claims/:claimId/lines', { schema: addClaimLinesContract }, async (request, reply) => reply.code(201).send(await claims.addLines(request, request.params.claimId, request.body, idempotencyKeyFrom(request))))
  app.patch('/purchasing/claims/:claimId/lines/:lineId', { schema: editClaimLineContract }, async (request) => claims.editLine(request, request.params.claimId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.delete('/purchasing/claims/:claimId/lines/:lineId', { schema: removeClaimLineContract }, async (request) => claims.removeLine(request, request.params.claimId, request.params.lineId, request.query, idempotencyKeyFrom(request)))
  app.get('/purchasing/claims/:claimId/send-check', { schema: claimSendCheckContract }, async (request) => claimSendCheck(request, request.params.claimId))
  app.post('/purchasing/claims/:claimId/send', { schema: sendClaimContract }, async (request) => sendClaim(request, request.params.claimId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/claims/:claimId/answer', { schema: answerClaimContract }, async (request) => claims.answerClaim(request, request.params.claimId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/claims/:claimId/close', { schema: closeClaimContract }, async (request) => claims.closeClaim(request, request.params.claimId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/claims/:claimId/cancel', { schema: cancelClaimContract }, async (request) => claims.cancelClaim(request, request.params.claimId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/claims/:claimId/return', { schema: returnGoodsContract }, async (request, reply) =>
    reply.code(201).send(await returnGoods(processFiles(), request, request.params.claimId, request.body, idempotencyKeyFrom(request), (error) => request.log.error({ err: error }, 'the return DDT is issued; its PDF was not stored'))),
  )
  app.post('/purchasing/claims/returns', { schema: returnToSupplierContract }, async (request, reply) =>
    reply.code(201).send(await returnToSupplier(processFiles(), request, request.body, idempotencyKeyFrom(request), (error) => request.log.error({ err: error }, 'the return DDT is issued; its PDF was not stored'))),
  )

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
