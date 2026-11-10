import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { askAgain, askDeclarations, cancelRequest } from './ask'
import { acceptContract, answerContract, askAgainContract, askContract, cancelContract, getRequestContract, linesContract, listRequestsContract, refuseContract, remindContract } from './contract'
import { acceptRequest, answerRequest, recordLines, refuseRequest, remindRequest } from './decide'
import { manifest } from './manifest'
import { getRequest, listRequests } from './read'

/**
 * Declarations asked of suppliers (B-W2b-256; PRD-304, REACH art. 33): Request declarations (the review per supplier, then
 * one send), the list with its tiles, the record, and its verbs Remind · Answer · Lines · Accept · Reject · Cancel ·
 * Re-request. The supplier answers in its portal (B-W2b-189's documents page, against its task); the worker takes the
 * upload (jobs.ts), the hourly job moves overdue requests and reminds by each request's cadence. The screens are
 * B-W2b-267 (Compliance › Material tests: Supplier declarations).
 */
export default defineRoutes('compliance.supplierDeclarations', manifest, async (app) => {
  app.get('/compliance/declarations-asked', { schema: listRequestsContract }, async (request) => listRequests(request, request.query))
  app.post('/compliance/declarations-asked', { schema: askContract }, async (request) => askDeclarations(request, request.body, idempotencyKeyFrom(request)))
  app.get('/compliance/declarations-asked/:requestId', { schema: getRequestContract }, async (request) => getRequest(request, request.params.requestId))
  app.post('/compliance/declarations-asked/:requestId/remind', { schema: remindContract }, async (request) => remindRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/declarations-asked/:requestId/answer', { schema: answerContract }, async (request) => answerRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.put('/compliance/declarations-asked/:requestId/lines', { schema: linesContract }, async (request) => recordLines(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/declarations-asked/:requestId/accept', { schema: acceptContract }, async (request) => acceptRequest(request.server, request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/declarations-asked/:requestId/refuse', { schema: refuseContract }, async (request) => refuseRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/declarations-asked/:requestId/cancel', { schema: cancelContract }, async (request) => cancelRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/declarations-asked/:requestId/ask-again', { schema: askAgainContract }, async (request) => askAgain(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
})
