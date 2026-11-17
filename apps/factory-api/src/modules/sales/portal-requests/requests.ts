import type { FastifyInstance, FastifyRequest } from 'fastify'
import { DomainError, ForbiddenError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { customerNumberOf, customerRefOf } from '@nexus/factory-domain/sales/customer-numbers'
import type { SendRequestBody } from '@nexus/factory-domain/sales/portal-requests/contracts'
import { PORTAL_REQUESTS_CLOSED, requestProblems, requestTextOf, subjectOf } from '@nexus/factory-domain/sales/portal-requests/rules'
import { portalOf } from '../../../platform/auth/portal/service'
import { appClock } from '../../../platform/portal/tasks/clock'
import { postPartnerMessage } from '../../../platform/threads/partner/service'
import { insertInquiry, type NewInquiry } from '../inquiries/inquiries'
import { databaseRefusal } from '../inquiries/store'
import { portalReader } from '../portal-orders/access'
import { takesRequests } from './open'
import { partnerRequest, requestViewOf } from './views'
// B-TH-092: the New order's draft goes with the request sent.
import { clearDraftInCommand } from '../../../platform/threads/draft-keys'

/**
 * The customer sends a request from the portal (B-TH-010; threads plan G1, L2-G02; design P-CUS-NEW "New order" as an e-mail,
 * its receipt P-CUS-NEW.receipt). POST /portal/inquiries:
 *
 *   1. the session's company and party, never a field (W11); an office preview sends nothing (403); the company takes requests
 *      (an ACTIVE INQUIRY series, B-TH-012) or the answer says so neutrally (409, in the person's words);
 *   2. the words: the message (1 to 20 000 characters with its subject), the subject (else the first line), the PO, the day
 *      wanted (today or later) and one of the party's own SHIP_TO addresses (a delivery address its people added may still
 *      wait for our check: the office decides it with the order) — another's or none answers "not one of your addresses";
 *   3. ONE command in the tenant's office scope as the portal person (the numbering grant; the partner role inserts no Inquiry):
 *      the Inquiry, source PORTAL, numbered INQ-… from the company's series, the customer's words as its request, NEW for the
 *      office's Incoming (inquiry.received: the new-request notice to who answers requests, B-TH-015; the receipt mail and the
 *      portal news, B-TH-011);
 *   4. the words as the FIRST message of the request's thread, through platform/threads/partner (W08): INBOUND, PORTAL, by the
 *      person's name, in the partner's own scope — the office reads them as written and cannot edit them;
 *   5. the answer: the request as the customer now reads it, and its receipt ("Received — Your request 7"; th2-backend step 7:
 *      never the office's INQ-… series).
 *
 * The same Idempotency-Key sends once (a double click is one request); a retry after step 3 finds the request and posts its words
 * once (the post's own key).
 */
export async function sendRequest(app: FastifyInstance, request: FastifyRequest, body: SendRequestBody, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const { session } = reader
  if (session.preview) throw new ForbiddenError('A preview of the portal sends no request.')
  const now = appClock(app).now()
  const problems = requestProblems({ subject: body.subject ?? null, message: body.message, wantedDate: body.wantedDate ?? null }, businessDate(now))
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const company = session.company
  const checks = await reader.inTenant(async (client) => ({
    open: await takesRequests(client, company.id),
    shipTo: body.shipToAddressId ? await client.partyAddress.findFirst({ where: { id: body.shipToAddressId, partyId: session.partyId, status: 'ACTIVE', kinds: { has: 'SHIP_TO' } }, select: { id: true } }) : null,
  }))
  if (!checks.open) {
    const words = PORTAL_REQUESTS_CLOSED(company.name)
    throw new DomainError('invalid_state', words.en, [{ path: 'request/closed', message: words.en }])
  }
  if (body.shipToAddressId && !checks.shipTo) throw new ValidationError('Not one of your delivery addresses.', [{ path: 'body/shipToAddressId', message: 'Not one of your delivery addresses.' }])

  const text = requestTextOf(body.subject ?? null, body.message)
  const made: NewInquiry = {
    companyId: company.id,
    source: 'PORTAL',
    sourceEmailId: null,
    receivedAt: now,
    partyId: session.partyId,
    contactId: null,
    prospect: null,
    request: text,
    wantedDate: body.wantedDate ?? null,
    targetUnitPrice: null,
    currency: null,
    techPackFileIds: [],
    techPackVersion: null,
    note: null,
    lines: [],
    assigneeId: null,
    customerRef: body.customerRef?.trim() || null,
    shipToAddressId: body.shipToAddressId ?? null,
    fromPortal: true,
  }
  const p = portalOf(app)
  const outcome = await p.auth.command(p.auth.contextFor(request, session.tenantId, session.userId), { name: 'portalRequests.send', idempotencyKey, input: { ...body, sessionId: session.id } }, async (tools) => {
    const inserted = await insertInquiry(tools, made)
    await clearDraftInCommand(tools, session.userId, null) // B-TH-092
    return inserted
  }).catch(databaseRefusal)
  const { id } = outcome.result
  // Their words, the request's first message (its own key: a retry posts them once).
  await postPartnerMessage(request, { type: 'Inquiry', id }, { body: text, attachments: [] }, idempotencyKey ? `${idempotencyKey}:words` : undefined, { firstOfRequest: true })
  const row = await partnerRequest(request, company.id, id)
  const view = await requestViewOf(reader, request, row)
  const yourNumber = customerNumberOf('REQUEST', row.customerSeq)
  const subject = subjectOf(body.subject ?? null, body.message)
  return {
    request: view,
    receipt: {
      // th2-backend step 7 (threads plan §0.5, counts do not leak): the customer's own reference, never the office's series.
      number: customerRefOf('REQUEST', row.customerSeq) ?? '—',
      yourNumber,
      subject,
      words: {
        en: yourNumber ? `Received — ${yourNumber.words.en}.` : 'Received.',
        it: yourNumber ? `Ricevuta — ${yourNumber.words.it}.` : 'Ricevuta.',
      },
    },
  }
}
