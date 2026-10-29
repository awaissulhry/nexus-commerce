import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { AUTH_RATE_LIMITS } from '../../../platform/auth/sessions/office-auth'
import { answerQuote, askNewLink, linkQuoteDocument, openQuote } from './accept'
import { approve, askApproval, reject, reopen } from './approval'
import {
  addLineContract,
  approveContract,
  askApprovalContract,
  cancelContract,
  createQuoteContract,
  editLineContract,
  getQuoteContract,
  getSettingsContract,
  listQuotesContract,
  recomputeContract,
  rejectContract,
  removeLineContract,
  reopenContract,
  acceptLinkQuoteContract,
  approvalsContract,
  linkDocumentContract,
  nextNumberContract,
  previewContract,
  declineLinkQuoteContract,
  newLinkQuoteContract,
  openLinkQuoteContract,
  reviseContract,
  sendCheckContract,
  sendContract,
  sendLinkContract,
  versionsContract,
  saveSettingsContract,
  updateQuoteContract,
} from './contract'
import { addLine, editLine, recompute, removeLine } from './lines'
import { manifest } from './manifest'
import { cancelQuote, createQuote, getQuote, listQuotes, updateQuote } from './quotes'
import { reviseQuote, sendCheck, sendNewLink, sendQuote } from './send'
import { getSalesSettings, saveSalesSettings } from './settings'
import { listVersions } from './versions'
import { listQuoteApprovals, nextQuoteNumber } from './approvals'
import { inlineDisposition, previewQuotePdf } from './preview'

/**
 * Quotes, part 1 (B-W1-21): the list and the record, a new quote, its header and terms, its size-grid lines (each costed
 * from its style's cost sheet), a recompute, the approval (ask, approve, reject, reopen) and the cancellation. Sending,
 * the frozen version, its PDF, the accept link and the deposit request are B-W1-24 (below); the order is B-W1-25. And the
 * sales settings: the quote rules (margin floor, discount limit, default validity and deposit) of a company or the tenant.
 *
 * B-W1-24, office: GET …/send-check (what the send checks; the mail it writes), POST …/send (freeze, PDF, accept link,
 * mail), POST …/send-link (a new link), POST …/revise (a new DRAFT version), GET …/versions (the versions, their PDFs,
 * links, acceptance evidence and deposit request); cancel also withdraws a sent quote (with a reason). The customer's
 * link: GET /link/quote, POST /link/quote/accept | decline | new-link (rate limited like every link route).
 */
export default defineRoutes('sales.quotes', manifest, async (app) => {
  app.get('/sales/quotes', { schema: listQuotesContract }, async (request) => listQuotes(request, request.query))

  app.get('/sales/quotes/:quoteId', { schema: getQuoteContract }, async (request) => getQuote(request, request.params.quoteId))

  app.post('/sales/quotes', { schema: createQuoteContract }, async (request, reply) => reply.code(201).send(await createQuote(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/sales/quotes/:quoteId', { schema: updateQuoteContract }, async (request) => updateQuote(request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/quotes/:quoteId/lines', { schema: addLineContract }, async (request, reply) => reply.code(201).send(await addLine(request, request.params.quoteId, request.body, idempotencyKeyFrom(request))))

  app.patch('/sales/quotes/:quoteId/lines/:lineId', { schema: editLineContract }, async (request) => editLine(request, request.params.quoteId, request.params.lineId, request.body, idempotencyKeyFrom(request)))

  app.delete('/sales/quotes/:quoteId/lines/:lineId', { schema: removeLineContract }, async (request) => removeLine(request, request.params.quoteId, request.params.lineId, request.query, idempotencyKeyFrom(request)))

  app.post('/sales/quotes/:quoteId/recompute', { schema: recomputeContract }, async (request) => recompute(request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/quotes/:quoteId/approval', { schema: askApprovalContract }, async (request) => askApproval(request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/quotes/:quoteId/approval/approve', { schema: approveContract }, async (request) => approve(request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/quotes/:quoteId/approval/reject', { schema: rejectContract }, async (request) => reject(request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/quotes/:quoteId/reopen', { schema: reopenContract }, async (request) => reopen(request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/quotes/:quoteId/cancel', { schema: cancelContract }, async (request) => cancelQuote(request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))

  // B-W1-21 part 2: the approvals queue, the next number, the PDF before it is sent (shown inline; a new tab opens it).
  app.get('/sales/quote-approvals', { schema: approvalsContract }, async (request) => listQuoteApprovals(request, request.query))

  app.get('/sales/quote-numbers/next', { schema: nextNumberContract }, async (request) => nextQuoteNumber(request, request.query.companyId))

  app.get('/sales/quotes/:quoteId/preview', { schema: previewContract }, async (request, reply) => {
    const { pdf, fileName } = await previewQuotePdf(request, request.params.quoteId, request.query.language)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.get('/sales/quotes/:quoteId/send-check', { schema: sendCheckContract }, async (request) => sendCheck(request, request.params.quoteId))

  app.post('/sales/quotes/:quoteId/send', { schema: sendContract }, async (request) => sendQuote(request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/quotes/:quoteId/send-link', { schema: sendLinkContract }, async (request) => sendNewLink(request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/quotes/:quoteId/revise', { schema: reviseContract }, async (request) => reviseQuote(request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))

  app.get('/sales/quotes/:quoteId/versions', { schema: versionsContract }, async (request) => listVersions(request, request.params.quoteId))

  const linkUse = app.officeAuth?.rateLimits.linkUse ?? AUTH_RATE_LIMITS.linkUse
  const limited = { rateLimit: { max: linkUse.max, timeWindow: linkUse.timeWindowMs } }

  app.get('/link/quote', { schema: openLinkQuoteContract, config: limited }, async (request) => openQuote(request))

  app.get('/link/quote/document', { schema: linkDocumentContract, config: limited }, async (request, reply) => {
    const { pdf, fileName } = await linkQuoteDocument(request)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })

  app.post('/link/quote/accept', { schema: acceptLinkQuoteContract, config: limited }, async (request) => answerQuote(request, 'accept', request.body))

  app.post('/link/quote/decline', { schema: declineLinkQuoteContract, config: limited }, async (request) => answerQuote(request, 'decline', request.body))

  app.post('/link/quote/new-link', { schema: newLinkQuoteContract, config: limited }, async (request) => askNewLink(request, request.body))

  app.get('/sales/settings', { schema: getSettingsContract }, async (request) => getSalesSettings(request, request.query))

  app.put('/sales/settings', { schema: saveSettingsContract }, async (request) => saveSalesSettings(request, request.body, idempotencyKeyFrom(request)))
})
