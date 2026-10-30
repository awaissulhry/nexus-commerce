import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { getExpectedOrderContract, getFloorReceiptContract, listExpectedContract, printTagsContract, receiveOnFloorContract } from './contract'
import { manifest } from './manifest'
import { expectedOrder, getFloorReceipt, listExpected } from './read'
import { printTagsAgain, receiveOnFloor } from './receive'

/**
 * Receiving goods on a goods-in tablet (B-W1-33; A2 SCR-092): what the site expects, one order's open lines, the receipt
 * (hides one by one into lots, held for quality where they must be), its hide tags on the station's label printer.
 */
export default defineRoutes('inventory.receiving', manifest, async (app) => {
  app.get('/inventory/receiving/orders', { schema: listExpectedContract }, async (request) => listExpected(request, request.query))

  app.get('/inventory/receiving/orders/:orderId', { schema: getExpectedOrderContract }, async (request) => expectedOrder(request, request.params.orderId))

  app.post('/inventory/receiving/orders/:orderId/receipts', { schema: receiveOnFloorContract }, async (request, reply) =>
    reply.code(201).send(await receiveOnFloor(request, request.params.orderId, request.body, idempotencyKeyFrom(request))),
  )

  app.get('/inventory/receiving/receipts/:receiptId', { schema: getFloorReceiptContract }, async (request) => getFloorReceipt(request, request.params.receiptId))

  app.post('/inventory/receiving/receipts/:receiptId/tags', { schema: printTagsContract }, async (request) => printTagsAgain(request, request.params.receiptId, request.body, idempotencyKeyFrom(request)))
})
