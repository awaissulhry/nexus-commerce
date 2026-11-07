import { can } from '@nexus/factory-domain/core/permissions'
import { events as changeRequestEvents } from '@nexus/factory-domain/sales-change-requests/events'
import { PORTAL_SALES_ORDERS_VIEW } from '@nexus/factory-domain/sales/portal-orders/permissions'
import { PORTAL_HOME_VIEW } from '@nexus/factory-domain/portal/tasks/permissions'
import type { PartnerMessageKey } from '@nexus/factory-domain/portal/notifications/messages'
import type { PartnerRule } from './types'

/**
 * The office's answer to a customer's change or cancel request (B-W2b-183; SAL-077, SAL-078: "the customer gets the answer
 * by mail"). `order_change_request.answered` → every reader of the order's party who sees its orders in the portal
 * (portal.home.view and portal.salesOrders.view over the order's company and party) is told "Your change request on SO-… was accepted / was not
 * accepted" (topic ORDERS: transactional, always mailed at once). The words of the answer stay on the order's page (the
 * notification opens the order at the request): a sentence never carries free text, an amount or an office person.
 */

const KEYS: Readonly<Record<'CHANGE' | 'CANCEL', Readonly<Record<'ACCEPTED' | 'REFUSED', PartnerMessageKey>>>> = Object.freeze({
  CHANGE: { ACCEPTED: 'portal.order.change_accepted', REFUSED: 'portal.order.change_refused' },
  CANCEL: { ACCEPTED: 'portal.order.cancel_accepted', REFUSED: 'portal.order.cancel_refused' },
})

const answered = changeRequestEvents.find((event) => event.type === 'order_change_request.answered')!

export const CHANGE_REQUEST_RULES: readonly PartnerRule[] = Object.freeze([
  {
    name: 'portalNews.changeRequestAnswered',
    events: ['order_change_request.answered'],
    async drafts(context, raw) {
      const event = answered.payload.parse(raw) as { requestId: string; orderId: string; kind: 'CHANGE' | 'CANCEL'; answer: 'ACCEPTED' | 'REFUSED' }
      const order = await context.tx.salesOrder.findUnique({ where: { id: event.orderId }, select: { id: true, number: true, companyId: true, partyId: true } })
      if (!order) return []
      const place = { companyId: order.companyId, partyId: order.partyId }
      return [
        {
          partyId: order.partyId,
          companyId: order.companyId,
          record: { type: 'SalesOrder', id: order.id, label: order.number },
          messageKey: KEYS[event.kind][event.answer],
          params: {},
          anchor: `change-request:${event.requestId}`,
          forReader: (reader) => can(reader.actor, PORTAL_HOME_VIEW, place) && can(reader.actor, PORTAL_SALES_ORDERS_VIEW, place),
        },
      ]
    },
  },
])
