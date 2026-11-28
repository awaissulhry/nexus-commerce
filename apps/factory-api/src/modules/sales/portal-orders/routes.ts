import { defineRoutes } from '../../../core/manifest'
import { appClock } from '../../../platform/portal/tasks/clock'
import { listContract, progressContract, recordContract, shipmentsContract } from './contract'
import { manifest } from './manifest'
import { listOrders, orderRecord } from './orders'
import { orderProgressView } from './progress'
import { orderShipments } from './shipments'
// B-TH-061: the customer's own sheet and its "Download all".
import { sheetContract, sheetDownloadContract } from './contract'
import { orderSheet, orderSheetFile } from './sheet'
import { attachmentDisposition } from '../../../platform/files/rules'
// B-SA-037: the order's files shared with the customer.
import { portalOrderFiles, portalOrderFilesContract } from './files'
// B-CP-019: the customer's own price check and its line prices.
import { idempotencyKeyFrom } from '../../../core/command'
import { portalPriceCheckContract, portalSaveBrandPricesContract } from '../brand-prices/contract'
import { readPortalPriceCheck, savePortalBrandPrices } from '../brand-prices/portal'
// pg-s2 S2.1: the small pictures of the customer's own orders (a read POST).
import { picturesContract } from './contract'
import { orderPictures } from './pictures'
// owb- (order workflow, b3.1 + b3.2): the order log (the customer's face) and the order's picture.
import { orderPictureContract, portalOrderLogContract, portalRequestLogContract, requestPictureContract } from '../orders/log-contract'
import { setPortalOrderPicture, setRequestPicture } from '../orders/picture-set'
import { portalWriter } from '../portal-ordering/writer'
import { portalOrderLog, portalRequestLog } from './log'

/**
 * Customer orders in the portal (B-W2b-175; SAL-075 status in customer words, SAL-076 production progress per customer
 * switch, SAL-080 shipments and tracking, SAL-081 open lines and backorders; design portal.customer.orders, the screens
 * are B-W2b-191's and Home's B-W2b-187's). Home's counts are ./home.ts (platform/portal/home/sources).
 */
export default defineRoutes('portal-sales-orders', manifest, async (app) => {
  app.get('/portal/sales-orders', { schema: listContract }, async (request) => listOrders(app, request, request.query, appClock(app).now()))

  // ---- B-TH-061
  app.get('/portal/sales-orders/sheet', { schema: sheetContract }, async (request) => orderSheet(app, request, request.query, appClock(app).now()))
  app.get('/portal/sales-orders/sheet/download', { schema: sheetDownloadContract }, async (request, reply) => {
    const file = await orderSheetFile(app, request, request.query, appClock(app).now())
    return reply.type(file.contentType).header('content-disposition', attachmentDisposition(file.fileName)).header('cache-control', 'no-store').send(Buffer.from(file.bytes))
  })
  // ---- end B-TH-061

  // pg-s2 S2.1 (portal grid D4, Z12): the small pictures of the customer's own orders among the ids (another's: absent).
  app.post('/portal/sales-orders/pictures', { schema: picturesContract }, async (request) => orderPictures(app, request, request.body.orderIds, appClock(app).now()))

  app.get('/portal/sales-orders/:orderId', { schema: recordContract }, async (request) => orderRecord(app, request, request.params.orderId, appClock(app).now()))

  app.get('/portal/sales-orders/:orderId/progress', { schema: progressContract }, async (request) => orderProgressView(app, request, request.params.orderId, appClock(app).now()))

  app.get('/portal/sales-orders/:orderId/shipments', { schema: shipmentsContract }, async (request) => orderShipments(app, request, request.params.orderId, appClock(app).now()))

  // B-SA-037 (Sales page plan N9, P14): the order's Documents tab, grouped as the office's Files tab.
  app.get('/portal/sales-orders/:orderId/files', { schema: portalOrderFilesContract }, async (request) => portalOrderFiles(app, request, request.params.orderId, appClock(app).now()))

  // ---- B-CP-019 (customer page plan C3, D2, D3): the customer's price check, and its own line prices (one command).
  app.get('/portal/sales-orders/:orderId/price-check', { schema: portalPriceCheckContract }, async (request) => readPortalPriceCheck(app, request, request.params.orderId))
  app.put('/portal/sales-orders/:orderId/brand-prices', { schema: portalSaveBrandPricesContract }, async (request) => savePortalBrandPrices(app, request, request.params.orderId, request.body, idempotencyKeyFrom(request)))
  // ---- end B-CP-019

  // ---- owb- (order workflow, b3.1 + b3.2): the order log in the customer's face, and the order's picture (both records).
  app.get('/portal/sales-orders/:orderId/log', { schema: portalOrderLogContract }, async (request) => portalOrderLog(app, request, request.params.orderId, request.query))
  app.get('/portal/order-requests/:requestId/log', { schema: portalRequestLogContract }, async (request) => portalRequestLog(app, request, request.params.requestId, request.query))
  app.post('/portal/order-requests/:requestId/picture', { schema: requestPictureContract }, async (request) => setRequestPicture(portalWriter(app, request), request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.post('/portal/sales-orders/:orderId/picture', { schema: orderPictureContract }, async (request) => setPortalOrderPicture(app, request, request.params.orderId, request.body, idempotencyKeyFrom(request)))
  // ---- end owb-
})
