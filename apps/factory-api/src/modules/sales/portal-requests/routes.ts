import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { appClock } from '../../../platform/portal/tasks/clock'
import { listContract, openContract, recordContract, sendContract } from './contract'
import { manifest } from './manifest'
import { requestsOpen } from './open'
import { sendRequest } from './requests'
import { listRequests, readRequest } from './views'

/**
 * The customer's requests in the portal (threads plan TH-1b; design P-CUS-NEW "New order" as an e-mail, X-P-CUS-REQ the request
 * page, P-CUS-ORD-LIST the requests beside the orders). The office answers them in Sales › Incoming (modules/sales/inquiries).
 *
 *   POST /portal/inquiries                  B-TH-010: the customer sends a request (text; subject, PO, wanted day, delivery
 *                                           address optional): an Inquiry of the session's company and party, source PORTAL,
 *                                           numbered INQ-… in the office's scope; its words the first message of its thread
 *   GET  /portal/inquiries                  B-TH-103: its requests, partner-first, with the real state (B-TH-011) and its own
 *                                           numbers (B-TH-105); the tiles' counts
 *   GET  /portal/inquiries/open             B-TH-012: whether New order takes a request for the session's company, and why not
 *   GET  /portal/inquiries/:inquiryId       B-TH-103: one request (404 for another party's: the wall, W37)
 */
export default defineRoutes('portal-requests', manifest, async (app) => {
  app.post('/portal/inquiries', { schema: sendContract }, async (request, reply) => reply.code(201).send(await sendRequest(app, request, request.body, idempotencyKeyFrom(request))))

  app.get('/portal/inquiries/open', { schema: openContract }, async (request) => requestsOpen(app, request))

  app.get('/portal/inquiries', { schema: listContract }, async (request) => listRequests(app, request, request.query, appClock(app).now()))

  app.get('/portal/inquiries/:inquiryId', { schema: recordContract }, async (request) => ({ request: await readRequest(app, request, request.params.inquiryId, appClock(app).now()) }))
})
