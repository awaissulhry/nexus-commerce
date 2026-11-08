import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { appClock } from '../../../platform/portal/tasks/clock'
import { approveAddress, listAddressChecks, refuseAddress } from './address-check'
import { addAddress, archiveAddress, defaultAddress, listAddresses } from './addresses'
import { browseCatalogue, catalogueStyle } from './browse'
import {
  acceptContract,
  addAddressContract,
  addLinesContract,
  addressesContract,
  addressMoveContract,
  addressChecksContract,
  approveAddressContract,
  refuseAddressContract,
  catalogueContract,
  catalogueStyleContract,
  changeLineContract,
  changeRequestContract,
  createRequestContract,
  discardContract,
  getRequestContract,
  listRequestsContract,
  officeGetContract,
  officeListContract,
  pastOrderContract,
  pastOrdersContract,
  pricesContract,
  refuseContract,
  removeLineContract,
  reorderContract,
  sendContract,
  templateContract,
  uploadContract,
  withdrawContract,
} from './contract'
import { manifest } from './manifest'
import { acceptRequest, listOfficeRequests, officeRequestView, refuseRequest } from './office'
import { pastOrder, pastOrders, reorderInto } from './reorder'
import { addLines, changeHeader, changeLine, createDraft, discardDraft, getRequest, listRequests, removeLine, sendRequest, takeTodaysPrices, withdrawRequest } from './requests'
import { orderTemplate, uploadSheet } from './upload'

/**
 * Portal ordering (B-W2b-190; SAL-071 customer catalogue, SAL-072 reorder at today's prices, SAL-073 order upload with a
 * dry run, SAL-074 portal orders arrive as requests, SAL-079 ship-to addresses self-service; design
 * portal.customer.catalogue, portal.customer.neworder, portal.customer.account › Delivery addresses, home.approvals). The
 * screens are B-W2b-194 (New order & reorder, Catalogue) and B-W2b-196 (Account); Home › Approvals reads the office's
 * waiting requests through modules/insights/sources/portal-order-requests.ts.
 */
export default defineRoutes('portal-ordering', manifest, async (app) => {
  // The catalogue.
  app.get('/portal/catalogue', { schema: catalogueContract }, async (request) => browseCatalogue(app, request, request.query))
  app.get('/portal/catalogue/:styleId', { schema: catalogueStyleContract }, async (request) => catalogueStyle(app, request, request.params.styleId))

  // Order requests.
  app.get('/portal/order-requests', { schema: listRequestsContract }, async (request) => listRequests(app, request, request.query))
  app.post('/portal/order-requests', { schema: createRequestContract }, async (request, reply) => reply.code(201).send(await createDraft(app, request, request.body, idempotencyKeyFrom(request))))
  app.get('/portal/order-requests/:requestId', { schema: getRequestContract }, async (request) => getRequest(app, request, request.params.requestId))
  app.patch('/portal/order-requests/:requestId', { schema: changeRequestContract }, async (request) => changeHeader(app, request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.delete('/portal/order-requests/:requestId', { schema: discardContract }, async (request) => discardDraft(app, request, request.params.requestId, request.query.version, idempotencyKeyFrom(request)))
  app.post('/portal/order-requests/:requestId/lines', { schema: addLinesContract }, async (request) => addLines(app, request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.put('/portal/order-requests/:requestId/lines/:lineId', { schema: changeLineContract }, async (request) => changeLine(app, request, request.params.requestId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.delete('/portal/order-requests/:requestId/lines/:lineId', { schema: removeLineContract }, async (request) => removeLine(app, request, request.params.requestId, request.params.lineId, request.query.version, idempotencyKeyFrom(request)))
  app.post('/portal/order-requests/:requestId/prices', { schema: pricesContract }, async (request) => takeTodaysPrices(app, request, request.params.requestId, request.body.version, idempotencyKeyFrom(request)))
  app.post('/portal/order-requests/:requestId/send', { schema: sendContract }, async (request) => sendRequest(app, request, request.params.requestId, request.body.version, idempotencyKeyFrom(request)))
  app.post('/portal/order-requests/:requestId/withdraw', { schema: withdrawContract }, async (request) => withdrawRequest(app, request, request.params.requestId, request.body.version, idempotencyKeyFrom(request)))

  // Reorder.
  app.get('/portal/reorder/orders', { schema: pastOrdersContract }, async (request) => pastOrders(app, request, request.query))
  app.get('/portal/reorder/orders/:orderId', { schema: pastOrderContract }, async (request) => pastOrder(app, request, request.params.orderId))
  app.post('/portal/order-requests/:requestId/reorder', { schema: reorderContract }, async (request) => reorderInto(app, request, request.params.requestId, request.body, idempotencyKeyFrom(request)))

  // Upload.
  app.get('/portal/order-template', { schema: templateContract }, async (request, reply) => {
    const file = await orderTemplate(app, request, request.query)
    return reply.type(file.contentType).header('content-disposition', `attachment; filename="${file.name}"`).send(file.body)
  })
  app.post('/portal/order-requests/:requestId/upload', { schema: uploadContract }, async (request) => uploadSheet(app, request, request.params.requestId, request.body, idempotencyKeyFrom(request)))

  // Delivery addresses.
  app.get('/portal/addresses', { schema: addressesContract }, async (request) => listAddresses(app, request))
  app.post('/portal/addresses', { schema: addAddressContract }, async (request, reply) => reply.code(201).send(await addAddress(app, request, request.body, idempotencyKeyFrom(request))))
  app.post('/portal/addresses/:addressId/archive', { schema: addressMoveContract }, async (request) => archiveAddress(app, request, request.params.addressId, request.body.version, idempotencyKeyFrom(request)))
  app.post('/portal/addresses/:addressId/default', { schema: addressMoveContract }, async (request) => defaultAddress(app, request, request.params.addressId, request.body.version, idempotencyKeyFrom(request)))

  // The office.
  app.get('/sales/order-requests', { schema: officeListContract }, async (request) => listOfficeRequests(request, request.query))
  app.get('/sales/order-requests/:requestId', { schema: officeGetContract }, async (request) => officeRequestView(request, request.params.requestId))
  app.post('/sales/order-requests/:requestId/accept', { schema: acceptContract }, async (request) => acceptRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request), appClock(app)))
  app.post('/sales/order-requests/:requestId/refuse', { schema: refuseContract }, async (request) => refuseRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))

  // B-W2b-F13b: the office's check of the delivery addresses customers add in the portal.
  app.get('/sales/delivery-addresses', { schema: addressChecksContract }, async (request) => listAddressChecks(request, request.query))
  app.post('/sales/delivery-addresses/:addressId/approve', { schema: approveAddressContract }, async (request) => approveAddress(request, request.params.addressId, request.body, idempotencyKeyFrom(request), appClock(app)))
  app.post('/sales/delivery-addresses/:addressId/refuse', { schema: refuseAddressContract }, async (request) => refuseAddress(request, request.params.addressId, request.body, idempotencyKeyFrom(request), appClock(app)))
})
