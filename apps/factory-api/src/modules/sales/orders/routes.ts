import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { boardContract, cancelContract, closeContract, getOrderContract, listOrdersContract, makeOrderContract, promiseContract, readyContract } from './contract'
import { manifest } from './manifest'
import { cancelOrder, changePromise, closeOrder, markReady } from './moves'
import { getOrder, listOrders, makeOrder, orderBoard } from './orders'

/**
 * Sales orders from the accepted quote (B-W1-25; SAL-200, SAL-203, SAL-204, SAL-206, SAL-214; A2 SCR-038, SCR-039): the
 * list, the board's counts by state and its tiles, the record (lines and size grids with per-size progress, dates, the
 * record chain, the settlement), the order of an accepted version when the acceptance could not make it, and the moves a
 * person makes: a new promise date, ready by hand, cancel, close. The order itself is made at acceptance
 * (quotes/after-acceptance); production, shipments and the settlement move it through the worker's handlers
 * (./handlers).
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
})
