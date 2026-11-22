import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { copyOrderAsQuoteContract } from '../quotes/contract'
import { copyOrderAsQuote } from '../quotes/duplicate'
import { applyAmendment, listAmendments, previewAmendment } from './amend'
import { closeLines, previewCloseLines, reopenLines } from './close-lines'
import { boardContract, closeContract, customersContract, getOrderContract, listOrdersContract, makeOrderContract, promiseContract, readyContract, summaryContract } from './contract'
import {
  applyAmendmentContract,
  cancelCheckContract,
  cancelContract,
  closeLinesContract,
  closeLinesPreviewContract, // B-OP-013
  createManualContract,
  listAmendmentsContract,
  nextOrderNumberContract,
  previewAmendmentContract,
  previewManualContract,
  reopenLinesContract,
  scheduleContract,
  stepRequestContract,
  waiveDepositRequestContract,
  waiveStepContract,
  moneyPlanContract, // B-OM-011
  moneyPlanPreviewContract, // B-OM-011
} from './daily-contract'
import { cancelCheck } from './impact'
import { manifest } from './manifest'
import { createManualOrder, nextOrderNumber, previewManualOrder } from './manual'
import { cancelOrder, changePromise, closeOrder, markReady, officeOrder } from './moves'
import { getOrder, listOrders, makeOrder, orderBoard } from './orders'
import { getSchedule, requestStep, waiveDeposit } from './schedule'
import { applyMoneyPlan, previewMoneyPlan } from './money-plan' // B-OM-011
// B-W2b-398 (LOG-067): each shipment's arrival and proof, the order's delivery and the terms that run from it.
import { deliveriesContract, getDeliveries } from './delivered'
// B-TH-019: the Customer switcher's numbers.
import { orderCustomers } from './customers'
// B-TH-058: the overall view's honest totals.
import { orderSummary } from './summary'
// B-TH-077: what points at the order (its complaints and returns, planning's open re-promises, the gates' refusals).
import { orderLinks, recordLinksContract } from './record-links'
// B-SA-031 / B-SA-032: one order's production as the office reads it, and its dates alone.
import { orderMilestonesContract, orderProductionContract } from './production-contract'
import { orderMilestones, orderProduction } from './production-read'
// B-SA-036: every file of the order, and the walled opening of one.
import { orderFiles, orderFilesContract } from './order-files'
// B-SA-056: who was told about one change of the order.
import { toldContract, whoWasTold } from './told'
import { toldChanges, toldChangesContract } from './told' // F-SA-244
import { openOrderFile, openOrderFileContract } from './order-files-open'
// B-OP-050: the cards' previews in one call.
import { orderFilePreviews, orderFilePreviewsContract } from './order-files-previews'
// B-OP-025: Done on one of the order's production tasks, by the task's own right.
import { doneStillToDoTask, stillToDoTaskDoneContract } from './still-to-do'
// B-SA-011: the small pictures of a page of orders in one read.
import { orderPicturesReadContract } from './contract'
import { recordPictures } from '../../product/images/small-pictures'

/**
 * Sales orders from the accepted quote (B-W1-25; SAL-200, SAL-203, SAL-204, SAL-206, SAL-214; A2 SCR-038, SCR-039): the
 * list, the board's counts by state and its tiles, the record (lines and size grids with per-size progress, dates, the
 * record chain, the settlement), the order of an accepted version when the acceptance could not make it, and the moves a
 * person makes: a new promise date, ready by hand, cancel, close. The order itself is made at acceptance
 * (quotes/after-acceptance); production, shipments and the settlement move it through the worker's handlers
 * (./handlers).
 *
 * B-W2a-30 (orders every day; SAL-202, SAL-155, SAL-209, SAL-210, SAL-211, SAL-216, SAL-217): an order typed by the
 * office (./manual: the next number, a priced preview, Confirm order), its amendments (./amend: preview, apply, the
 * Changes tab), close and reopen lines (./close-lines), the cancel's impact check (./impact; the cancel itself is
 * moves.ts), the payment schedule (./schedule) and the order copied as a new quote (quotes/duplicate).
 */
export default defineRoutes('sales.orders', manifest, async (app) => {
  app.get('/sales/orders', { schema: listOrdersContract }, async (request) => listOrders(request, request.query))

  app.get('/sales/orders/board', { schema: boardContract }, async (request) => orderBoard(request, request.query))

  // B-TH-019: the Customer switcher's numbers (registered before /sales/orders/:orderId).
  app.get('/sales/orders/customers', { schema: customersContract }, async (request) => orderCustomers(request, request.query))

  // B-TH-058: the overall view's totals per customer and for the whole view, each with the filter of its rows (before /:orderId).
  app.get('/sales/orders/summary', { schema: summaryContract }, async (request) => orderSummary(request, request.query))

  // B-SA-011: the small pictures of a page of orders (the ids the reader may not see are left out; before /:orderId).
  app.post('/sales/orders/pictures', { schema: orderPicturesReadContract }, async (request) => recordPictures(request, 'order', request.body.orderIds))

  app.get('/sales/orders/:orderId', { schema: getOrderContract }, async (request) => getOrder(request, request.params.orderId))

  app.post('/sales/orders', { schema: makeOrderContract }, async (request, reply) => {
    const answer = await makeOrder(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.created ? 201 : 200).send(answer)
  })

  app.put('/sales/orders/:orderId/promise', { schema: promiseContract }, async (request) => changePromise(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/orders/:orderId/ready', { schema: readyContract }, async (request) => markReady(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/orders/:orderId/cancel', { schema: cancelContract }, async (request) => cancelOrder(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/orders/:orderId/close', { schema: closeContract }, async (request) => closeOrder(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))

  // B-W2a-30: orders every day.
  app.get('/sales/order-numbers/next', { schema: nextOrderNumberContract }, async (request) => nextOrderNumber(request, request.query.companyId))

  app.post('/sales/orders/manual/preview', { schema: previewManualContract }, async (request) => previewManualOrder(request, request.body))

  app.post('/sales/orders/manual', { schema: createManualContract }, async (request, reply) => reply.code(201).send(await createManualOrder(request, request.body, idempotencyKeyFrom(request))))

  app.get('/sales/orders/:orderId/amendments', { schema: listAmendmentsContract }, async (request) => listAmendments(request, request.params.orderId))

  app.post('/sales/orders/:orderId/amendments/preview', { schema: previewAmendmentContract }, async (request) => previewAmendment(request, request.params.orderId, request.body))

  app.post('/sales/orders/:orderId/amendments', { schema: applyAmendmentContract }, async (request, reply) => reply.code(201).send(await applyAmendment(request, request.params.orderId, request.body, idempotencyKeyFrom(request))))

  app.post('/sales/orders/:orderId/close-lines', { schema: closeLinesContract }, async (request) => closeLines(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))

  // B-OP-013 (order page plan N2): the close's preview (nothing written).
  app.post('/sales/orders/:orderId/close-lines/preview', { schema: closeLinesPreviewContract }, async (request) => previewCloseLines(request, request.params.orderId, request.body))

  app.post('/sales/orders/:orderId/reopen-lines', { schema: reopenLinesContract }, async (request) => reopenLines(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))

  app.get('/sales/orders/:orderId/cancel-check', { schema: cancelCheckContract }, async (request) => cancelCheck(request, request.params.orderId))

  app.get('/sales/orders/:orderId/schedule', { schema: scheduleContract }, async (request) => getSchedule(request, request.params.orderId))

  // B-W2a-F2: the office opens a before-shipping step (its deposit request).
  app.post('/sales/orders/:orderId/schedule/:milestoneId/request', { schema: stepRequestContract }, async (request, reply) =>
    reply.code(201).send(await requestStep(request, request.params.orderId, request.params.milestoneId, request.body, idempotencyKeyFrom(request))),
  )

  // B-W2b-16: the owner waives a deposit or a step before shipping (the step-up after the route's other checks).
  app.post('/sales/orders/:orderId/schedule/:milestoneId/waive', { schema: waiveStepContract }, async (request) =>
    waiveDeposit(request, request.params.orderId, { milestoneId: request.params.milestoneId }, request.body, () => requireStepUp(officeAuthOf(app), request), idempotencyKeyFrom(request)),
  )
  app.post('/sales/orders/:orderId/deposit-requests/:requestId/waive', { schema: waiveDepositRequestContract }, async (request) =>
    waiveDeposit(request, request.params.orderId, { requestId: request.params.requestId }, request.body, () => requireStepUp(officeAuthOf(app), request), idempotencyKeyFrom(request)),
  )
  // B-OM-011 … 016 (order money tab): one hand act on the money plan (a fresh code for new terms and a short deposit beyond the
  // tolerance, asked by the handler), and its preview.
  app.post('/sales/orders/:orderId/money-plan', { schema: moneyPlanContract }, async (request) =>
    applyMoneyPlan(request, request.params.orderId, request.body, () => requireStepUp(officeAuthOf(app), request), idempotencyKeyFrom(request)),
  )
  app.post('/sales/orders/:orderId/money-plan/preview', { schema: moneyPlanPreviewContract }, async (request) => previewMoneyPlan(request, request.params.orderId, request.body))

  app.post('/sales/orders/:orderId/copy-as-quote', { schema: copyOrderAsQuoteContract }, async (request, reply) => {
    const order = await officeOrder(request, request.params.orderId)
    return reply.code(201).send(await copyOrderAsQuote(request, order, request.body, idempotencyKeyFrom(request)))
  })

  // B-W2b-398 (LOG-067)
  app.get('/sales/orders/:orderId/deliveries', { schema: deliveriesContract }, async (request) => getDeliveries(request, request.params.orderId))

  // B-SA-013: the Picture cell's one-row read went; the page's pictures are POST /sales/orders/pictures (B-SA-011).

  // B-TH-077: what points at the order, for its record (W27: only its own customer's).
  app.get('/sales/orders/:orderId/links', { schema: recordLinksContract }, async (request) => orderLinks(request, request.params.orderId))

  // B-SA-031 / B-SA-032 (Sales page plan P2, P16): the order page's production read (parts by right) and its milestones.
  app.get('/sales/orders/:orderId/production', { schema: orderProductionContract }, async (request) => orderProduction(request, request.params.orderId, request.query))
  app.get('/sales/orders/:orderId/milestones', { schema: orderMilestonesContract }, async (request) => orderMilestones(request, request.params.orderId))

  // B-SA-036 (Sales page plan N9, P14): the order's files by source group, and the walled opening of one.
  app.get('/sales/orders/:orderId/files', { schema: orderFilesContract }, async (request) => orderFiles(request, request.params.orderId))
  app.post('/sales/orders/:orderId/files/:fileId/open', { schema: openOrderFileContract }, async (request) => openOrderFile(request, request.params.orderId, request.params.fileId, request.body, idempotencyKeyFrom(request)))
  // B-OP-050 (order page plan N7, R-14): the small previews and PDF links of the cards in view (≤ 24 ids, ≤ 8 addresses a call).
  app.post('/sales/orders/:orderId/files/previews', { schema: orderFilePreviewsContract }, async (request) => orderFilePreviews(request, request.params.orderId, request.body))
  // B-OP-025 (order page plan N1; review R-12): Done on a production task from the order's Still to do.
  app.post('/sales/orders/:orderId/still-to-do/tasks/:taskId/done', { schema: stillToDoTaskDoneContract }, async (request) => doneStillToDoTask(request, request.params.orderId, request.params.taskId, request.body, idempotencyKeyFrom(request)))

  // B-SA-056 (Sales page plan P8, R2, R8): who was told about one change (never who read it).
  app.get('/sales/orders/:orderId/told', { schema: toldContract }, async (request) => whoWasTold(request, request.params.orderId, request.query))
  // F-SA-244: the told lines of all the order's changes (the order page's one read).
  app.get('/sales/orders/:orderId/told/changes', { schema: toldChangesContract }, async (request) => toldChanges(request, request.params.orderId))
})
