import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  askInfoContract,
  assignInquiryContract,
  assigneesContract,
  bulkAssignContract,
  bulkDeclineContract,
  createInquiryContract,
  declineInquiryContract,
  fromMailContract,
  listInquiriesContract,
  loseInquiryContract,
  mailDraftContract,
  quoteInquiryContract,
  readInquiryContract,
  resumeContract,
  sourceContract,
  updateInquiryContract,
} from './contract'
import {
  askInfo,
  assignInquiries,
  assignInquiry,
  createInquiry,
  declineInquiries,
  declineInquiry,
  inquiryAssignees,
  listInquiries,
  loseInquiry,
  readInquiry,
  resumeInquiry,
  updateInquiry,
} from './inquiries'
import { createFromMail, mailDraft } from './mail'
import { manifest } from './manifest'
import { inquirySource, quoteInquiry } from './quote'

/**
 * Inquiries and requests for quotation (B-W2b-295): ./inquiries.ts (the list, the record, new, change, assign, ask for more
 * information, decline, lost), ./mail.ts ("Make an inquiry" from a mail), ./quote.ts (make the quote; the inquiry a quote or an
 * order came from, with the tech pack in force). The thread of an inquiry is the platform's (record type Inquiry:
 * platform/threads/records.ts); its files the platform's too (POST /files with recordType Inquiry).
 */
export default defineRoutes('sales.inquiries', manifest, async (app) => {
  app.get('/sales/inquiries', { schema: listInquiriesContract }, async (request) => listInquiries(request, request.query))
  app.get('/sales/inquiries/source', { schema: sourceContract }, async (request) => inquirySource(request, request.query))
  app.get('/sales/inquiries/assignees', { schema: assigneesContract }, async (request) => inquiryAssignees(request, request.query))
  app.get('/sales/inquiries/from-mail/:inboundEmailId', { schema: mailDraftContract }, async (request) => mailDraft(request, request.params.inboundEmailId))
  app.post('/sales/inquiries/from-mail/:inboundEmailId', { schema: fromMailContract }, async (request, reply) => reply.code(201).send(await createFromMail(request, request.params.inboundEmailId, request.body, idempotencyKeyFrom(request))))
  app.post('/sales/inquiries/assign', { schema: bulkAssignContract }, async (request) => assignInquiries(request, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/inquiries/decline', { schema: bulkDeclineContract }, async (request) => declineInquiries(request, request.body, idempotencyKeyFrom(request)))
  app.get('/sales/inquiries/:inquiryId', { schema: readInquiryContract }, async (request) => ({ inquiry: await readInquiry(request, request.params.inquiryId) }))
  app.post('/sales/inquiries', { schema: createInquiryContract }, async (request, reply) => reply.code(201).send(await createInquiry(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/sales/inquiries/:inquiryId', { schema: updateInquiryContract }, async (request) => updateInquiry(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/inquiries/:inquiryId/assign', { schema: assignInquiryContract }, async (request) => assignInquiry(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/inquiries/:inquiryId/ask-info', { schema: askInfoContract }, async (request) => askInfo(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/inquiries/:inquiryId/resume', { schema: resumeContract }, async (request) => resumeInquiry(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/inquiries/:inquiryId/decline', { schema: declineInquiryContract }, async (request) => declineInquiry(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/inquiries/:inquiryId/lost', { schema: loseInquiryContract }, async (request) => loseInquiry(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/inquiries/:inquiryId/quote', { schema: quoteInquiryContract }, async (request, reply) => reply.code(201).send(await quoteInquiry(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request))))
})
