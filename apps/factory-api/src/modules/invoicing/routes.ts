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
  replaceLinesContract,
  updateDraftContract,
} from './contract'
import { createDepositDraft, createDraft, deleteDraft, replaceLines, updateDraft } from './drafts'
import { makeFilesRoute } from './invoice-files'
import { getInvoice, listInvoices } from './invoices'
import { issueChecks, issueInvoice } from './issue'
import { manifest } from './manifest'

/**
 * Invoices (B-W1-28 invoice core and the deposit invoice; A2 SCR-080, SCR-081): the list and the record, drafts (generic
 * TD01/TD24, a TD02 from a deposit request), their text and lines, the checks before issue, the issue (step-up: number,
 * XML and PDF), and "make the files" for an issued invoice whose files are pending. Sending to SDI is B-W1-50; invoices
 * from DDTs, credit notes and deductions are B-W1-51 (they reuse this core).
 */
export default defineRoutes('invoicing', manifest, async (app) => {
  app.get('/invoicing/invoices', { schema: listInvoicesContract }, async (request) => listInvoices(request, request.query))

  app.get('/invoicing/invoices/:invoiceId', { schema: getInvoiceContract }, async (request) => getInvoice(request, request.params.invoiceId))

  app.get('/invoicing/invoices/:invoiceId/checks', { schema: checksContract }, async (request) => issueChecks(request, request.params.invoiceId))

  app.post('/invoicing/invoices', { schema: createDraftContract }, async (request, reply) => reply.code(201).send(await createDraft(request, request.body, idempotencyKeyFrom(request))))

  app.post('/invoicing/invoices/deposit-draft', { schema: depositDraftContract }, async (request, reply) => reply.code(201).send(await createDepositDraft(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/invoicing/invoices/:invoiceId', { schema: updateDraftContract }, async (request) => updateDraft(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))

  app.put('/invoicing/invoices/:invoiceId/lines', { schema: replaceLinesContract }, async (request) => replaceLines(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))

  app.delete('/invoicing/invoices/:invoiceId', { schema: deleteDraftContract }, async (request) => deleteDraft(request, request.params.invoiceId, request.query, idempotencyKeyFrom(request)))

  app.post('/invoicing/invoices/:invoiceId/issue', { schema: issueContract }, async (request) =>
    issueInvoice(processFiles(), request, request.params.invoiceId, request.body, idempotencyKeyFrom(request), () => requireStepUp(officeAuthOf(app), request)),
  )

  app.post('/invoicing/invoices/:invoiceId/files', { schema: makeFilesContract }, async (request) => makeFilesRoute(processFiles(), request, request.params.invoiceId))
})
