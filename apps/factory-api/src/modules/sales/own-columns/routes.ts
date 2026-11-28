import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { closeColumnContract, officeColumnsContract, officeNewColumnContract, orderColumnsContract, portalColumnsContract, portalNewColumnContract, requestColumnsContract, valueContract } from './contract'
import {
  officeCloseColumn,
  officeCreateColumn,
  officeListColumns,
  officeSetValue,
  officeUseOnOrder,
  officeUseOnRequest,
  portalCloseColumn,
  portalCreateColumn,
  portalListColumns,
  portalSetValue,
  portalUseOnOrder,
  portalUseOnRequest,
} from './commands'
import { manifest } from './manifest'

/**
 * The customer's own columns (owb- order workflow, S1 po1.4; design § 5zi C "Columns of your own"): the customer's columns, the
 * columns on one draft or order, a value on one line — the portal's and the office's twins (./commands.ts says every rule). The
 * reads of the columns on records are ./read.ts ownColumnsOf (the draft record, the portal order record, the sheet; S2, S5).
 */
export default defineRoutes('sales-own-columns', manifest, async (app) => {
  app.get('/portal/own-columns', { schema: portalColumnsContract }, async (request) => portalListColumns(app, request))
  app.post('/portal/own-columns', { schema: portalNewColumnContract }, async (request, reply) => reply.code(201).send(await portalCreateColumn(app, request, request.body, idempotencyKeyFrom(request))))
  app.post('/portal/own-columns/:columnId/close', { schema: closeColumnContract }, async (request) => portalCloseColumn(app, request, request.params.columnId, request.body.version, idempotencyKeyFrom(request)))
  app.put('/portal/order-requests/:requestId/own-columns', { schema: requestColumnsContract }, async (request) => portalUseOnRequest(app, request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.put('/portal/sales-orders/:orderId/own-columns', { schema: orderColumnsContract }, async (request) => portalUseOnOrder(app, request, request.params.orderId, request.body, idempotencyKeyFrom(request)))
  app.put('/portal/own-values', { schema: valueContract }, async (request) => portalSetValue(app, request, request.body, idempotencyKeyFrom(request)))

  // The office's twins.
  app.get('/sales/own-columns', { schema: officeColumnsContract }, async (request) => officeListColumns(app, request, request.query.partyId))
  app.post('/sales/own-columns', { schema: officeNewColumnContract }, async (request, reply) => reply.code(201).send(await officeCreateColumn(app, request, request.body, idempotencyKeyFrom(request))))
  app.post('/sales/own-columns/:columnId/close', { schema: closeColumnContract }, async (request) => officeCloseColumn(app, request, request.params.columnId, request.body.version, idempotencyKeyFrom(request)))
  app.put('/sales/order-requests/:requestId/own-columns', { schema: requestColumnsContract }, async (request) => officeUseOnRequest(app, request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.put('/sales/orders/:orderId/own-columns', { schema: orderColumnsContract }, async (request) => officeUseOnOrder(app, request, request.params.orderId, request.body, idempotencyKeyFrom(request)))
  app.put('/sales/own-values', { schema: valueContract }, async (request) => officeSetValue(app, request, request.body, idempotencyKeyFrom(request)))
})
