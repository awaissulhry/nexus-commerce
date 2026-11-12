import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { askBuyerContract, detailContract, floorGetContract, itemsContract, nameOrderContract, receiveContract, sendBackContract, startContract } from './contract'
import { getFloorUnplanned, receiveUnplanned, unplannedItems, unplannedStart } from './floor'
import { manifest } from './manifest'
import { askBuyerAgain, nameOrder, sendBack, unplannedDetail } from './office'

/**
 * Goods without a purchase order (B-W2b-300; SCM-122): taken in on the goods-in tablet to a holding place, a buyer's task asks
 * for the order or a return; named, they post as every receipt posts; sent back, the receipt is cancelled with why.
 */
export default defineRoutes('inventory.unplanned', manifest, async (app) => {
  app.get('/inventory/receiving/unplanned/start', { schema: startContract }, async (request) => unplannedStart(request, request.query))

  app.get('/inventory/receiving/unplanned/items', { schema: itemsContract }, async (request) => unplannedItems(request, request.query))

  app.post('/inventory/receiving/unplanned', { schema: receiveContract }, async (request, reply) => reply.code(201).send(await receiveUnplanned(request, request.body, idempotencyKeyFrom(request))))

  app.get('/inventory/receiving/unplanned/:receiptId', { schema: floorGetContract }, async (request) => getFloorUnplanned(request, request.params.receiptId))

  app.get('/inventory/unplanned/:receiptId', { schema: detailContract }, async (request) => unplannedDetail(request, request.params.receiptId))

  app.post('/inventory/unplanned/:receiptId/order', { schema: nameOrderContract }, async (request) => nameOrder(request, request.params.receiptId, request.body, idempotencyKeyFrom(request)))

  app.post('/inventory/unplanned/:receiptId/return', { schema: sendBackContract }, async (request) => sendBack(request, request.params.receiptId, request.body, idempotencyKeyFrom(request)))

  app.post('/inventory/unplanned/:receiptId/buyer', { schema: askBuyerContract }, async (request) => askBuyerAgain(request, request.params.receiptId, request.body, idempotencyKeyFrom(request)))
})
