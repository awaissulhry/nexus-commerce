import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  addLinesContract,
  announceLinePhotoContract,
  announceReceiptPhotoContract,
  cancelContract,
  changeLineContract,
  closeContract,
  completeLinePhotoContract,
  completeReceiptPhotoContract,
  countsContract,
  createContract,
  decideContract,
  findDockContract,
  getContract,
  getDockContract,
  getPolicyContract,
  gradeContract,
  headerContract,
  listContract,
  previewContract,
  previewDecisionsContract,
  receiveContract,
  removeLineContract,
  replacementContract,
  returnableContract,
  savePolicyContract,
} from './contract'
import { decideReturn, previewDecisions } from './decide'
import { findAtDock, getDock, gradeReturn, receiveReturn } from './dock'
import { listReturns, returnCounts } from './list'
import { manifest } from './manifest'
import { announceLinePhoto, announceReceiptPhoto, completeLinePhoto, completeReceiptPhoto } from './photos'
import { getPolicy, savePolicy } from './policy'
import { makeReplacementOrder } from './replacement'
import { listReturnable } from './returnable'
import { addLines, cancelReturn, changeHeader, changeLine, closeReturn, createReturn, getReturn, previewReturn, removeLine } from './rma'

/**
 * Customer returns of B-W2a-43: the list and its tiles (./list.ts), the return policy (./policy.ts), what may come back
 * (./returnable.ts), the RMA and its lines, header, cancel and close (./rma.ts), the dock's find, receipt and grading
 * (./dock.ts) with photos (./photos.ts), the decision (./decide.ts) and the replacement order (./replacement.ts). The
 * return DDT of goods sent back unchanged is shipping's (POST /shipping/ddt-sources/ReturnAuthorisation/:id/ddt).
 */
export default defineRoutes('sales.returns', manifest, async (app) => {
  app.get('/sales/returns', { schema: listContract }, async (request) => listReturns(request, request.query))
  app.get('/sales/returns/counts', { schema: countsContract }, async (request) => returnCounts(request))
  app.get('/sales/returns/policy', { schema: getPolicyContract }, async (request) => getPolicy(request, request.query))
  app.put('/sales/returns/policy', { schema: savePolicyContract }, async (request) => savePolicy(request, request.body, idempotencyKeyFrom(request)))
  app.get('/sales/returns/returnable', { schema: returnableContract }, async (request) => listReturnable(request, request.query))
  app.post('/sales/returns/preview', { schema: previewContract }, async (request) => previewReturn(request, request.body))
  app.post('/sales/returns', { schema: createContract }, async (request, reply) => reply.code(201).send(await createReturn(request, request.body, idempotencyKeyFrom(request))))
  app.get('/sales/returns/dock', { schema: findDockContract }, async (request) => findAtDock(request, request.query.code))

  app.get('/sales/returns/:returnId', { schema: getContract }, async (request) => getReturn(request, request.params.returnId))
  app.patch('/sales/returns/:returnId', { schema: headerContract }, async (request) => changeHeader(request, request.params.returnId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/returns/:returnId/lines', { schema: addLinesContract }, async (request, reply) => reply.code(201).send(await addLines(request, request.params.returnId, request.body, idempotencyKeyFrom(request))))
  app.patch('/sales/returns/:returnId/lines/:lineId', { schema: changeLineContract }, async (request) => changeLine(request, request.params.returnId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.delete('/sales/returns/:returnId/lines/:lineId', { schema: removeLineContract }, async (request) => removeLine(request, request.params.returnId, request.params.lineId, request.query, idempotencyKeyFrom(request)))
  app.post('/sales/returns/:returnId/cancel', { schema: cancelContract }, async (request) => cancelReturn(request, request.params.returnId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/returns/:returnId/close', { schema: closeContract }, async (request) => closeReturn(request, request.params.returnId, request.body, idempotencyKeyFrom(request)))

  app.get('/sales/returns/:returnId/dock', { schema: getDockContract }, async (request) => getDock(request, request.params.returnId))
  app.post('/sales/returns/:returnId/receipts', { schema: receiveContract }, async (request, reply) => reply.code(201).send(await receiveReturn(request, request.params.returnId, request.body, idempotencyKeyFrom(request))))
  app.post('/sales/returns/:returnId/receipts/:receiptId/photos', { schema: announceReceiptPhotoContract }, async (request, reply) =>
    reply.code(201).send(await announceReceiptPhoto(request, request.params.returnId, request.params.receiptId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/sales/returns/:returnId/receipts/:receiptId/photos/:fileId/complete', { schema: completeReceiptPhotoContract }, async (request) =>
    completeReceiptPhoto(request, request.params.returnId, request.params.receiptId, request.params.fileId, idempotencyKeyFrom(request)),
  )
  app.post('/sales/returns/:returnId/grades', { schema: gradeContract }, async (request) => gradeReturn(request, request.params.returnId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/returns/:returnId/lines/:lineId/photos', { schema: announceLinePhotoContract }, async (request, reply) =>
    reply.code(201).send(await announceLinePhoto(request, request.params.returnId, request.params.lineId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/sales/returns/:returnId/lines/:lineId/photos/:fileId/complete', { schema: completeLinePhotoContract }, async (request) =>
    completeLinePhoto(request, request.params.returnId, request.params.lineId, request.params.fileId, idempotencyKeyFrom(request)),
  )

  app.post('/sales/returns/:returnId/decisions/preview', { schema: previewDecisionsContract }, async (request) => previewDecisions(request, request.params.returnId, request.body))
  app.post('/sales/returns/:returnId/decisions', { schema: decideContract }, async (request) => decideReturn(request, request.params.returnId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/returns/:returnId/replacement-order', { schema: replacementContract }, async (request, reply) => reply.code(201).send(await makeReplacementOrder(request, request.params.returnId, request.body, idempotencyKeyFrom(request))))
})
