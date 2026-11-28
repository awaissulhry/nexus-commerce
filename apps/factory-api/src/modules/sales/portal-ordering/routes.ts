import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { appClock } from '../../../platform/portal/tasks/clock'
import { approveAddress, listAddressChecks, refuseAddress } from './address-check'
import { addAddress, archiveAddress, defaultAddress, listAddresses } from './addresses'
import { browseCatalogue, catalogueStyle } from './browse'
import {
  acceptContract,
  addAddressContract,
  announceDraftFileContract,
  completeDraftFileContract,
  removeDraftFileContract,
  moveDraftFileContract, // od-ts t.6
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
  takeBackContract, // owb- po1.2
  // B-CP-075: described and made-to-measure lines, and the people of a by-person line.
  addCustomLineContract,
  changeCustomLineContract,
  addPeopleContract,
  changePersonContract,
  removePersonContract,
  orderRequestPicturesContract, // B-CQ-030
  officeStartContract, // od-s s.3
  officeDraftContract,
  styleDraftContract,
  confirmContract, // od-s s.4
} from './contract'
import { manifest } from './manifest'
import { portalWriter } from './writer' // od-s s.2: the portal's draft commands take the portal's writer
// od-s s.3: the office's door to a customer's draft (the SAME commands through the office writer), and Make style draft.
import { officeMoveFile } from './office-drafts' // od-ts t.6
import { officeAddCustomLine, officeAddPeople, officeAnnounceFile, officeChangeCustomLine, officeChangeHeader, officeChangeLine, officeChangePerson, officeCompleteFile, officeDiscard, officeDraftView, officeRemoveFile, officeRemoveLine, officeRemovePerson, officeStartDraft } from './office-drafts'
import { styleDraftOfRequest } from './style-draft'
import { acceptRequest, confirmRequest, listOfficeRequests, officeRequestView, refuseRequest } from './office'
import { pastOrder, pastOrders, reorderInto } from './reorder'
import { addLines, changeHeader, changeLine, createDraft, getRequest, listRequests, sendRequest, takeTodaysPrices, withdrawRequest } from './requests'
import { takeBackRequest } from './requests' // owb- po1.2
import { addCustomLine, addPeople, changeCustomLine, changePerson, removePerson } from './requests' // B-CP-075
// B-CP-072: the draft's files; a discarded draft and a line taken out take theirs with them.
import { announceDraftFile, completeDraftFile, discardDraftWithFiles, moveDraftFile, removeDraftFile, removeLineWithFiles } from './draft-files'
import { orderTemplate, uploadSheet } from './upload'
// B-W2b-374 (XF3:04): an option's artwork in the portal.
import { processFiles } from '../../../platform/files/service'
import { openArtworkContract, openPortalArtwork, portalOptionsContract, portalOrderOptions, shareArtworkContract, shareOrderArtwork } from './artwork'
// B-CQ-030: the portal orders' small pictures (the one picture helper).
import { recordPictures } from '../../product/images/small-pictures'

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
  app.get('/portal/order-requests', { schema: listRequestsContract }, async (request) => listRequests(portalWriter(app, request), request.query))
  app.post('/portal/order-requests', { schema: createRequestContract }, async (request, reply) => reply.code(201).send(await createDraft(portalWriter(app, request), request.body, idempotencyKeyFrom(request))))
  app.get('/portal/order-requests/:requestId', { schema: getRequestContract }, async (request) => getRequest(portalWriter(app, request), request.params.requestId))
  app.patch('/portal/order-requests/:requestId', { schema: changeRequestContract }, async (request) => changeHeader(portalWriter(app, request), request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.delete('/portal/order-requests/:requestId', { schema: discardContract }, async (request) => discardDraftWithFiles(processFiles, portalWriter(app, request), request.params.requestId, request.query.version, idempotencyKeyFrom(request)))
  app.post('/portal/order-requests/:requestId/lines', { schema: addLinesContract }, async (request) => addLines(portalWriter(app, request), request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.put('/portal/order-requests/:requestId/lines/:lineId', { schema: changeLineContract }, async (request) => changeLine(portalWriter(app, request), request.params.requestId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.delete('/portal/order-requests/:requestId/lines/:lineId', { schema: removeLineContract }, async (request) => removeLineWithFiles(processFiles, portalWriter(app, request), request.params.requestId, request.params.lineId, request.query.version, idempotencyKeyFrom(request)))
  app.post('/portal/order-requests/:requestId/prices', { schema: pricesContract }, async (request) => takeTodaysPrices(portalWriter(app, request), request.params.requestId, request.body.version, idempotencyKeyFrom(request)))
  // B-CP-072: the draft's files.
  app.post('/portal/order-requests/:requestId/files', { schema: announceDraftFileContract }, async (request, reply) => reply.code(201).send(await announceDraftFile(processFiles(), portalWriter(app, request), request.params.requestId, request.body, idempotencyKeyFrom(request))))
  app.post('/portal/order-requests/:requestId/files/:fileId/complete', { schema: completeDraftFileContract }, async (request) => completeDraftFile(processFiles(), portalWriter(app, request), request.params.requestId, request.params.fileId, idempotencyKeyFrom(request)))
  app.delete('/portal/order-requests/:requestId/files/:fileId', { schema: removeDraftFileContract }, async (request) => removeDraftFile(processFiles(), portalWriter(app, request), request.params.requestId, request.params.fileId, request.query.version, idempotencyKeyFrom(request)))
  // od-ts t.6: the "Logo" toggle — a file moved between the draft's logos and references.
  app.patch('/portal/order-requests/:requestId/files/:fileId', { schema: moveDraftFileContract }, async (request) => moveDraftFile(portalWriter(app, request), request.params.requestId, request.params.fileId, request.body, idempotencyKeyFrom(request)))
  // B-CP-075: described and made-to-measure lines (a line out: DELETE …/lines/:lineId), and the people of a by-person line.
  app.post('/portal/order-requests/:requestId/custom-lines', { schema: addCustomLineContract }, async (request) => addCustomLine(portalWriter(app, request), request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.put('/portal/order-requests/:requestId/custom-lines/:lineId', { schema: changeCustomLineContract }, async (request) => changeCustomLine(portalWriter(app, request), request.params.requestId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.post('/portal/order-requests/:requestId/lines/:lineId/people', { schema: addPeopleContract }, async (request) => addPeople(portalWriter(app, request), request.params.requestId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.put('/portal/order-requests/:requestId/lines/:lineId/people/:personId', { schema: changePersonContract }, async (request) =>
    changePerson(portalWriter(app, request), request.params.requestId, request.params.lineId, request.params.personId, request.body, idempotencyKeyFrom(request)),
  )
  app.delete('/portal/order-requests/:requestId/lines/:lineId/people/:personId', { schema: removePersonContract }, async (request) =>
    removePerson(portalWriter(app, request), request.params.requestId, request.params.lineId, request.params.personId, request.query.version, idempotencyKeyFrom(request)),
  )
  app.post('/portal/order-requests/:requestId/send', { schema: sendContract }, async (request) => sendRequest(app, request, request.params.requestId, request.body.version, idempotencyKeyFrom(request)))
  app.post('/portal/order-requests/:requestId/withdraw', { schema: withdrawContract }, async (request) => withdrawRequest(app, request, request.params.requestId, request.body.version, idempotencyKeyFrom(request)))
  // owb- po1.2 (order workflow): Take it back — a SENT request back to its DRAFT before the factory answered or started work on it.
  app.post('/portal/order-requests/:requestId/take-back', { schema: takeBackContract }, async (request) => takeBackRequest(app, request, request.params.requestId, request.body.version, idempotencyKeyFrom(request)))

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
  // od-s s.3 (order start): the office's twins of the draft's routes (13-backend § 4), the same bodies and answers as the portal's.
  app.post('/sales/order-requests', { schema: officeStartContract }, async (request, reply) => reply.code(201).send(await officeStartDraft(app, request, request.body, idempotencyKeyFrom(request))))
  app.get('/sales/order-requests/:requestId/draft', { schema: officeDraftContract }, async (request) => officeDraftView(app, request, request.params.requestId))
  app.patch('/sales/order-requests/:requestId', { schema: changeRequestContract }, async (request) => officeChangeHeader(app, request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.delete('/sales/order-requests/:requestId', { schema: discardContract }, async (request) => officeDiscard(processFiles, app, request, request.params.requestId, request.query.version, idempotencyKeyFrom(request)))
  app.post('/sales/order-requests/:requestId/custom-lines', { schema: addCustomLineContract }, async (request) => officeAddCustomLine(app, request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.put('/sales/order-requests/:requestId/custom-lines/:lineId', { schema: changeCustomLineContract }, async (request) => officeChangeCustomLine(app, request, request.params.requestId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.put('/sales/order-requests/:requestId/lines/:lineId', { schema: changeLineContract }, async (request) => officeChangeLine(app, request, request.params.requestId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.delete('/sales/order-requests/:requestId/lines/:lineId', { schema: removeLineContract }, async (request) => officeRemoveLine(processFiles, app, request, request.params.requestId, request.params.lineId, request.query.version, idempotencyKeyFrom(request)))
  app.post('/sales/order-requests/:requestId/lines/:lineId/people', { schema: addPeopleContract }, async (request) => officeAddPeople(app, request, request.params.requestId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.put('/sales/order-requests/:requestId/lines/:lineId/people/:personId', { schema: changePersonContract }, async (request) =>
    officeChangePerson(app, request, request.params.requestId, request.params.lineId, request.params.personId, request.body, idempotencyKeyFrom(request)),
  )
  app.delete('/sales/order-requests/:requestId/lines/:lineId/people/:personId', { schema: removePersonContract }, async (request) =>
    officeRemovePerson(app, request, request.params.requestId, request.params.lineId, request.params.personId, request.query.version, idempotencyKeyFrom(request)),
  )
  app.post('/sales/order-requests/:requestId/files', { schema: announceDraftFileContract }, async (request, reply) => reply.code(201).send(await officeAnnounceFile(processFiles(), app, request, request.params.requestId, request.body, idempotencyKeyFrom(request))))
  app.post('/sales/order-requests/:requestId/files/:fileId/complete', { schema: completeDraftFileContract }, async (request) => officeCompleteFile(processFiles(), app, request, request.params.requestId, request.params.fileId, idempotencyKeyFrom(request)))
  app.delete('/sales/order-requests/:requestId/files/:fileId', { schema: removeDraftFileContract }, async (request) => officeRemoveFile(processFiles(), app, request, request.params.requestId, request.params.fileId, request.query.version, idempotencyKeyFrom(request)))
  app.patch('/sales/order-requests/:requestId/files/:fileId', { schema: moveDraftFileContract }, async (request) => officeMoveFile(app, request, request.params.requestId, request.params.fileId, request.body, idempotencyKeyFrom(request))) // od-ts t.6
  app.post('/sales/order-requests/:requestId/style-draft', { schema: styleDraftContract }, async (request) => styleDraftOfRequest(app, request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  // od-s s.4: Confirm — send (if still a draft) + accept, in one command (13-backend § 5).
  app.post('/sales/order-requests/:requestId/confirm', { schema: confirmContract }, async (request) => confirmRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request), appClock(app)))
  // B-CQ-030 (customer page › Quotes & incoming): a page of portal orders' pictures in one read (drafts too); absent ids say nothing.
  app.post('/sales/order-requests/pictures', { schema: orderRequestPicturesContract }, async (request) => recordPictures(request, 'portalOrder', request.body.requestIds))

  // B-W2b-F13b: the office's check of the delivery addresses customers add in the portal.
  app.get('/sales/delivery-addresses', { schema: addressChecksContract }, async (request) => listAddressChecks(request, request.query))
  app.post('/sales/delivery-addresses/:addressId/approve', { schema: approveAddressContract }, async (request) => approveAddress(request, request.params.addressId, request.body, idempotencyKeyFrom(request), appClock(app)))
  app.post('/sales/delivery-addresses/:addressId/refuse', { schema: refuseAddressContract }, async (request) => refuseAddress(request, request.params.addressId, request.body, idempotencyKeyFrom(request), appClock(app)))

  // B-W2b-374 (XF3:04): an option's artwork in the portal.
  app.put('/sales/orders/:orderId/lines/:lineId/artwork/:fileId/portal', { schema: shareArtworkContract }, async (request) =>
    shareOrderArtwork(request, request.params.orderId, request.params.lineId, request.params.fileId, request.body, idempotencyKeyFrom(request)),
  )
  app.get('/portal/sales-orders/:orderId/options', { schema: portalOptionsContract }, async (request) => portalOrderOptions(app, request, request.params.orderId))
  app.post('/portal/sales-orders/:orderId/artwork/:fileId/open', { schema: openArtworkContract }, async (request) =>
    openPortalArtwork(app, processFiles(), request, request.params.orderId, request.params.fileId, request.body, idempotencyKeyFrom(request)),
  )
})
