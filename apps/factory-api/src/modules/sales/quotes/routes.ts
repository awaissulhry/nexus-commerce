import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { approve, askApproval, reject, reopen } from './approval'
import {
  addLineContract,
  approveContract,
  askApprovalContract,
  cancelContract,
  createQuoteContract,
  editLineContract,
  getQuoteContract,
  listQuotesContract,
  recomputeContract,
  rejectContract,
  removeLineContract,
  reopenContract,
  updateQuoteContract,
} from './contract'
import { addLine, editLine, recompute, removeLine } from './lines'
import { manifest } from './manifest'
import { cancelQuote, createQuote, getQuote, listQuotes, updateQuote } from './quotes'

/**
 * Quotes, part 1 (B-W1-21): the list and the record, a new quote, its header and terms, its size-grid lines (each costed
 * from its style's cost sheet), a recompute, the approval (ask, approve, reject, reopen) and the cancellation. Sending,
 * the frozen version, its PDF, the accept link and the deposit request are B-W1-24; the order is B-W1-25.
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
})
