import type { FastifyInstance, FastifyRequest } from 'fastify'
import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { partnerLocaleOf } from '@nexus/factory-domain/threads/partner/rules'
import type { InquiryStatus } from '@nexus/factory-domain/sales/inquiries/rules'
import { WITHDRAW_WORDS, withdrawRefusal, type WithdrawRefusal } from '@nexus/factory-domain/sales/portal-requests/state'
import { StaleVersionError } from '../../../core/command'
import { portalOf } from '../../../platform/auth/portal/service'
import { writeInquiry } from '../inquiries/inquiries'
import { databaseRefusal, readInquiryRow } from '../inquiries/store'
import { portalReader } from '../portal-orders/access'
import { partnerRequest, requestViewOf } from './views'

/**
 * B-TH-095 (threads plan TH-9, N20; X-P-CUS-REQ.state-F03 "Withdraw before the office decided"; wall W37): POST
 * /portal/inquiries/:inquiryId/withdraw {version} — the customer takes its own request back from the portal, as it can a catalogue
 * order ("Catalogue orders can be withdrawn today; say the same words for both kinds").
 *
 *   1. the session's own request in the portal's company, read in the partner scope: another party's request is not found (W37);
 *      an office preview withdraws nothing (403); who sends requests withdraws them (portal.orderRequests.manage, the route);
 *   2. only before the office decided (NEW, ASSIGNED, NEED_INFO), else refused in the person's words (409 refusal/<CODE>:
 *      ALREADY_WITHDRAWN, DECIDED);
 *   3. ONE command in the tenant's office scope as the portal person (the partner role writes no Inquiry), the request locked and
 *      read again there (still the party's, still undecided, at the version the person read): WITHDRAWN with when and by whom —
 *      the portal person (the database requires exactly that: a PARTNER user of the request's own customer), its audit row and
 *      `inquiry.closed` WITHDRAWN (the office's followers are told; Incoming's live rows move);
 *   4. the answer: the request as the customer now reads it ("Withdrawn", under Closed).
 * The thread stays open: the customer may still write, and the office answer.
 */

export interface WithdrawBody {
  readonly version: number
}

function refusal(code: WithdrawRefusal, locale: string | null | undefined): DomainError {
  const words = WITHDRAW_WORDS[code][partnerLocaleOf(locale)]
  return new DomainError('conflict', words, [{ path: `refusal/${code}`, message: words }])
}

export async function withdrawRequest(app: FastifyInstance, request: FastifyRequest, inquiryId: string, body: WithdrawBody, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const { session } = reader
  if (session.preview) throw new ForbiddenError('A preview of the portal withdraws no request.')
  const locale = session.person.locale
  const seen = await partnerRequest(request, session.company.id, inquiryId)
  const early = withdrawRefusal(seen.status as InquiryStatus)
  if (early) throw refusal(early, locale)

  const p = portalOf(app)
  await p.auth
    .command(p.auth.contextFor(request, session.tenantId, session.userId), { name: 'portalRequests.withdraw', idempotencyKey, input: { inquiryId, version: body.version, sessionId: session.id } }, async (tools) => {
      await tools.tx.$queryRaw`SELECT id FROM "Inquiry" WHERE id = ${seen.id}::uuid FOR UPDATE`
      const row = await readInquiryRow(tools.tx, seen.id)
      // Still the session's own request of the portal's company (the tenant scope reads every party: checked again here).
      if (!row || row.partyId !== session.partyId || row.companyId !== session.company.id) throw new NotFoundError('Request not found.')
      const again = withdrawRefusal(row.status as InquiryStatus)
      if (again) throw refusal(again, locale)
      if (row.version !== body.version) throw new StaleVersionError('Inquiry', row.id, row.version, body.version)
      await writeInquiry(tools, row, { status: 'WITHDRAWN', closedAt: tools.now, closedById: session.userId })
      tools.audit({ action: 'portalRequests.withdraw', recordType: 'Inquiry', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'WITHDRAWN', closedAt: toUtcIso(tools.now), byPartner: true } })
      tools.emit({ type: 'inquiry.closed', subject: row.id, companyId: row.companyId, payload: { inquiryId: row.id, number: row.number, status: 'WITHDRAWN', previousStatus: row.status, quoteId: null, salesOrderId: null, declineReason: null, partyId: row.partyId } })
      return null
    })
    .catch(databaseRefusal)
  return { request: await requestViewOf(reader, request, await partnerRequest(request, session.company.id, seen.id)) }
}
