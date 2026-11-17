import { can } from '@nexus/factory-domain/core/permissions'
import { events as portalOrderingEvents } from '@nexus/factory-domain/portal-ordering/events'
import { PORTAL_HOME_VIEW } from '@nexus/factory-domain/portal/tasks/permissions'
import { events as inquiryEvents } from '@nexus/factory-domain/sales-inquiries/events'
import { PORTAL_ORDER_REQUESTS_MANAGE } from '@nexus/factory-domain/sales/portal-ordering/permissions'
import { PORTAL_SALES_ORDERS_VIEW } from '@nexus/factory-domain/sales/portal-orders/permissions'
import type { PartnerDraft, PartnerRule } from './types'

/**
 * A customer's requests in its portal news and mail (B-TH-011; threads plan N24, L2-G05, L2-G19; design P-CUS-NEW.receipt-F02,
 * X-P-CUS-REQ.state). Each names ONE party (the request's) and its readers who see requests in the portal (portal.home.view and
 * portal.salesOrders.view over the request's company and party): never another party (W06), never an office person, the close
 * words or an amount. Topic ORDERS (transactional: mailed at once).
 *
 *   inquiry.received   a request the customer sent from the portal: "We received your request INQ-… (your request 7)" — the
 *                      copy of what was sent (the receipt mail, P-CUS-NEW.receipt-F02), the one news a partner gets of its own act
 *   inquiry.changed    NEED_INFO: "We need something from you on your request INQ-…" (the question is the thread's message)
 *   inquiry.closed     DECLINED: "Your request INQ-… was declined" (our message, if any, is the thread's)
 *   portal_order_request.refused   a catalogue order we did not accept (its words are on its page), to who may order
 */

const payloadOf = <T>(list: readonly { readonly type: string; readonly payload: { parse(value: unknown): unknown } }[], type: string) => (raw: unknown) => list.find((event) => event.type === type)!.payload.parse(raw) as T
const received = payloadOf<{ inquiryId: string; source: string; partyId: string | null }>(inquiryEvents, 'inquiry.received')
const changed = payloadOf<{ inquiryId: string; status: string; change: string; partyId: string | null }>(inquiryEvents, 'inquiry.changed')
const closed = payloadOf<{ inquiryId: string; status: string; partyId: string | null }>(inquiryEvents, 'inquiry.closed')
const refused = payloadOf<{ requestId: string; number: string; partyId: string }>(portalOrderingEvents, 'portal_order_request.refused')

type RequestKey = 'portal.request.received' | 'portal.request.need_info' | 'portal.request.declined'

async function requestNews(context: Parameters<PartnerRule['drafts']>[0], inquiryId: string, messageKey: RequestKey, expected: (status: string) => boolean): Promise<PartnerDraft[]> {
  const inquiry = await context.tx.inquiry.findUnique({ where: { id: inquiryId }, select: { id: true, number: true, companyId: true, partyId: true, status: true, customerSeq: true } })
  // A prospect's request has nobody in a portal; a request that moved on meanwhile is not told stale news.
  if (!inquiry || inquiry.partyId === null || !expected(inquiry.status)) return []
  const place = { companyId: inquiry.companyId, partyId: inquiry.partyId }
  return [
    {
      partyId: inquiry.partyId,
      companyId: inquiry.companyId,
      record: { type: 'Inquiry', id: inquiry.id, label: inquiry.number },
      messageKey,
      params: { yourSeq: inquiry.customerSeq },
      anchor: null,
      forReader: (reader) => can(reader.actor, PORTAL_HOME_VIEW, place) && can(reader.actor, PORTAL_SALES_ORDERS_VIEW, place),
    },
  ]
}

export const REQUEST_NEWS_RULES: readonly PartnerRule[] = Object.freeze([
  {
    name: 'portalNews.requestReceived',
    events: ['inquiry.received'],
    async drafts(context, raw) {
      const event = received(raw)
      if (event.source !== 'PORTAL') return []
      return requestNews(context, event.inquiryId, 'portal.request.received', () => true)
    },
  },
  {
    name: 'portalNews.requestNeedInfo',
    events: ['inquiry.changed'],
    async drafts(context, raw) {
      const event = changed(raw)
      if (event.change !== 'NEED_INFO') return []
      return requestNews(context, event.inquiryId, 'portal.request.need_info', (status) => status === 'NEED_INFO')
    },
  },
  {
    name: 'portalNews.requestDeclined',
    events: ['inquiry.closed'],
    async drafts(context, raw) {
      const event = closed(raw)
      if (event.status !== 'DECLINED') return []
      return requestNews(context, event.inquiryId, 'portal.request.declined', (status) => status === 'DECLINED')
    },
  },
  {
    name: 'portalNews.orderRequestRefused',
    events: ['portal_order_request.refused'],
    async drafts(context, raw) {
      const event = refused(raw)
      const row = await context.tx.portalOrderRequest.findUnique({ where: { id: event.requestId }, select: { id: true, number: true, companyId: true, partyId: true, status: true } })
      if (!row || row.status !== 'REFUSED') return []
      const place = { companyId: row.companyId, partyId: row.partyId }
      return [
        {
          partyId: row.partyId,
          companyId: row.companyId,
          record: { type: 'PortalOrderRequest', id: row.id, label: row.number ?? event.number },
          messageKey: 'portal.order_request.refused',
          params: {},
          anchor: null,
          forReader: (reader) => can(reader.actor, PORTAL_HOME_VIEW, place) && can(reader.actor, PORTAL_ORDER_REQUESTS_MANAGE, place),
        },
      ]
    },
  },
])
