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
  workOrderChoicesContract,
} from './subcontracting/contract'
import { returnKitLine, sendKit } from './subcontracting/kit'
import * as subcontracts from './subcontracting/orders'
import { receiveBack } from './subcontracting/receive'
import { subcontractorStock } from './subcontracting/stock'
// B-W2a-76: the floor's subcontract kits (./subcontracting/floor).
import { floorKitContract, floorKitDdtPdfContract, floorKitsContract, floorReceiveBackContract, floorSendKitContract } from './subcontracting/floor-contract'
import { floorKit, floorKitDdtPdf, floorKits, floorReceiveBack, floorSendKit } from './subcontracting/floor'
// B-W2b-176: subcontractor jobs (./portal-jobs): the workshop's portal, its JOB_ACCEPT link, the office's view and acts for it.
import * as jobContracts from './portal-jobs/contract'
import * as jobLink from './portal-jobs/link'
import * as jobOffice from './portal-jobs/office'
import * as jobPortal from './portal-jobs/portal'
// B-W2b-331: subcontracting in depth (./subcontract-depth): written terms, the material balance, bundles, cost, days out.
import * as depthContracts from './subcontract-depth/contract'
import * as depthTerms from './subcontract-depth/terms'
import * as depthBalance from './subcontract-depth/balance'
import * as depthBundles from './subcontract-depth/bundles'
import * as depthCost from './subcontract-depth/cost'
import * as depthAgeing from './subcontract-depth/ageing'
import { appClock as jobClock } from '../../platform/portal/tasks/clock'
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
// B-W2b-14: a claim's photos and letter (./claims), the Owner's reminder switch (./reminders/settings).
import { announceClaimPhotoContract, completeClaimPhotoContract, makeLetterContract, previewLetterContract, removeClaimPhotoContract } from './claims/contract'
import { makeLetter, previewLetter } from './claims/letter'
import { announceClaimPhoto, completeClaimPhoto, removeClaimPhoto } from './claims/photos'
import { requireStepUp } from '../../platform/auth/office/account'
import { getReminderSettings, putReminderSwitch } from './reminders/settings'
import { reminderSettingsContract, reminderSwitchContract } from './reminders/settings-contract'
import { processFiles } from '../../platform/files/service'
// B-W2b-174: supplier orders in the portal (./portal-orders).
import { declineInPortal, confirmInPortal } from './portal-orders/answer'
import { portalConfirmContract, portalCopyContract, portalDeclineContract, portalOrderContract, portalOrdersContract, portalRevisionsContract } from './portal-orders/contract'
import { portalOrderCopy } from './portal-orders/copy'
import { listPortalOrders, portalOrder, portalRevisions } from './portal-orders/read'
import { appClock } from '../../platform/portal/tasks/clock'
// B-W2b-182: the supplier's ship notices in the portal (./ship-notices).
import {
  cancelNoticeContract,
  createNoticeContract,
  listNoticesContract,
  noticeTemplateContract,
  packingListContract,
  packingSheetContract,
  portalNoticeContract,
  sendNoticeContract,
  shippableContract,
  updateNoticeContract,
} from './ship-notices/contract'
import { cancelNotice, createNotice, listNotices, packingTemplate, portalNotice, readPackingSheet, sendNotice, setPackingList, shippableLines, updateNotice } from './ship-notices/portal'
// B-W2b-189: supplier documents and profile in the portal, and the office's check (./portal-profile).
import {
  acceptDocumentContract,
  announceDocumentContract,
  approveSupplierChangeContract,
  completeDocumentContract,
  listSupplierChangesContract,
  listSupplierDocumentsContract,
  refuseDocumentContract,
  refuseSupplierChangeContract,
  requestProfileChangeContract,
  supplierDocumentsContract,
  supplierProfileContract,
  withdrawProfileChangeContract,
} from './portal-profile/contract'
import { approveSupplierChange, listSupplierChanges, refuseSupplierChange } from './portal-profile/decide'
import { announceDocument, completeDocument, supplierDocuments } from './portal-profile/documents'
import { requestProfileChange, supplierProfile, withdrawProfileChange } from './portal-profile/profile'
import { acceptDocument, listSupplierDocuments, refuseDocument } from './portal-profile/review'
// B-W2b-172: the supplier questionnaire (versions, the link, the answer, the buyer's review).
import * as questionnaireContracts from './questionnaire/contract'
import * as questionnaireLink from './questionnaire/link'
import { reviewAnswer, supplierQuestionnaire } from './questionnaire/review'
import { sendQuestionnaireLink } from './questionnaire/send'
import { createVersion, listVersions, publishVersion, updateVersion } from './questionnaire/versions'
// B-W2b-311: suppliers in depth (./suppliers-depth): kinds, status, origin, closures, what each contact receives.
import * as suppliersDepthContracts from './suppliers-depth/contract'
import { listSuppliers, supplierCounts } from './suppliers-depth/list'
import { getProfile, updateProfile } from './suppliers-depth/profile'
import { setReceives } from './suppliers-depth/receives'
import { setStatus, statusReach } from './suppliers-depth/status'
import { registerLinkRenewer } from '../../platform/links/renew'
// B-W2b-219: the leather area tolerance where a PO line names none (PurchasingSettings.leatherAreaTolerancePct).
import { getLeatherTolerance, getLeatherToleranceContract, putLeatherTolerance, putLeatherToleranceContract } from '../inventory/hides/tolerance'
// B-W2b-296: purchase orders in depth (po-depth/).
import * as poDepthContracts from './po-depth/contract'
import { putRate } from './po-depth/currency'
import { recordSupplierDate } from './po-depth/dates'
import { getDepth } from './po-depth/read'
import { clearSchedule, putSchedule } from './po-depth/schedule'
import { putShipTo } from './po-depth/ship-to'
import { createTolerance, listTolerances, moveTolerance, updateTolerance } from './po-depth/tolerances'

// B-W2b-332: ask to buy (./ask-to-buy).
import { askFromShortage, askOptions, askToBuy, cancelRequests as cancelAsked, getAsked, listAsked, rejectRequests as rejectAsked } from './ask-to-buy/ask'
import * as askContracts from './ask-to-buy/contract'
// B-W2b-347: sample and development orders (./sample-orders).
import { sampleChoices } from './sample-orders/choices'
import * as sampleContracts from './sample-orders/contract'
import { createSampleOrder } from './sample-orders/create'
import { listSampleOrders } from './sample-orders/list'
import { sampleOrderPdf } from './sample-orders/pdf'
// B-W2b-315: bank details (./bank, ./portal-profile/bank.ts), the vault and qualifications, the compliance gate (./qualification).
import type { FastifyRequest } from 'fastify'
import { StepUpRequiredError } from '../../platform/auth/office/account'
import * as bank from './bank/bank'
import * as bankContracts from './bank/contract'
import { portalBank, portalProposeBank } from './portal-profile/bank'
import * as qualificationContracts from './qualification/contract'
import * as complianceGate from './qualification/gate'
import * as qualifications from './qualification/qualifications'
import { getVault, vaultSummary as getVaultSummary } from './qualification/vault'
// B-W2b-172: "Ask for a new link" on a dead questionnaire link.
registerLinkRenewer('SUPPLIER_ONBOARD', 'Party', questionnaireLink.renewQuestionnaireLink)

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
  // B-W2a-56: the "New subcontract order" dialog's work order picker.
  app.get('/purchasing/subcontracting/work-orders', { schema: workOrderChoicesContract }, async (request) => subcontracts.workOrderChoices(request, request.query))
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
  // B-W2a-76 (SCM-140, SCM-142; floor.kits SCR-181): the warehouse tablet's kit out and goods back, at its own site.
  app.get('/purchasing/subcontracting/kits', { schema: floorKitsContract }, async (request) => floorKits(request, request.query))
  app.get('/purchasing/subcontracting/kits/:subcontractOrderId', { schema: floorKitContract }, async (request) => floorKit(request, request.params.subcontractOrderId))
  app.post('/purchasing/subcontracting/kits/:subcontractOrderId/send', { schema: floorSendKitContract }, async (request, reply) =>
    reply.code(201).send(await floorSendKit(request, request.params.subcontractOrderId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/purchasing/subcontracting/kits/:subcontractOrderId/receive', { schema: floorReceiveBackContract }, async (request, reply) =>
    reply.code(201).send(await floorReceiveBack(request, request.params.subcontractOrderId, request.body, idempotencyKeyFrom(request))),
  )
  app.get('/purchasing/subcontracting/kits/:subcontractOrderId/ddts/:ddtId/pdf', { schema: floorKitDdtPdfContract }, async (request) => floorKitDdtPdf(request, request.params.subcontractOrderId, request.params.ddtId))

  // B-W2b-176 (SCM-154 to SCM-157, PLN-163): subcontractor jobs (./portal-jobs). The workshop's portal (no fee, no amount),
  // its JOB_ACCEPT link (accept, move the date, decline), and on the office's order what the workshop said, the job link,
  // the answer to a proposed date, and the workshop's acts written by the office for a workshop without e-mail (C3).
  app.get('/portal/jobs', { schema: jobContracts.portalJobsContract }, async (request) => jobPortal.listPortalJobs(request, request.query, jobClock(app).now()))
  app.get('/portal/jobs/:subcontractOrderId', { schema: jobContracts.portalJobContract }, async (request) => jobPortal.portalJob(request, request.params.subcontractOrderId))
  app.post('/portal/jobs/:subcontractOrderId/accept', { schema: jobContracts.portalAcceptContract }, async (request) => jobPortal.acceptInPortal(app, request, request.params.subcontractOrderId, request.body))
  app.post('/portal/jobs/:subcontractOrderId/decline', { schema: jobContracts.portalDeclineContract }, async (request) => jobPortal.declineInPortal(app, request, request.params.subcontractOrderId, request.body))
  app.post('/portal/jobs/:subcontractOrderId/kit', { schema: jobContracts.portalKitContract }, async (request) => jobPortal.checkKitInPortal(app, request, request.params.subcontractOrderId, request.body))
  app.post('/portal/jobs/:subcontractOrderId/kit/photos', { schema: jobContracts.portalPhotoContract }, async (request, reply) => reply.code(201).send(await jobPortal.announcePhoto(request, request.params.subcontractOrderId, request.body)))
  app.post('/portal/jobs/:subcontractOrderId/kit/photos/:fileId/complete', { schema: jobContracts.portalPhotoCompleteContract }, async (request) => jobPortal.completePhoto(request, request.params.subcontractOrderId, request.params.fileId))
  app.post('/portal/jobs/:subcontractOrderId/progress', { schema: jobContracts.portalProgressContract }, async (request) => jobPortal.reportInPortal(app, request, request.params.subcontractOrderId, request.body))
  app.post('/portal/jobs/:subcontractOrderId/returns', { schema: jobContracts.portalReturnContract }, async (request) => jobPortal.announceInPortal(app, request, request.params.subcontractOrderId, request.body))
  app.get('/purchasing/subcontracting/orders/:subcontractOrderId/workshop', { schema: jobContracts.workshopContract }, async (request) => jobOffice.workshopView(request, request.params.subcontractOrderId))
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/job-link', { schema: jobContracts.jobLinkContract }, async (request, reply) => reply.code(201).send(await jobLink.sendJobLink(request, request.params.subcontractOrderId, request.body)))
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/workshop/date', { schema: jobContracts.officeDateContract }, async (request) => jobOffice.decideDate(request, request.params.subcontractOrderId, request.body))
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/workshop/accept', { schema: jobContracts.officeAcceptContract }, async (request) => jobOffice.acceptForWorkshop(request, request.params.subcontractOrderId, request.body))
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/workshop/decline', { schema: jobContracts.officeDeclineContract }, async (request) => jobOffice.declineForWorkshop(request, request.params.subcontractOrderId, request.body))
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/workshop/kit', { schema: jobContracts.officeKitContract }, async (request) => jobOffice.checkKitForWorkshop(request, request.params.subcontractOrderId, request.body))
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/workshop/progress', { schema: jobContracts.officeProgressContract }, async (request) => jobOffice.reportForWorkshop(request, request.params.subcontractOrderId, request.body))
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/workshop/returns', { schema: jobContracts.officeReturnContract }, async (request) => jobOffice.announceForWorkshop(request, request.params.subcontractOrderId, request.body))
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/workshop/returns/:returnNoticeId/cancel', { schema: jobContracts.officeCancelReturnContract }, async (request) =>
    jobOffice.cancelNotice(request, request.params.subcontractOrderId, request.params.returnNoticeId, request.body),
  )
  const jobLinkUse = app.officeAuth?.rateLimits.linkUse ?? AUTH_RATE_LIMITS.linkUse
  const jobLimited = { rateLimit: { max: jobLinkUse.max, timeWindow: jobLinkUse.timeWindowMs } }
  app.get('/link/job', { schema: jobContracts.linkJobContract, config: jobLimited }, async (request) => jobLink.linkJob(request, request.query.language))
  app.post('/link/job/accept', { schema: jobContracts.linkAcceptContract, config: jobLimited }, async (request) => jobLink.acceptByLink(request, request.body, request.query.language))
  app.post('/link/job/move-date', { schema: jobContracts.linkMoveDateContract, config: jobLimited }, async (request) => jobLink.moveDateByLink(request, request.body, request.query.language))
  app.post('/link/job/decline', { schema: jobContracts.linkDeclineContract, config: jobLimited }, async (request) => jobLink.declineByLink(request, request.body, request.query.language))

  // B-W2b-331 (SCM-049, SCM-143, SCM-144, SCM-145, SCM-146, SCM-150): subcontracting in depth.
  app.get('/purchasing/subcontracting/agreements', { schema: depthContracts.listAgreementsContract }, async (request) => depthTerms.listAgreements(request, request.query))
  app.get('/purchasing/subcontracting/agreements/:agreementId', { schema: depthContracts.getAgreementContract }, async (request) => depthTerms.getAgreement(request, request.params.agreementId))
  app.post('/purchasing/subcontracting/agreements', { schema: depthContracts.createAgreementContract }, async (request, reply) => reply.code(201).send(await depthTerms.createAgreement(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/purchasing/subcontracting/agreements/:agreementId', { schema: depthContracts.updateAgreementContract }, async (request) => depthTerms.updateAgreement(request, request.params.agreementId, request.body, idempotencyKeyFrom(request)))
  app.delete('/purchasing/subcontracting/agreements/:agreementId', { schema: depthContracts.deleteAgreementContract }, async (request) => depthTerms.deleteAgreement(request, request.params.agreementId, request.query, idempotencyKeyFrom(request)))
  app.post('/purchasing/subcontracting/agreements/:agreementId/sign', { schema: depthContracts.signAgreementContract }, async (request) => depthTerms.signAgreement(request, request.params.agreementId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/subcontracting/agreements/:agreementId/terminate', { schema: depthContracts.terminateAgreementContract }, async (request) => depthTerms.terminateAgreement(request, request.params.agreementId, request.body, idempotencyKeyFrom(request)))
  app.get('/purchasing/subcontracting/orders/:subcontractOrderId/terms', { schema: depthContracts.orderTermsContract }, async (request) => depthTerms.orderTerms(request, request.params.subcontractOrderId))
  app.get('/purchasing/subcontracting/orders/:subcontractOrderId/balance', { schema: depthContracts.orderBalanceContract }, async (request) => depthBalance.orderBalance(request, request.params.subcontractOrderId))
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/balance/declare', { schema: depthContracts.declareBalanceContract }, async (request, reply) =>
    reply.code(201).send(await depthBalance.declareBalance(request, request.params.subcontractOrderId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/balance/adjust', { schema: depthContracts.adjustBalanceContract }, async (request, reply) =>
    reply.code(201).send(await depthBalance.adjustBalance(request, request.params.subcontractOrderId, request.body, idempotencyKeyFrom(request))),
  )
  app.get('/purchasing/subcontracting/orders/:subcontractOrderId/bundles', { schema: depthContracts.orderBundlesContract }, async (request) => depthBundles.orderBundles(request, request.params.subcontractOrderId))
  app.get('/purchasing/subcontracting/orders/:subcontractOrderId/cost', { schema: depthContracts.orderCostContract }, async (request) => depthCost.orderCost(request, request.params.subcontractOrderId))
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/costs', { schema: depthContracts.bookCostContract }, async (request, reply) =>
    reply.code(201).send(await depthCost.bookCost(request, request.params.subcontractOrderId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/purchasing/subcontracting/orders/:subcontractOrderId/costs/:entryId/reverse', { schema: depthContracts.reverseCostContract }, async (request, reply) =>
    reply.code(201).send(await depthCost.reverseCost(request, request.params.subcontractOrderId, request.params.entryId, request.body, idempotencyKeyFrom(request))),
  )
  app.get('/purchasing/subcontracting/ageing', { schema: depthContracts.ageingContract }, async (request) => depthAgeing.subcontractorAgeing(request, request.query))
  app.get('/purchasing/subcontracting/balances', { schema: depthContracts.balancesContract }, async (request) => depthAgeing.openBalances(request, request.query))

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
  app.post('/purchasing/claims/:claimId/send', { schema: sendClaimContract }, async (request) => sendClaim(processFiles(), request, request.params.claimId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/claims/:claimId/answer', { schema: answerClaimContract }, async (request) => claims.answerClaim(request, request.params.claimId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/claims/:claimId/close', { schema: closeClaimContract }, async (request) => claims.closeClaim(request, request.params.claimId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/claims/:claimId/cancel', { schema: cancelClaimContract }, async (request) => claims.cancelClaim(request, request.params.claimId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/claims/:claimId/return', { schema: returnGoodsContract }, async (request, reply) =>
    reply.code(201).send(await returnGoods(processFiles(), request, request.params.claimId, request.body, idempotencyKeyFrom(request), (error) => request.log.error({ err: error }, 'the return DDT is issued; its PDF was not stored'))),
  )
  app.post('/purchasing/claims/returns', { schema: returnToSupplierContract }, async (request, reply) =>
    reply.code(201).send(await returnToSupplier(processFiles(), request, request.body, idempotencyKeyFrom(request), (error) => request.log.error({ err: error }, 'the return DDT is issued; its PDF was not stored'))),
  )
  // B-W2b-14 (SCM-135; Z1:08): the claim's photos and the claim letter (PDF, no price).
  app.post('/purchasing/claims/:claimId/photos', { schema: announceClaimPhotoContract }, async (request, reply) =>
    reply.code(201).send(await announceClaimPhoto(processFiles(), request, request.params.claimId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/purchasing/claims/:claimId/photos/:fileId/complete', { schema: completeClaimPhotoContract }, async (request) => completeClaimPhoto(processFiles(), request, request.params.claimId, request.params.fileId, idempotencyKeyFrom(request)))
  app.delete('/purchasing/claims/:claimId/photos/:fileId', { schema: removeClaimPhotoContract }, async (request) => removeClaimPhoto(processFiles(), request, request.params.claimId, request.params.fileId, request.query, idempotencyKeyFrom(request)))
  app.get('/purchasing/claims/:claimId/letter', { schema: previewLetterContract }, async (request, reply) => {
    const { pdf, fileName } = await previewLetter(request, request.params.claimId, request.query)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
  app.post('/purchasing/claims/:claimId/letter', { schema: makeLetterContract }, async (request, reply) => reply.code(201).send(await makeLetter(processFiles(), request, request.params.claimId, request.body, idempotencyKeyFrom(request))))
  // B-W2b-14 (Z1:09): the Owner's per-company switch for automatic PO confirmation reminders (OFF by default; ON asks step-up).
  app.get('/purchasing/reminders/settings', { schema: reminderSettingsContract }, async (request) => getReminderSettings(request, request.query))
  app.put('/purchasing/reminders/settings/switch', { schema: reminderSwitchContract }, async (request) => putReminderSwitch(request, request.body, () => requireStepUp(officeAuthOf(app), request), idempotencyKeyFrom(request)))

  // B-W2b-219: the leather area tolerance where a PO line names none (the incoming area check and the re-measure read it).
  app.get('/purchasing/settings/leather-tolerance', { schema: getLeatherToleranceContract }, async (request) => getLeatherTolerance(request, request.query))
  app.put('/purchasing/settings/leather-tolerance', { schema: putLeatherToleranceContract }, async (request) => putLeatherTolerance(request, request.body, idempotencyKeyFrom(request)))

  // B-W2b-296 (SCM-052, SCM-061, SCM-065, SCM-066, SCM-088, SCM-147): purchase orders in depth (po-depth/): the delivery
  // schedule per line, the supplier's days and their history, the rate at order, ship to a third party or a workshop, the
  // delivery tolerances. The send checks and prints them (views.ts, send.ts); a receipt reads the tolerances (receiving.ts).
  app.get('/purchasing/orders/:purchaseOrderId/depth', { schema: poDepthContracts.getDepthContract }, async (request) => getDepth(request, request.params.purchaseOrderId))
  app.put('/purchasing/orders/:purchaseOrderId/lines/:lineId/deliveries', { schema: poDepthContracts.putScheduleContract }, async (request) => putSchedule(request, request.params.purchaseOrderId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.delete('/purchasing/orders/:purchaseOrderId/lines/:lineId/deliveries', { schema: poDepthContracts.clearScheduleContract }, async (request) => clearSchedule(request, request.params.purchaseOrderId, request.params.lineId, request.query, idempotencyKeyFrom(request)))
  app.post('/purchasing/orders/:purchaseOrderId/lines/:lineId/supplier-date', { schema: poDepthContracts.supplierDateContract }, async (request) => recordSupplierDate(request, request.params.purchaseOrderId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.put('/purchasing/orders/:purchaseOrderId/rate', { schema: poDepthContracts.putRateContract }, async (request) => putRate(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))
  app.put('/purchasing/orders/:purchaseOrderId/ship-to', { schema: poDepthContracts.putShipToContract }, async (request) => putShipTo(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))
  app.get('/purchasing/tolerances', { schema: poDepthContracts.listTolerancesContract }, async (request) => listTolerances(request, request.query))
  app.post('/purchasing/tolerances', { schema: poDepthContracts.createToleranceContract }, async (request, reply) => reply.code(201).send(await createTolerance(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/purchasing/tolerances/:toleranceId', { schema: poDepthContracts.updateToleranceContract }, async (request) => updateTolerance(request, request.params.toleranceId, request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/tolerances/:toleranceId/archive', { schema: poDepthContracts.moveToleranceContract }, async (request) => moveTolerance(request, request.params.toleranceId, 'archive', request.body, idempotencyKeyFrom(request)))
  app.post('/purchasing/tolerances/:toleranceId/reactivate', { schema: poDepthContracts.moveToleranceContract }, async (request) => moveTolerance(request, request.params.toleranceId, 'reactivate', request.body, idempotencyKeyFrom(request)))

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

  // B-W2b-174 (SCM-094, SCM-086): the supplier's purchase orders in the portal, without any price (./portal-orders): the
  // list with its chips, the record, every version and what changed, the copy without prices, the answer and the decline.
  app.get('/portal/purchase-orders', { schema: portalOrdersContract }, async (request) => listPortalOrders(request, request.query, appClock(app).now()))

  app.get('/portal/purchase-orders/:purchaseOrderId', { schema: portalOrderContract }, async (request) => portalOrder(request, request.params.purchaseOrderId))

  app.get('/portal/purchase-orders/:purchaseOrderId/revisions', { schema: portalRevisionsContract }, async (request) => portalRevisions(request, request.params.purchaseOrderId, request.query.language))

  app.get('/portal/purchase-orders/:purchaseOrderId/copy', { schema: portalCopyContract }, async (request, reply) => {
    const { pdf, fileName } = await portalOrderCopy(request, request.params.purchaseOrderId, request.query.language)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.post('/portal/purchase-orders/:purchaseOrderId/confirm', { schema: portalConfirmContract }, async (request) => confirmInPortal(app, request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))

  app.post('/portal/purchase-orders/:purchaseOrderId/decline', { schema: portalDeclineContract }, async (request) => declineInPortal(app, request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))

  // B-W2b-182 (SCM-106, SCM-107): the supplier's ship notices (./ship-notices): the list, the lines it may ship, the packing
  // list's template, one notice with its checks, a new one from a confirmed order, its terms and lines, the packing list by
  // hand or from the tannery's sheet (a verdict per row first), the send (numbered as the system) and the cancel.
  app.get('/portal/ship-notices', { schema: listNoticesContract }, async (request) => listNotices(request, request.query, appClock(app).now()))

  app.get('/portal/ship-notices/shippable', { schema: shippableContract }, async (request) => shippableLines(request, request.query))

  app.get('/portal/ship-notices/template', { schema: noticeTemplateContract }, async (request, reply) => {
    const file = await packingTemplate(request, request.query)
    return reply.type(file.contentType).header('content-disposition', `attachment; filename="${file.name}"`).header('cache-control', 'no-store').send(file.body)
  })

  app.get('/portal/ship-notices/:shipNoticeId', { schema: portalNoticeContract }, async (request) => portalNotice(request, request.params.shipNoticeId, appClock(app).now()))

  app.post('/portal/ship-notices', { schema: createNoticeContract }, async (request, reply) => reply.code(201).send(await createNotice(app, request, request.body, idempotencyKeyFrom(request), appClock(app).now())))

  app.patch('/portal/ship-notices/:shipNoticeId', { schema: updateNoticeContract }, async (request) => updateNotice(app, request, request.params.shipNoticeId, request.body, idempotencyKeyFrom(request), appClock(app).now()))

  app.put('/portal/ship-notices/:shipNoticeId/packing-list', { schema: packingListContract }, async (request) => setPackingList(app, request, request.params.shipNoticeId, request.body, idempotencyKeyFrom(request), appClock(app).now()))

  app.post('/portal/ship-notices/:shipNoticeId/packing-list/sheet', { schema: packingSheetContract }, async (request) => readPackingSheet(app, request, request.params.shipNoticeId, request.body, idempotencyKeyFrom(request), appClock(app).now()))

  app.post('/portal/ship-notices/:shipNoticeId/send', { schema: sendNoticeContract }, async (request) => sendNotice(app, request, request.params.shipNoticeId, request.body, idempotencyKeyFrom(request), appClock(app).now()))

  app.post('/portal/ship-notices/:shipNoticeId/cancel', { schema: cancelNoticeContract }, async (request) => cancelNotice(app, request, request.params.shipNoticeId, request.body, idempotencyKeyFrom(request), appClock(app).now()))
  // B-W2b-189 (SCM-096, SCM-097): the supplier's documents and profile in the portal (./portal-profile): what we ask for and
  // its documents, the upload (unshared until our check), its addresses and contacts with the changes it sends for our check;
  // and the office's check of both (accept or refuse a document; approve or refuse a change, Home › Approvals).
  app.get('/portal/supplier-documents', { schema: supplierDocumentsContract }, async (request) => supplierDocuments(request, appClock(app).now()))

  app.post('/portal/supplier-documents', { schema: announceDocumentContract }, async (request, reply) => reply.code(201).send(await announceDocument(app, request, request.body, appClock(app).now(), idempotencyKeyFrom(request))))

  app.post('/portal/supplier-documents/:fileId/complete', { schema: completeDocumentContract }, async (request) => completeDocument(app, request, request.params.fileId, appClock(app).now(), idempotencyKeyFrom(request)))

  app.get('/portal/supplier-profile', { schema: supplierProfileContract }, async (request) => supplierProfile(request, appClock(app).now()))

  app.post('/portal/supplier-profile/changes', { schema: requestProfileChangeContract }, async (request, reply) => reply.code(201).send(await requestProfileChange(app, request, request.body, idempotencyKeyFrom(request))))

  app.post('/portal/supplier-profile/changes/:requestId/withdraw', { schema: withdrawProfileChangeContract }, async (request) => withdrawProfileChange(app, request, request.params.requestId, idempotencyKeyFrom(request)))

  app.get('/purchasing/supplier-documents', { schema: listSupplierDocumentsContract }, async (request) => listSupplierDocuments(request, request.query, appClock(app).now()))

  app.post('/purchasing/supplier-documents/:fileId/accept', { schema: acceptDocumentContract }, async (request) => acceptDocument(app, request, request.params.fileId, request.body, appClock(app).now(), idempotencyKeyFrom(request)))

  app.post('/purchasing/supplier-documents/:fileId/refuse', { schema: refuseDocumentContract }, async (request) => refuseDocument(app, request, request.params.fileId, request.body, appClock(app).now(), idempotencyKeyFrom(request)))

  app.get('/purchasing/supplier-changes', { schema: listSupplierChangesContract }, async (request) => listSupplierChanges(request, request.query, appClock(app).now()))

  app.post('/purchasing/supplier-changes/:requestId/approve', { schema: approveSupplierChangeContract }, async (request) => approveSupplierChange(app, request, request.params.requestId, idempotencyKeyFrom(request)))

  app.post('/purchasing/supplier-changes/:requestId/refuse', { schema: refuseSupplierChangeContract }, async (request) => refuseSupplierChange(app, request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  // B-W2b-172 (SCM-023): the supplier questionnaire (./questionnaire): the company's versions (questions as data, the starter
  // set), the link from the supplier's record, the supplier's link page (VAT check, documents, code of conduct, the signed
  // answer kept as a PDF with a review task) and the buyer's review (accepted, or questions back on the supplier's thread).
  app.get('/purchasing/questionnaires', { schema: questionnaireContracts.listVersionsContract }, async (request) => listVersions(request))

  app.post('/purchasing/questionnaires', { schema: questionnaireContracts.createVersionContract }, async (request, reply) => reply.code(201).send(await createVersion(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/purchasing/questionnaires/:questionnaireId', { schema: questionnaireContracts.updateVersionContract }, async (request) => updateVersion(request, request.params.questionnaireId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/questionnaires/:questionnaireId/publish', { schema: questionnaireContracts.publishVersionContract }, async (request) => publishVersion(request, request.params.questionnaireId, request.body, idempotencyKeyFrom(request)))

  app.get('/purchasing/suppliers/:partyId/questionnaire', { schema: questionnaireContracts.supplierQuestionnaireContract }, async (request) => supplierQuestionnaire(app, request, request.params.partyId))

  app.post('/purchasing/suppliers/:partyId/questionnaire-link', { schema: questionnaireContracts.sendLinkContract }, async (request, reply) => reply.code(201).send(await sendQuestionnaireLink(request, request.params.partyId, request.body)))

  app.post('/purchasing/questionnaire-answers/:responseId/review', { schema: questionnaireContracts.reviewContract }, async (request) => reviewAnswer(app, request, request.params.responseId, request.body, idempotencyKeyFrom(request)))

  const questionnaireLinkUse = app.officeAuth?.rateLimits.linkUse ?? AUTH_RATE_LIMITS.linkUse
  const questionnaireLimited = { rateLimit: { max: questionnaireLinkUse.max, timeWindow: questionnaireLinkUse.timeWindowMs } }
  app.get('/link/supplier-questionnaire', { schema: questionnaireContracts.linkPageContract, config: questionnaireLimited }, async (request) => questionnaireLink.linkQuestionnaire(app, request, request.query.language))

  app.post('/link/supplier-questionnaire', { schema: questionnaireContracts.linkSubmitContract, config: questionnaireLimited }, async (request) => questionnaireLink.linkSubmit(app, request, request.body, request.query.language))

  app.post('/link/supplier-questionnaire/vat-check', { schema: questionnaireContracts.vatCheckContract, config: questionnaireLimited }, async (request) => questionnaireLink.linkVatCheck(request, request.body))

  app.post('/link/supplier-questionnaire/documents', { schema: questionnaireContracts.linkUploadContract, config: questionnaireLimited }, async (request, reply) => reply.code(201).send(await questionnaireLink.linkAnnounceDocument(request, request.body)))

  app.post('/link/supplier-questionnaire/documents/:fileId/complete', { schema: questionnaireContracts.linkUploadDoneContract, config: questionnaireLimited }, async (request) => questionnaireLink.linkCompleteDocument(request, request.params.fileId))

  app.get('/link/supplier-questionnaire/code-of-conduct', { schema: questionnaireContracts.linkCodeContract, config: questionnaireLimited }, async (request, reply) => {
    const { pdf, fileName } = await questionnaireLink.linkCodeOfConduct(request, request.query.language)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  // B-W2b-332 (SCM-035, SCM-037): ask to buy — what the dialog offers, one's requests, one request, "Send request", a line of
  // the shortage list asked (or drafted at once by a buyer), take requests back, refuse them (the buyer).
  app.get('/purchasing/ask-to-buy/options', { schema: askContracts.optionsContract }, async (request) => askOptions(request, request.query))

  app.get('/purchasing/ask-to-buy', { schema: askContracts.listContract }, async (request) => listAsked(request, request.query))

  app.get('/purchasing/ask-to-buy/:requestId', { schema: askContracts.getContract }, async (request) => getAsked(request, request.params.requestId))

  app.post('/purchasing/ask-to-buy', { schema: askContracts.askContract }, async (request, reply) => reply.code(201).send(await askToBuy(request, request.body, idempotencyKeyFrom(request))))

  app.post('/purchasing/ask-to-buy/from-shortage', { schema: askContracts.fromShortageContract }, async (request, reply) => reply.code(201).send(await askFromShortage(request, request.body, idempotencyKeyFrom(request))))

  app.post('/purchasing/ask-to-buy/cancel', { schema: askContracts.cancelContract }, async (request) => cancelAsked(request, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/ask-to-buy/reject', { schema: askContracts.rejectContract }, async (request) => rejectAsked(request, request.body, idempotencyKeyFrom(request)))
  // B-W2b-311 (SCM-002, SCM-004, SCM-008, SCM-012, SCM-016): suppliers in depth (./suppliers-depth).
  app.get('/purchasing/suppliers', { schema: suppliersDepthContracts.listSuppliersContract }, async (request) => listSuppliers(request, request.query))

  app.get('/purchasing/suppliers/counts', { schema: suppliersDepthContracts.supplierCountsContract }, async (request) => supplierCounts(request, request.query))

  app.get('/purchasing/suppliers/:partyId/profile', { schema: suppliersDepthContracts.getProfileContract }, async (request) => getProfile(request, request.params.partyId))

  app.patch('/purchasing/suppliers/:partyId/profile', { schema: suppliersDepthContracts.updateProfileContract }, async (request) => updateProfile(request, request.params.partyId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/suppliers/:partyId/status', { schema: suppliersDepthContracts.setStatusContract }, async (request) => setStatus(request, request.params.partyId, request.body, idempotencyKeyFrom(request)))

  app.get('/purchasing/suppliers/:partyId/status-reach', { schema: suppliersDepthContracts.statusReachContract }, async (request) => statusReach(request, request.params.partyId, request.query.status))

  app.put('/purchasing/suppliers/:partyId/contacts/:contactId/receives', { schema: suppliersDepthContracts.setReceivesContract }, async (request) => setReceives(request, request.params.partyId, request.params.contactId, request.body, idempotencyKeyFrom(request)))

  // B-W2b-347 (SCM-043): sample and development orders (./sample-orders) — the list (RFQs & sourcing, SCR-222), what New sample
  // order offers, the draft it makes (kind SAMPLE, for a style or a sample round) and the sample order PDF (a new tab). The rest
  // of a sample order is W1's on its record; the send prints it as the sample order (send.ts); planning never nets it.
  app.get('/purchasing/sample-orders', { schema: sampleContracts.listSampleOrdersContract }, async (request) => listSampleOrders(request, request.query))
  app.get('/purchasing/sample-orders/choices', { schema: sampleContracts.sampleChoicesContract }, async (request) => sampleChoices(request, request.query))
  app.post('/purchasing/sample-orders', { schema: sampleContracts.createSampleOrderContract }, async (request, reply) => reply.code(201).send(await createSampleOrder(request, request.body, idempotencyKeyFrom(request))))
  app.get('/purchasing/sample-orders/:purchaseOrderId/pdf', { schema: sampleContracts.sampleOrderPdfContract }, async (request, reply) => {
    const { pdf, fileName } = await sampleOrderPdf(request, request.params.purchaseOrderId, request.query.language)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
  // B-W2b-315 (SCM-007): a supplier's bank details (./bank, ./portal-profile/bank.ts): propose, verify and reveal ask a fresh
  // office step-up; the portal's proposal an e-mail step-up.
  const freshStepUp = (request: FastifyRequest) => () => {
    const auth = app.officeAuth
    if (!auth) throw new StepUpRequiredError()
    try {
      requireStepUp(auth, request)
    } catch (error) {
      if (error instanceof StepUpRequiredError) throw error
      throw new StepUpRequiredError()
    }
  }
  app.get('/purchasing/suppliers/:partyId/bank', { schema: bankContracts.getBankContract }, async (request) => bank.getBank(request, request.params.partyId))

  app.post('/purchasing/suppliers/:partyId/bank', { schema: bankContracts.proposeBankContract }, async (request, reply) => reply.code(201).send(await bank.proposeBank(request, request.params.partyId, request.body, freshStepUp(request), idempotencyKeyFrom(request))))

  app.post('/purchasing/suppliers/:partyId/bank/:accountId/call-back', { schema: bankContracts.callBackContract }, async (request) => bank.callBack(request, request.params.partyId, request.params.accountId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/suppliers/:partyId/bank/:accountId/verify', { schema: bankContracts.verifyContract }, async (request, reply) => {
    const answer = await bank.verify(request, request.params.partyId, request.params.accountId, request.body, freshStepUp(request), idempotencyKeyFrom(request))
    return reply.code(answer.approval ? 202 : 200).send(answer)
  })

  app.post('/purchasing/suppliers/:partyId/bank/:accountId/refuse', { schema: bankContracts.refuseContract }, async (request) => bank.refuse(request, request.params.partyId, request.params.accountId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/suppliers/:partyId/bank/:accountId/retire', { schema: bankContracts.retireContract }, async (request) => bank.retire(request, request.params.partyId, request.params.accountId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/suppliers/:partyId/bank/:accountId/reveal', { schema: bankContracts.revealContract }, async (request, reply) => reply.header('cache-control', 'no-store').send(await bank.reveal(request, request.params.partyId, request.params.accountId, freshStepUp(request))))

  app.get('/portal/supplier-bank', { schema: bankContracts.portalBankContract }, async (request) => portalBank(request))

  app.post('/portal/supplier-bank', { schema: bankContracts.portalProposeContract }, async (request, reply) => reply.code(201).send(await portalProposeBank(app, request, request.body, idempotencyKeyFrom(request))))
  // B-W2b-315 (SCM-020, SCM-027, VN2:01, VN2:02): the document vault and the qualifications (./qualification).
  app.get('/purchasing/suppliers/documents-summary', { schema: qualificationContracts.vaultSummaryContract }, async (request) => getVaultSummary(request, request.query))

  app.get('/purchasing/suppliers/:partyId/documents', { schema: qualificationContracts.vaultContract }, async (request) => getVault(request, request.params.partyId))

  app.get('/purchasing/suppliers/:partyId/qualifications', { schema: qualificationContracts.listQualificationsContract }, async (request) => qualifications.listQualifications(request, request.params.partyId))

  app.post('/purchasing/suppliers/:partyId/qualifications', { schema: qualificationContracts.createQualificationContract }, async (request, reply) => reply.code(201).send(await qualifications.createQualification(request, request.params.partyId, request.body, idempotencyKeyFrom(request))))

  app.patch('/purchasing/suppliers/:partyId/qualifications/:qualificationId', { schema: qualificationContracts.updateQualificationContract }, async (request) => qualifications.updateQualification(request, request.params.partyId, request.params.qualificationId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/suppliers/:partyId/qualifications/:qualificationId/decide', { schema: qualificationContracts.decideQualificationContract }, async (request) => qualifications.decideQualification(request, request.params.partyId, request.params.qualificationId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/suppliers/:partyId/qualifications/:qualificationId/suspend', { schema: qualificationContracts.suspendQualificationContract }, async (request) => qualifications.suspendQualification(request, request.params.partyId, request.params.qualificationId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/suppliers/:partyId/qualifications/:qualificationId/lift', { schema: qualificationContracts.liftQualificationContract }, async (request) => qualifications.liftQualification(request, request.params.partyId, request.params.qualificationId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/suppliers/:partyId/qualifications/:qualificationId/withdraw', { schema: qualificationContracts.withdrawQualificationContract }, async (request) => qualifications.withdrawQualification(request, request.params.partyId, request.params.qualificationId, request.body, idempotencyKeyFrom(request)))
  // B-W2b-315 (SCM-022): the compliance gate on a PO (./qualification/gate.ts): what holds it, "Send without a valid document?".
  app.get('/purchasing/orders/:purchaseOrderId/compliance', { schema: qualificationContracts.complianceContract }, async (request) => complianceGate.getCompliance(request, request.params.purchaseOrderId))

  app.post('/purchasing/orders/:purchaseOrderId/compliance-override', { schema: qualificationContracts.askOverrideContract }, async (request) => complianceGate.askOverride(request, request.params.purchaseOrderId, request.body, idempotencyKeyFrom(request)))

  app.post('/purchasing/orders/:purchaseOrderId/compliance-override/decide', { schema: qualificationContracts.decideOverrideContract }, async (request) => complianceGate.decideOverride(request, request.params.purchaseOrderId, request.body, freshStepUp(request), idempotencyKeyFrom(request)))

  app.post('/purchasing/orders/:purchaseOrderId/compliance-override/withdraw', { schema: qualificationContracts.withdrawOverrideContract }, async (request) => complianceGate.withdrawOverride(request, request.params.purchaseOrderId, idempotencyKeyFrom(request)))

  app.get('/purchasing/compliance-overrides', { schema: qualificationContracts.listOverridesContract }, async (request) => complianceGate.listOverrides(request, request.query))

  app.get('/purchasing/compliance-overrides/:purchaseOrderId', { schema: qualificationContracts.complianceContract }, async (request) => complianceGate.getCompliance(request, request.params.purchaseOrderId))
})
