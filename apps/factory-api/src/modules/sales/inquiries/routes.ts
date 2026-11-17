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
  inquiryPictureContract,
  listInquiriesContract,
  loseInquiryContract,
  mailDraftContract,
  orderInquiryContract,
  styleDraftContract,
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
// B-TH-025 / B-TH-026: Make order, Make style draft.
import { orderInquiry } from './order'
import { styleDraftOf } from './style-draft'
// B-TH-216 (Sales › Incoming): the Picture cell's small preview.
import { inquiryPicture } from './row-extras'
// B-W2b-394 (ML1:02): the addresses whose mail makes an inquiry by itself.
import { inquiryAddresses, inquiryAddressesContract, saveInquiryAddresses, saveInquiryAddressesContract } from './from-mail'
// B-TH-221: New request's customer picker (wall W23).
import { inquiryCustomers, inquiryCustomersContract } from './customers'
// B-TH-042: answer a new customer.
import { customerCheckContract, makeCustomerContract } from './contract'
import { customerCheck, makeCustomer } from './make-customer'
// ---- B-TH-094: production's answer on a request.
import { productionAnswerContract, productionSuggestionContract } from './contract'
import { productionSuggestion, setProductionAnswer } from './production-answer'
// ---- end B-TH-094
// ---- B-TH-071: Start a project from a request.
import { startProjectContract } from './contract'
import { startProjectFromRequest } from './project'
// ---- end B-TH-071

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
  app.get('/sales/inquiries/:inquiryId/picture', { schema: inquiryPictureContract }, async (request) => inquiryPicture(request, request.params.inquiryId)) // B-TH-216
  app.post('/sales/inquiries', { schema: createInquiryContract }, async (request, reply) => reply.code(201).send(await createInquiry(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/sales/inquiries/:inquiryId', { schema: updateInquiryContract }, async (request) => updateInquiry(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/inquiries/:inquiryId/assign', { schema: assignInquiryContract }, async (request) => assignInquiry(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/inquiries/:inquiryId/ask-info', { schema: askInfoContract }, async (request) => askInfo(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/inquiries/:inquiryId/resume', { schema: resumeContract }, async (request) => resumeInquiry(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/inquiries/:inquiryId/decline', { schema: declineInquiryContract }, async (request) => declineInquiry(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/inquiries/:inquiryId/lost', { schema: loseInquiryContract }, async (request) => loseInquiry(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/inquiries/:inquiryId/quote', { schema: quoteInquiryContract }, async (request, reply) => reply.code(201).send(await quoteInquiry(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request))))
  // B-TH-025 / B-TH-026
  app.post('/sales/inquiries/:inquiryId/order', { schema: orderInquiryContract }, async (request, reply) => reply.code(201).send(await orderInquiry(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request))))
  app.post('/sales/inquiries/:inquiryId/style-draft', { schema: styleDraftContract }, async (request, reply) => reply.code(201).send(await styleDraftOf(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request))))
  // B-W2b-394 (ML1:02)
  app.get('/sales/inquiries/addresses', { schema: inquiryAddressesContract }, async (request) => inquiryAddresses(request, request.query))
  app.put('/sales/inquiries/addresses', { schema: saveInquiryAddressesContract }, async (request) => saveInquiryAddresses(request, request.body, idempotencyKeyFrom(request)))
  // B-TH-221
  app.get('/sales/inquiries/customers', { schema: inquiryCustomersContract }, async (request) => inquiryCustomers(request, request.query))
  // B-TH-042
  app.get('/sales/inquiries/:inquiryId/customer', { schema: customerCheckContract }, async (request) => customerCheck(request, request.params.inquiryId))
  app.post('/sales/inquiries/:inquiryId/customer', { schema: makeCustomerContract }, async (request) => makeCustomer(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request)))
  // ---- B-TH-094
  app.put('/sales/inquiries/:inquiryId/production-answer', { schema: productionAnswerContract }, async (request) => setProductionAnswer(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request)))
  app.get('/sales/inquiries/:inquiryId/production-answer/suggestion', { schema: productionSuggestionContract }, async (request) => productionSuggestion(request, request.params.inquiryId, request.query))
  // ---- end B-TH-094
  // ---- B-TH-071
  app.post('/sales/inquiries/:inquiryId/project', { schema: startProjectContract }, async (request, reply) => reply.code(201).send(await startProjectFromRequest(request, request.params.inquiryId, request.body, idempotencyKeyFrom(request))))
  // ---- end B-TH-071
})
