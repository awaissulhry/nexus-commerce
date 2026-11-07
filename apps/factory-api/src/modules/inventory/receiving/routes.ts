import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { getExpectedOrderContract, getFloorReceiptContract, listExpectedContract, printTagsContract, receiveOnFloorContract } from './contract'
import { manifest } from './manifest'
import { expectedOrder, getFloorReceipt, listExpected } from './read'
import { printTagsAgain, receiveOnFloor } from './receive'
// B-W2b-182: the inbound board and receiving from a ship notice (the office).
import { dockNoteContract, inboundContract, officeNoticeContract } from '../../purchasing/ship-notices/contract'
import { inbound, officeNotice, setDockNote } from './from-ship-notice'

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

  // B-W2b-182 (SCM-110): the inbound board; a ship notice with the receipt prefilled from it (SCM-106); our dock note.
  app.get('/inventory/receiving/inbound', { schema: inboundContract }, async (request) => inbound(request, request.query, new Date()))

  app.get('/inventory/receiving/ship-notices/:shipNoticeId', { schema: officeNoticeContract }, async (request) => officeNotice(request, request.params.shipNoticeId, new Date()))

  app.patch('/inventory/receiving/ship-notices/:shipNoticeId', { schema: dockNoteContract }, async (request) => setDockNote(request, request.params.shipNoticeId, request.body, idempotencyKeyFrom(request)))
})
