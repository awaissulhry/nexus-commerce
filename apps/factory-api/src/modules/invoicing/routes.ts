import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { requireStepUp } from '../../platform/auth/office/account'
import { officeAuthOf } from '../../platform/auth/sessions/office-auth'
import { processFiles } from '../../platform/files/service'
import {
  checksContract,
  createDraftContract,
  deleteDraftContract,
  depositDraftContract,
  getInvoiceContract,
  issueContract,
  listInvoicesContract,
  makeFilesContract,
  relatedContract,
  replaceLinesContract,
  settingsContract,
  updateDraftContract,
} from './contract'
import { createDepositDraft, createDraft, deleteDraft, replaceLines, updateDraft } from './drafts'
import { makeFilesRoute } from './invoice-files'
import { getInvoice, listInvoices } from './invoices'
import { issueChecks, issueInvoice } from './issue'
import { manifest } from './manifest'
import { invoiceRelated } from './related'
import { financeSettings } from './settings'
import { createCreditNote } from './credit-note/credit-note'
import { creditNoteContract, fromDdtsContract, removeDeductionContract, settlementContract, shippedNotInvoicedContract } from './from-shipment/contract'
import { removeDeduction } from './from-shipment/deductions'
import { createFromDdts } from './from-shipment/draft'
import { shippedNotInvoiced } from './from-shipment/queue'
import { getSettlement } from './from-shipment/settlement'
import { correctSdiContract, getSdiContract, sendSdiContract } from './sdi/contract'
import { correctInvoice } from './sdi/correct'
import { processSdi } from './sdi/runtime'
import { sendToSdi } from './sdi/send'
import { getSdiStatus } from './sdi/view'

/**
 * Invoices (B-W1-28 invoice core and the deposit invoice; A2 SCR-080, SCR-081): the list and the record, drafts (generic
 * TD01/TD24, a TD02 from a deposit request), their text and lines, the checks before issue, the issue (step-up: number,
 * XML and PDF), and "make the files" for an issued invoice whose files are pending; its SDI status, the send to SDI and
 * the correction of a rejected invoice (B-W1-50, handlers in ./sdi: the autoloader reads this folder's routes file only).
 * Invoices of shipped goods (B-W1-51, handlers in ./from-shipment): the shipped-not-invoiced list, a TD01/TD24 draft
 * from DDTs with the deposits deducted, removing a deduction, the order's settlement; a credit note draft (./credit-note).
 * They are issued and sent through the routes above.
 */
export default defineRoutes('invoicing', manifest, async (app) => {
  app.get('/invoicing/invoices', { schema: listInvoicesContract }, async (request) => listInvoices(request, request.query))

  app.get('/invoicing/invoices/:invoiceId', { schema: getInvoiceContract }, async (request) => getInvoice(request, request.params.invoiceId))

  app.get('/invoicing/invoices/:invoiceId/checks', { schema: checksContract }, async (request) => issueChecks(request, request.params.invoiceId))

  app.get('/invoicing/invoices/:invoiceId/related', { schema: relatedContract }, async (request) => invoiceRelated(request, request.params.invoiceId))

  app.post('/invoicing/invoices', { schema: createDraftContract }, async (request, reply) => reply.code(201).send(await createDraft(request, request.body, idempotencyKeyFrom(request))))

  app.post('/invoicing/invoices/deposit-draft', { schema: depositDraftContract }, async (request, reply) => reply.code(201).send(await createDepositDraft(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/invoicing/invoices/:invoiceId', { schema: updateDraftContract }, async (request) => updateDraft(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))

  app.put('/invoicing/invoices/:invoiceId/lines', { schema: replaceLinesContract }, async (request) => replaceLines(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))

  app.delete('/invoicing/invoices/:invoiceId', { schema: deleteDraftContract }, async (request) => deleteDraft(request, request.params.invoiceId, request.query, idempotencyKeyFrom(request)))

  app.post('/invoicing/invoices/:invoiceId/issue', { schema: issueContract }, async (request) =>
    issueInvoice(processFiles(), request, request.params.invoiceId, request.body, idempotencyKeyFrom(request), () => requireStepUp(officeAuthOf(app), request)),
  )

  app.post('/invoicing/invoices/:invoiceId/files', { schema: makeFilesContract }, async (request) => makeFilesRoute(processFiles(), request, request.params.invoiceId))

  app.get('/invoicing/invoices/:invoiceId/sdi', { schema: getSdiContract }, async (request) => getSdiStatus(request, request.params.invoiceId))

  app.post('/invoicing/invoices/:invoiceId/sdi/send', { schema: sendSdiContract }, async (request) =>
    sendToSdi(processFiles(), processSdi(), request, request.params.invoiceId, request.body, idempotencyKeyFrom(request), () => requireStepUp(officeAuthOf(app), request)),
  )

  app.put('/invoicing/invoices/:invoiceId/sdi/correction', { schema: correctSdiContract }, async (request) =>
    correctInvoice(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request), () => requireStepUp(officeAuthOf(app), request)),
  )

  app.get('/invoicing/shipped-not-invoiced', { schema: shippedNotInvoicedContract }, async (request) => shippedNotInvoiced(request, request.query))

  app.post('/invoicing/invoices/from-ddts', { schema: fromDdtsContract }, async (request, reply) => reply.code(201).send(await createFromDdts(request, request.body, idempotencyKeyFrom(request))))

  app.delete('/invoicing/invoices/:invoiceId/deductions/:lineId', { schema: removeDeductionContract }, async (request) => removeDeduction(request, request.params.invoiceId, request.params.lineId, request.query, idempotencyKeyFrom(request)))

  app.post('/invoicing/invoices/:invoiceId/credit-note', { schema: creditNoteContract }, async (request, reply) => reply.code(201).send(await createCreditNote(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request))))

  app.get('/invoicing/settings', { schema: settingsContract }, async (request) => financeSettings(request))

  app.get('/invoicing/orders/:orderId/settlement', { schema: settlementContract }, async (request) => getSettlement(request, request.params.orderId))
})
