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
import { draftReturnCreditNotesContract, returnCreditNotesContract } from './credit-note/contract'
import { draftReturnCreditNotes, returnCreditNotes } from './credit-note/from-return'
import { createDeferredContract, creditNoteContract, deferredContract, fromDdtsContract, fromMilestoneContract, removeDeductionContract, settlementContract, shippedNotInvoicedContract } from './from-shipment/contract'
import { createDeferred, deferredDue } from './from-shipment/deferred'
import { createFromMilestone } from './milestones'
import { removeDeduction } from './from-shipment/deductions'
import { createFromDdts } from './from-shipment/draft'
import { shippedNotInvoiced } from './from-shipment/queue'
import { getSettlement } from './from-shipment/settlement'
import { correctSdiContract, getSdiContract, sendSdiContract } from './sdi/contract'
import { correctInvoice } from './sdi/correct'
import { processSdi } from './sdi/runtime'
import { sendToSdi } from './sdi/send'
import { getSdiStatus } from './sdi/view'
// B-W2b-392: tax rules as data.
import { archiveTaxCode, confirmTaxCode, createTaxCode, deleteTaxCode, listTaxCodes, newTaxCodeVersion, updateTaxCode } from './tax-codes/codes'
import { archiveTaxCodeContract, confirmTaxCodeContract, createTaxCodeContract, deleteTaxCodeContract, invoiceTaxContract, listTaxCodesContract, newVersionContract, putTaxSettingsContract, taxSettingsContract, updateTaxCodeContract } from './tax-codes/contract'
import { invoiceTax } from './tax-codes/apply'
import { putTaxSettings, taxSettings } from './tax-codes/settings'
import { checkDeclarationContract, createDeclarationContract, getDeclarationContract, listDeclarationsContract, nameDeclarationContract, revokeDeclarationContract } from './intent/contract'
import { checkDeclaration, createDeclaration, getDeclaration, listDeclarations, revokeDeclaration } from './intent/declarations'
import { nameDeclaration } from './intent/on-invoice'
import { listQuartersContract, payQuarterContract, recountQuarterContract } from './stamp-duty/contract'
import { listQuarters, payQuarter, recountQuarter } from './stamp-duty/quarters'
// B-W2b-396: invoicing in depth.
import { languageCurrencyContract, putLanguageContract, putRateContract } from './language-currency/contract'
import { languageCurrency, putLanguage, putRate } from './language-currency/language-currency'
import { createRunContract, deleteRunContract, getRunContract, issueRunContract, listRunsContract, pickRunContract, runCandidatesContract } from './runs/contract'
import { createRun, deleteRun, getRun, issueRun, listRuns, pickRun, runCandidates } from './runs/runs'
import { archiveRuleContract, createRuleContract, decideOrderContract, listRulesContract, orderOutcomeContract, updateRuleContract } from './cancellation/contract'
import { archiveRule, createRule, listRules, updateRule } from './cancellation/rules'
import { decideOrder, orderOutcome } from './cancellation/orders'
import { creditFee, feeCreditContract, invoiceOrderFees, invoiceSampleRound, orderFeesInvoiceContract, sampleRoundInvoiceContract } from './from-shipment/fees'

/**
 * Invoices (B-W1-28 invoice core and the deposit invoice; A2 SCR-080, SCR-081): the list and the record, drafts (generic
 * TD01/TD24, a TD02 from a deposit request), their text and lines, the checks before issue, the issue (step-up: number,
 * XML and PDF), and "make the files" for an issued invoice whose files are pending; its SDI status, the send to SDI and
 * the correction of a rejected invoice (B-W1-50, handlers in ./sdi: the autoloader reads this folder's routes file only).
 * Invoices of shipped goods (B-W1-51, handlers in ./from-shipment): the shipped-not-invoiced list, a TD01/TD24 draft
 * from DDTs with the deposits deducted, removing a deduction, the order's settlement; a credit note draft (./credit-note).
 * They are issued and sent through the routes above.
 * Invoicing every day (B-W2a-54): the deferred invoices due and one TD24 of a customer's month (./from-shipment/deferred),
 * a part of the DDTs' goods and their freight (from-ddts `lines`, `freight`), charge lines (PUT …/lines kind CHARGE), the
 * invoice of a payment schedule step (./milestones), the deadlines by the customer's preset.
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

  app.get('/invoicing/deferred', { schema: deferredContract }, async (request) => deferredDue(request, request.query))

  app.post('/invoicing/invoices/deferred', { schema: createDeferredContract }, async (request, reply) => reply.code(201).send(await createDeferred(request, request.body, idempotencyKeyFrom(request))))

  app.post('/invoicing/invoices/from-milestone', { schema: fromMilestoneContract }, async (request, reply) => reply.code(201).send(await createFromMilestone(request, request.body, idempotencyKeyFrom(request))))

  app.get('/invoicing/settings', { schema: settingsContract }, async (request) => financeSettings(request))

  app.get('/invoicing/orders/:orderId/settlement', { schema: settlementContract }, async (request) => getSettlement(request, request.params.orderId))

  // B-W2a-61: a customer return's credit notes, and their drafts from its decided lines.
  app.get('/invoicing/returns/:returnId/credit-notes', { schema: returnCreditNotesContract }, async (request) => returnCreditNotes(request, request.params.returnId))

  app.post('/invoicing/returns/:returnId/credit-notes', { schema: draftReturnCreditNotesContract }, async (request, reply) =>
    reply.code(201).send(await draftReturnCreditNotes(request, request.params.returnId, request.body, idempotencyKeyFrom(request))),
  )

  // B-W2b-392: tax rules as data (handlers in ./tax-codes, ./intent, ./stamp-duty): the company's tax codes and switches, an
  // invoice's tax view, the customers' declarations of intent and naming one on a draft, the stamp duty quarters.
  app.get('/invoicing/tax-codes', { schema: listTaxCodesContract }, async (request) => listTaxCodes(request, request.query))
  app.post('/invoicing/tax-codes', { schema: createTaxCodeContract }, async (request, reply) => reply.code(201).send(await createTaxCode(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/invoicing/tax-codes/:taxCodeId', { schema: updateTaxCodeContract }, async (request) => updateTaxCode(request, request.params.taxCodeId, request.body, idempotencyKeyFrom(request)))
  app.post('/invoicing/tax-codes/:taxCodeId/versions', { schema: newVersionContract }, async (request, reply) => reply.code(201).send(await newTaxCodeVersion(request, request.params.taxCodeId, request.body, idempotencyKeyFrom(request))))
  app.post('/invoicing/tax-codes/:taxCodeId/archive', { schema: archiveTaxCodeContract }, async (request) => archiveTaxCode(request, request.params.taxCodeId, request.body, idempotencyKeyFrom(request)))
  app.delete('/invoicing/tax-codes/:taxCodeId', { schema: deleteTaxCodeContract }, async (request) => deleteTaxCode(request, request.params.taxCodeId, request.query, idempotencyKeyFrom(request)))
  app.post('/invoicing/tax-codes/:taxCodeId/confirm', { schema: confirmTaxCodeContract }, async (request) =>
    confirmTaxCode(request, request.params.taxCodeId, request.body, idempotencyKeyFrom(request), () => requireStepUp(officeAuthOf(app), request)),
  )
  app.get('/invoicing/tax/settings', { schema: taxSettingsContract }, async (request) => taxSettings(request))
  app.put('/invoicing/tax/settings/:companyId', { schema: putTaxSettingsContract }, async (request) =>
    putTaxSettings(request, request.params.companyId, request.body, idempotencyKeyFrom(request), () => requireStepUp(officeAuthOf(app), request)),
  )
  app.get('/invoicing/invoices/:invoiceId/tax', { schema: invoiceTaxContract }, async (request) => invoiceTax(request, request.params.invoiceId))
  app.put('/invoicing/invoices/:invoiceId/declaration-of-intent', { schema: nameDeclarationContract }, async (request) => nameDeclaration(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))
  app.get('/invoicing/declarations-of-intent', { schema: listDeclarationsContract }, async (request) => listDeclarations(request, request.query))
  app.get('/invoicing/declarations-of-intent/:declarationId', { schema: getDeclarationContract }, async (request) => getDeclaration(request, request.params.declarationId))
  app.post('/invoicing/declarations-of-intent', { schema: createDeclarationContract }, async (request, reply) => reply.code(201).send(await createDeclaration(request, request.body, idempotencyKeyFrom(request))))
  app.post('/invoicing/declarations-of-intent/:declarationId/check', { schema: checkDeclarationContract }, async (request) => checkDeclaration(request, request.params.declarationId, request.body, idempotencyKeyFrom(request)))
  app.post('/invoicing/declarations-of-intent/:declarationId/revoke', { schema: revokeDeclarationContract }, async (request) => revokeDeclaration(request, request.params.declarationId, request.body, idempotencyKeyFrom(request)))
  app.get('/invoicing/stamp-duty/quarters', { schema: listQuartersContract }, async (request) => listQuarters(request, request.query))
  app.post('/invoicing/stamp-duty/quarters/recount', { schema: recountQuarterContract }, async (request) => recountQuarter(request, request.body, idempotencyKeyFrom(request)))
  app.post('/invoicing/stamp-duty/quarters/:quarterId/paid', { schema: payQuarterContract }, async (request) => payQuarter(request, request.params.quarterId, request.body, idempotencyKeyFrom(request)))

  // B-W2b-396: invoicing in depth (handlers in ./language-currency, ./runs, ./cancellation, ./from-shipment/fees.ts): an
  // invoice's language and currency, the monthly invoice run, the deposit rules and a cancelled order's credit notes, fees
  // and a sample round's charge invoiced once, a fee credited against the bulk order.
  app.get('/invoicing/invoices/:invoiceId/language-currency', { schema: languageCurrencyContract }, async (request) => languageCurrency(request, request.params.invoiceId))
  app.put('/invoicing/invoices/:invoiceId/language', { schema: putLanguageContract }, async (request) => putLanguage(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))
  app.put('/invoicing/invoices/:invoiceId/rate', { schema: putRateContract }, async (request) => putRate(request, request.params.invoiceId, request.body, idempotencyKeyFrom(request)))
  app.get('/invoicing/runs', { schema: listRunsContract }, async (request) => listRuns(request, request.query))
  app.get('/invoicing/runs/candidates', { schema: runCandidatesContract }, async (request) => runCandidates(request, request.query))
  app.get('/invoicing/runs/:runId', { schema: getRunContract }, async (request) => getRun(request, request.params.runId))
  app.post('/invoicing/runs', { schema: createRunContract }, async (request, reply) => reply.code(201).send(await createRun(request, request.body, idempotencyKeyFrom(request))))
  app.put('/invoicing/runs/:runId/customers', { schema: pickRunContract }, async (request) => pickRun(request, request.params.runId, request.body, idempotencyKeyFrom(request)))
  app.post('/invoicing/runs/:runId/issue', { schema: issueRunContract }, async (request) =>
    issueRun(processFiles(), processSdi, request, request.params.runId, request.body, () => requireStepUp(officeAuthOf(app), request)),
  )
  app.delete('/invoicing/runs/:runId', { schema: deleteRunContract }, async (request) => deleteRun(request, request.params.runId, request.query, idempotencyKeyFrom(request)))
  app.get('/invoicing/deposit-rules', { schema: listRulesContract }, async (request) => listRules(request, request.query))
  app.post('/invoicing/deposit-rules', { schema: createRuleContract }, async (request, reply) => reply.code(201).send(await createRule(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/invoicing/deposit-rules/:ruleId', { schema: updateRuleContract }, async (request) => updateRule(request, request.params.ruleId, request.body, idempotencyKeyFrom(request)))
  app.post('/invoicing/deposit-rules/:ruleId/archive', { schema: archiveRuleContract }, async (request) => archiveRule(request, request.params.ruleId, request.body, idempotencyKeyFrom(request)))
  app.get('/invoicing/orders/:orderId/deposit-cancellation', { schema: orderOutcomeContract }, async (request) => orderOutcome(request, request.params.orderId, request.query))
  app.post('/invoicing/orders/:orderId/deposit-cancellation', { schema: decideOrderContract }, async (request) => decideOrder(request, request.params.orderId, request.body, idempotencyKeyFrom(request)))
  app.post('/invoicing/orders/:orderId/fees/invoice', { schema: orderFeesInvoiceContract }, async (request, reply) => reply.code(201).send(await invoiceOrderFees(request, request.params.orderId, idempotencyKeyFrom(request))))
  app.post('/invoicing/invoices/from-sample-round', { schema: sampleRoundInvoiceContract }, async (request, reply) => reply.code(201).send(await invoiceSampleRound(request, request.body, idempotencyKeyFrom(request))))
  app.post('/invoicing/fee-lines/:lineId/credit', { schema: feeCreditContract }, async (request) => creditFee(request, request.params.lineId, request.body, idempotencyKeyFrom(request)))
})
