import { defineRoutes } from '../../../core/manifest'
import { appClock } from '../../../platform/portal/tasks/clock'
import { inTransitContract, listContract, progressContract, recordContract, shipmentsContract } from './contract'
import { manifest } from './manifest'
import { listOrders, orderRecord } from './orders'
import { orderProgressView } from './progress'
import { inTransit, orderShipments } from './shipments'

/**
 * Customer orders in the portal (B-W2b-175; SAL-075 status in customer words, SAL-076 production progress per customer
 * switch, SAL-080 shipments and tracking, SAL-081 open lines and backorders; design portal.customer.orders, the screens
 * are B-W2b-191's and Home's B-W2b-187's). Home's counts are ./home.ts (platform/portal/home/sources).
 */
export default defineRoutes('portal-sales-orders', manifest, async (app) => {
  app.get('/portal/sales-orders', { schema: listContract }, async (request) => listOrders(app, request, request.query, appClock(app).now()))

  app.get('/portal/sales-orders/in-transit', { schema: inTransitContract }, async (request) => inTransit(app, request, appClock(app).now()))

  app.get('/portal/sales-orders/:orderId', { schema: recordContract }, async (request) => orderRecord(app, request, request.params.orderId, appClock(app).now()))

  app.get('/portal/sales-orders/:orderId/progress', { schema: progressContract }, async (request) => orderProgressView(app, request, request.params.orderId, appClock(app).now()))

  app.get('/portal/sales-orders/:orderId/shipments', { schema: shipmentsContract }, async (request) => orderShipments(app, request, request.params.orderId, appClock(app).now()))
})
