import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { copyOrderAsQuoteContract } from '../quotes/contract'
import { copyOrderAsQuote } from '../quotes/duplicate'
import { applyAmendment, listAmendments, previewAmendment } from './amend'
import { closeLines, reopenLines } from './close-lines'
import { boardContract, closeContract, getOrderContract, listOrdersContract, makeOrderContract, promiseContract, readyContract } from './contract'
import {
  applyAmendmentContract,
  cancelCheckContract,
  cancelContract,
  closeLinesContract,
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
} from './daily-contract'
import { cancelCheck } from './impact'
import { manifest } from './manifest'
import { createManualOrder, nextOrderNumber, previewManualOrder } from './manual'
import { cancelOrder, changePromise, closeOrder, markReady, officeOrder } from './moves'
import { getOrder, listOrders, makeOrder, orderBoard } from './orders'
import { getSchedule, requestStep, waiveDeposit } from './schedule'

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

  app.post('/sales/orders/:orderId/copy-as-quote', { schema: copyOrderAsQuoteContract }, async (request, reply) => {
    const order = await officeOrder(request, request.params.orderId)
    return reply.code(201).send(await copyOrderAsQuote(request, order, request.body, idempotencyKeyFrom(request)))
  })
})
