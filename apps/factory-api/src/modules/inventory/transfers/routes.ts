import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { downloadFile, getFile, systemCallerOf } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { officeContextOf } from '../ledger/access'
import {
  addLineContract,
  cancelContract,
  createContract,
  ddtDownloadContract,
  ddtPrintContract,
  listContract,
  optionsContract,
  receiveContract,
  recordContract,
  removeLineContract,
  settleContract,
  shipContract,
  stockContract,
  updateContract,
  updateLineContract,
} from './contract'
import { manifest } from './manifest'
import { receiveTransfer, settleDifference } from './receive'
import { printDdtAgain, shipTransfer } from './ship'
import { managesFrom, managesTo, mustManage, visibleTransfer } from './store'
import { addLine, cancelTransfer, createTransfer, listTransfers, removeLine, transferOptions, transferRecord, transferStock, updateLine, updateTransfer } from './transfers'

/**
 * Warehouse › In the warehouse › Transfers (B-W2b-326; SCM-219, SCM-220): transfer orders between sites, the goods in
 * transit with their DDT, and the receipt at the other site. The rules: transfers.ts (the draft and the reads), ship.ts,
 * receive.ts, store.ts (who sees and acts), shipping/ddt/transfer.ts (the DDT's PDF); factory-domain inventory/transfers.
 */
export default defineRoutes('inventory.transfers', manifest, async (app) => {
  app.get('/inventory/transfer-orders', { schema: listContract }, async (request) => listTransfers(request, request.query))

  app.get('/inventory/transfer-orders/options', { schema: optionsContract }, async (request) => transferOptions(request))

  app.post('/inventory/transfer-orders', { schema: createContract }, async (request, reply) => reply.code(201).send({ transfer: await createTransfer(request, request.body, idempotencyKeyFrom(request)) }))

  app.get('/inventory/transfer-orders/:transferId', { schema: recordContract }, async (request) => ({ transfer: await transferRecord(request, request.params.transferId) }))

  app.patch('/inventory/transfer-orders/:transferId', { schema: updateContract }, async (request) => ({ transfer: await updateTransfer(request, request.params.transferId, request.body, idempotencyKeyFrom(request)) }))

  app.get('/inventory/transfer-orders/:transferId/stock', { schema: stockContract }, async (request) => transferStock(request, request.params.transferId, request.query))

  app.post('/inventory/transfer-orders/:transferId/lines', { schema: addLineContract }, async (request, reply) => reply.code(201).send({ transfer: await addLine(request, request.params.transferId, request.body, idempotencyKeyFrom(request)) }))

  app.patch('/inventory/transfer-orders/:transferId/lines/:lineId', { schema: updateLineContract }, async (request) => ({
    transfer: await updateLine(request, request.params.transferId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/inventory/transfer-orders/:transferId/lines/:lineId/remove', { schema: removeLineContract }, async (request) => ({
    transfer: await removeLine(request, request.params.transferId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/inventory/transfer-orders/:transferId/ship', { schema: shipContract }, async (request) =>
    shipTransfer(processFiles(), request, request.params.transferId, request.body, idempotencyKeyFrom(request), (error) => request.log.error({ err: error }, 'transfer DDT PDF not stored')),
  )

  app.post('/inventory/transfer-orders/:transferId/receive', { schema: receiveContract }, async (request) => ({ transfer: await receiveTransfer(request, request.params.transferId, request.body, idempotencyKeyFrom(request)) }))

  app.post('/inventory/transfer-orders/:transferId/lines/:lineId/settle', { schema: settleContract }, async (request) => ({
    transfer: await settleDifference(request, request.params.transferId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/inventory/transfer-orders/:transferId/cancel', { schema: cancelContract }, async (request) => ({ transfer: await cancelTransfer(request, request.params.transferId, request.body, idempotencyKeyFrom(request)) }))

  // The DDT's PDF in a new tab: a presigned GET of the stored file (files.read is checked on the file too).
  app.get('/inventory/transfer-orders/:transferId/ddt/pdf', { schema: ddtDownloadContract }, async (request) => {
    const context = officeContextOf(request)
    const row = await request.withClient((client) => visibleTransfer(client, context, request.params.transferId))
    if (!row.ddtFileId) throw new NotFoundError(row.ddtNumber ? 'The DDT is issued; its PDF is not stored yet: print it again.' : 'This transfer has no DDT yet: it gets one when it is shipped.')
    const callers = { caller: request, system: systemCallerOf(request) }
    return { file: await getFile(request, row.ddtFileId), download: await downloadFile(processFiles(), callers, row.ddtFileId) }
  })

  app.post('/inventory/transfer-orders/:transferId/ddt/pdf', { schema: ddtPrintContract }, async (request, reply) => {
    const context = officeContextOf(request)
    const row = await request.withClient((client) => visibleTransfer(client, context, request.params.transferId))
    if (!managesFrom(context, row) && !managesTo(context, row)) mustManage(context, row, 'from')
    const { fileId, created } = await printDdtAgain(processFiles(), request, request.params.transferId, request.body)
    return reply.code(created ? 201 : 200).send({ file: await getFile(request, fileId) })
  })
})
