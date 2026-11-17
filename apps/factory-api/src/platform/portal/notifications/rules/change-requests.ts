import { can } from '@nexus/factory-domain/core/permissions'
import { events as changeRequestEvents } from '@nexus/factory-domain/sales-change-requests/events'
import { PORTAL_SALES_ORDERS_VIEW } from '@nexus/factory-domain/sales/portal-orders/permissions'
import { PORTAL_HOME_VIEW } from '@nexus/factory-domain/portal/tasks/permissions'
import type { PartnerMessageKey } from '@nexus/factory-domain/portal/notifications/messages'
// B-PR-31: every kind of request (the production asks beside change and cancel).
import { isSalesRequestKind, type OrderRequestKind } from '@nexus/factory-domain/sales/change-requests/rules'
import type { PartnerReader } from '../../tasks/people'
import type { PartnerRule } from './types'
import { orderNamed } from './records' // th2-backend step 7
import { productionReader } from './production' // B-PR-31

/**
 * The office's answer to a customer's change or cancel request (B-W2b-183; SAL-077, SAL-078: "the customer gets the answer
 * by mail"). `order_change_request.answered` → every reader of the order's party who sees its orders in the portal
 * (portal.home.view and portal.salesOrders.view over the order's company and party) is told "Your change request on SO-… was accepted / was not
 * accepted" (topic ORDERS: transactional, always mailed at once). The words of the answer stay on the order's page (the
 * notification opens the order at the request): a sentence never carries free text, an amount or an office person.
 *
 * B-PR-31 (production plan §6 "Notifications" L15; walls PW-P07, PW-15): every kind — the production asks' answers (urgent,
 * pause, resume, ship what is ready, another sample) are production news (topic PRODUCTION, the keys `portal.production.<kind>_
 * accepted|refused`) for the customer's people who see its production (./production.ts productionReader); and our COUNTER-OFFER
 * to any ask (`order_change_request.countered`): "We answered your request on your order 12 with a counter-offer: it waits for
 * your answer", while it still waits — order news for a change or cancel (ORDERS, as their answers), production news for a
 * production ask. Never the counter's date, fee or words (the page and Waiting for you show them, by role). The customer's own
 * answer to our counter (`counter_answered`) tells it nothing: it gave it.
 */

const KEYS: Readonly<Record<OrderRequestKind, Readonly<Record<'ACCEPTED' | 'REFUSED', PartnerMessageKey>>>> = Object.freeze({
  CHANGE: { ACCEPTED: 'portal.order.change_accepted', REFUSED: 'portal.order.change_refused' },
  CANCEL: { ACCEPTED: 'portal.order.cancel_accepted', REFUSED: 'portal.order.cancel_refused' },
  // B-PR-31: the production asks (B-PR-24 widened the event's kinds).
  RUSH: { ACCEPTED: 'portal.production.rush_accepted', REFUSED: 'portal.production.rush_refused' },
  HOLD: { ACCEPTED: 'portal.production.hold_accepted', REFUSED: 'portal.production.hold_refused' },
  RESUME: { ACCEPTED: 'portal.production.resume_accepted', REFUSED: 'portal.production.resume_refused' },
  SPLIT_SHIPMENT: { ACCEPTED: 'portal.production.split_accepted', REFUSED: 'portal.production.split_refused' },
  SAMPLE_ROUND: { ACCEPTED: 'portal.production.sample_accepted', REFUSED: 'portal.production.sample_refused' },
})

const answered = changeRequestEvents.find((event) => event.type === 'order_change_request.answered')!
const countered = changeRequestEvents.find((event) => event.type === 'order_change_request.countered')! // B-PR-31

/** Who reads a request's news: a change or cancel the people who see the orders; a production ask the people who see production. */
function readersOf(kind: OrderRequestKind, place: { readonly companyId: string; readonly partyId: string }): (reader: PartnerReader) => boolean {
  if (!isSalesRequestKind(kind)) return productionReader(place) // B-PR-31
  return (reader) => can(reader.actor, PORTAL_HOME_VIEW, place) && can(reader.actor, PORTAL_SALES_ORDERS_VIEW, place)
}

export const CHANGE_REQUEST_RULES: readonly PartnerRule[] = Object.freeze([
  {
    name: 'portalNews.changeRequestAnswered',
    events: ['order_change_request.answered'],
    async drafts(context, raw) {
      const event = answered.payload.parse(raw) as { requestId: string; orderId: string; kind: OrderRequestKind; answer: 'ACCEPTED' | 'REFUSED' }
      // B-PR-24 widened the event's kinds to the production asks; B-PR-31 tells their answers too (KEYS: every kind).
      const key = Object.hasOwn(KEYS, event.kind) ? KEYS[event.kind][event.answer] : undefined
      if (key === undefined) return []
      const order = await context.tx.salesOrder.findUnique({ where: { id: event.orderId }, select: { id: true, number: true, companyId: true, partyId: true, customerSeq: true } })
      if (!order) return []
      const place = { companyId: order.companyId, partyId: order.partyId }
      // th2-backend step 7 (§0.5): the order by the customer's own number ("#12", "your order 12"), never SO-….
      const named = orderNamed(order)
      return [
        {
          partyId: order.partyId,
          companyId: order.companyId,
          record: named.record,
          messageKey: key,
          params: named.params,
          anchor: `change-request:${event.requestId}`,
          forReader: readersOf(event.kind, place),
        },
      ]
    },
  },
  // ---- B-PR-31: our counter-offer to a customer's ask — it waits for the customer's answer ---------------------------------------
  {
    name: 'portalNews.changeRequestCountered',
    events: ['order_change_request.countered'],
    async drafts(context, raw) {
      const event = countered.payload.parse(raw) as { requestId: string; orderId: string; partyId: string; kind: OrderRequestKind; approvalRequestId: string }
      // The request by its own row (W06: its customer and order, never the event's word), still countered with THIS counter, and
      // the counter still waiting: a counter answered or lapsed before the worker came is no news.
      const request = await context.tx.orderChangeRequest.findUnique({ where: { id: event.requestId }, select: { id: true, orderId: true, partyId: true, kind: true, status: true, counterApprovalId: true } })
      if (!request || request.status !== 'COUNTERED' || request.counterApprovalId !== event.approvalRequestId || request.orderId !== event.orderId) return []
      const approval = await context.tx.approvalRequest.findUnique({ where: { id: event.approvalRequestId }, select: { status: true, partyId: true } })
      if (!approval || approval.status !== 'OPEN' || approval.partyId !== request.partyId) return []
      const order = await context.tx.salesOrder.findUnique({ where: { id: request.orderId }, select: { id: true, companyId: true, partyId: true, customerSeq: true } })
      if (!order || order.partyId !== request.partyId) return []
      const kind = request.kind as OrderRequestKind
      const named = orderNamed(order)
      return [
        {
          partyId: order.partyId,
          companyId: order.companyId,
          record: named.record,
          messageKey: isSalesRequestKind(kind) ? 'portal.order.countered' : 'portal.production.countered',
          params: named.params,
          anchor: `change-request:${request.id}`,
          forReader: readersOf(kind, { companyId: order.companyId, partyId: order.partyId }),
        },
      ]
    },
  },
  // ---- end B-PR-31
])
