import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  announceDdtPhotoContract,
  announceDiscrepancyPhotoContract,
  changeDiscrepancyContract,
  completeDdtPhotoContract,
  completeDiscrepancyPhotoContract,
  countReceiptsContract,
  documentRequestCheckContract,
  expectedContract,
  getReceiptContract,
  hideListSummaryContract,
  listDiscrepanciesContract,
  listReceiptsContract,
  previewReportContract,
  receiptLotsContract,
  recordDiscrepancyContract,
  recordReceiptContract,
  removeDiscrepancyContract,
  reportCheckContract,
  requestDocumentsContract,
  reverseReceiptContract,
  sendReportContract,
  settleDiscrepancyContract,
  correctSupplierDdtContract,
} from './contract'
import { changeDiscrepancy, listDiscrepancies, recordDiscrepancy, removeDiscrepancy, settleDiscrepancy } from './discrepancies'
import { documentRequestCheck, requestDocuments } from './document-request'
import { hideListSummary } from './hide-list-summary'
import { manifest } from './manifest'
import { announceDdtPhoto, announceDiscrepancyPhoto, completeDdtPhoto, completeDiscrepancyPhoto } from './photos'
import { countReceipts, expectedLines, getReceipt, listReceipts, receiptLots } from './read'
// B-W2b-14: the supplier DDT number/date corrected on a posted receipt.
import { correctSupplierDdt } from './ddt-correction'
import { recordReceipt } from './record'
import { inlineDisposition, previewReport, reportCheck, sendReport } from './report'
import { reverseReceipt } from './reverse'

/**
 * Goods receipts against a purchase order (B-W1-32): record one (the receipt, its lots and hides one by one, its moves
 * posted and valued through the ledger's postMoves, the order moved on, in ONE command: ./record.ts), the list, the
 * record, its lots with every hide, the order lines still expected, and the reversal of a posted receipt while its stock
 * is untouched (./reverse.ts). The quality step (B-W1-34) releases a lot; a goods-in tablet receives through
 * modules/inventory/receiving (B-W1-33).
 */
export default defineRoutes('inventory.receipts', manifest, async (app) => {
  app.get('/inventory/receipts', { schema: listReceiptsContract }, async (request) => listReceipts(request, request.query))

  app.get('/inventory/receipts/counts', { schema: countReceiptsContract }, async (request) => countReceipts(request, request.query))

  app.get('/inventory/receipts/expected', { schema: expectedContract }, async (request) => expectedLines(request, request.query))

  app.get('/inventory/receipts/:receiptId', { schema: getReceiptContract }, async (request) => getReceipt(request, request.params.receiptId))

  app.get('/inventory/receipts/:receiptId/lots', { schema: receiptLotsContract }, async (request) => receiptLots(request, request.params.receiptId))

  app.post('/inventory/receipts', { schema: recordReceiptContract }, async (request, reply) => reply.code(201).send(await recordReceipt(request, request.body, idempotencyKeyFrom(request))))

  app.post('/inventory/receipts/:receiptId/reverse', { schema: reverseReceiptContract }, async (request, reply) =>
    reply.code(201).send(await reverseReceipt(request, request.params.receiptId, request.body, idempotencyKeyFrom(request))),
  )

  // B-W2a-31 (SCM-115): the supplier's delivery note photo (office and floor).
  app.post('/inventory/receipts/:receiptId/ddt-photos', { schema: announceDdtPhotoContract }, async (request, reply) =>
    reply.code(201).send(await announceDdtPhoto(request, request.params.receiptId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/inventory/receipts/:receiptId/ddt-photos/:fileId/complete', { schema: completeDdtPhotoContract }, async (request) => completeDdtPhoto(request, request.params.receiptId, request.params.fileId, idempotencyKeyFrom(request)))

  // B-W2a-31 (SCM-118): discrepancies, their photos and the report to the supplier.
  app.get('/inventory/receipts/:receiptId/discrepancies', { schema: listDiscrepanciesContract }, async (request) => listDiscrepancies(request, request.params.receiptId))
  app.post('/inventory/receipts/:receiptId/discrepancies', { schema: recordDiscrepancyContract }, async (request, reply) =>
    reply.code(201).send(await recordDiscrepancy(request, request.params.receiptId, request.body, idempotencyKeyFrom(request))),
  )
  app.patch('/inventory/receipts/:receiptId/discrepancies/:discrepancyId', { schema: changeDiscrepancyContract }, async (request) =>
    changeDiscrepancy(request, request.params.receiptId, request.params.discrepancyId, request.body, idempotencyKeyFrom(request)),
  )
  app.delete('/inventory/receipts/:receiptId/discrepancies/:discrepancyId', { schema: removeDiscrepancyContract }, async (request) =>
    removeDiscrepancy(request, request.params.receiptId, request.params.discrepancyId, request.query, idempotencyKeyFrom(request)),
  )
  app.post('/inventory/receipts/:receiptId/discrepancies/:discrepancyId/status', { schema: settleDiscrepancyContract }, async (request) =>
    settleDiscrepancy(request, request.params.receiptId, request.params.discrepancyId, request.body, idempotencyKeyFrom(request)),
  )
  app.post('/inventory/receipts/:receiptId/discrepancies/:discrepancyId/photos', { schema: announceDiscrepancyPhotoContract }, async (request, reply) =>
    reply.code(201).send(await announceDiscrepancyPhoto(request, request.params.receiptId, request.params.discrepancyId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/inventory/receipts/:receiptId/discrepancies/:discrepancyId/photos/:fileId/complete', { schema: completeDiscrepancyPhotoContract }, async (request) =>
    completeDiscrepancyPhoto(request, request.params.receiptId, request.params.discrepancyId, request.params.fileId, idempotencyKeyFrom(request)),
  )
  app.get('/inventory/receipts/:receiptId/discrepancy-report', { schema: previewReportContract }, async (request, reply) => {
    const { pdf, fileName } = await previewReport(request, request.params.receiptId, request.query)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
  app.get('/inventory/receipts/:receiptId/discrepancy-report/check', { schema: reportCheckContract }, async (request) => reportCheck(request, request.params.receiptId, request.query))
  app.post('/inventory/receipts/:receiptId/discrepancy-report', { schema: sendReportContract }, async (request, reply) =>
    reply.code(201).send(await sendReport(request, request.params.receiptId, request.body, idempotencyKeyFrom(request))),
  )

  // B-W2a-F4: ask the supplier for the documents the receipt's lots wait for (one narrow mail, not email.send).
  app.get('/inventory/receipts/:receiptId/documents/request', { schema: documentRequestCheckContract }, async (request) => documentRequestCheck(request, request.params.receiptId, request.query))
  app.post('/inventory/receipts/:receiptId/documents/request', { schema: requestDocumentsContract }, async (request, reply) =>
    reply.code(201).send(await requestDocuments(request, request.params.receiptId, request.body, idempotencyKeyFrom(request))),
  )

  // B-W2a-31 (SCM-248): a tannery hide list's totals against its order.
  app.get('/inventory/receipts/hide-lists/:importId', { schema: hideListSummaryContract }, async (request) => hideListSummary(request, request.params.importId))
  // B-W2b-14 (Z1:02): the supplier's DDT number and date corrected on a posted receipt, with why.
  app.post('/inventory/receipts/:receiptId/supplier-ddt', { schema: correctSupplierDdtContract }, async (request) => correctSupplierDdt(request, request.params.receiptId, request.body, idempotencyKeyFrom(request)))
})
