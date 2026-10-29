import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { expectedContract, getReceiptContract, listReceiptsContract, receiptLotsContract, recordReceiptContract, reverseReceiptContract } from './contract'
import { manifest } from './manifest'
import { expectedLines, getReceipt, listReceipts, receiptLots } from './read'
import { recordReceipt } from './record'
import { reverseReceipt } from './reverse'

/**
 * Goods receipts against a purchase order (B-W1-32): record one (the receipt, its lots and hides one by one, its moves
 * posted and valued through the ledger's postMoves, the order moved on, in ONE command: ./record.ts), the list, the
 * record, its lots with every hide, the order lines still expected, and the reversal of a posted receipt while its stock
 * is untouched (./reverse.ts). The quality step (B-W1-34) releases a lot; the floor receives through B-W1-33.
 */
export default defineRoutes('inventory.receipts', manifest, async (app) => {
  app.get('/inventory/receipts', { schema: listReceiptsContract }, async (request) => listReceipts(request, request.query))

  app.get('/inventory/receipts/expected', { schema: expectedContract }, async (request) => expectedLines(request, request.query))

  app.get('/inventory/receipts/:receiptId', { schema: getReceiptContract }, async (request) => getReceipt(request, request.params.receiptId))

  app.get('/inventory/receipts/:receiptId/lots', { schema: receiptLotsContract }, async (request) => receiptLots(request, request.params.receiptId))

  app.post('/inventory/receipts', { schema: recordReceiptContract }, async (request, reply) => reply.code(201).send(await recordReceipt(request, request.body, idempotencyKeyFrom(request))))

  app.post('/inventory/receipts/:receiptId/reverse', { schema: reverseReceiptContract }, async (request, reply) =>
    reply.code(201).send(await reverseReceipt(request, request.params.receiptId, request.body, idempotencyKeyFrom(request))),
  )
})
