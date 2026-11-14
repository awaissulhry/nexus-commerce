import type { Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { events as paymentEvents } from '@nexus/factory-domain/payments/events'
import { PAYMENTS_VIEW } from '@nexus/factory-domain/payments/permissions'
import { WORKORDERS_RELEASE } from '@nexus/factory-domain/production/work-orders/permissions'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { Draft, FanOutRule, RuleContext } from '../../../platform/notifications/fan-out'

/**
 * Payment received notices to staff (B-W2b-402; FIN-128: "payment received notices to staff … a paid deposit unlocks
 * production"; design finance.payments conn "Production — Deposit paid unlocks the order (W2b)"). Quiet: only the people
 * these rules name, never the person who recorded it, never "everyone who may see payments":
 *
 *   payment.recorded       SYSTEM to the people who follow the customer (not muted) and the makers of the orders the payment
 *                          was placed on, each while they may see the customer's payments (payments.view) and reach Home; the
 *                          amount only for a reader with the price grain ({figure}). A voided payment tells nobody.
 *   payment.deposit_paid   SYSTEM to the order's maker (orders.view) and the people who release work orders at the order's
 *                          company (workorders.release): the deposit gate of its work orders is open (the release check reads
 *                          the request PAID at once). A balance-before-shipping request is not a deposit: nobody.
 * B-W2b-403 (FIN-169, the money notifications' settings) decides more audiences on these same rules; it adds no second rule.
 */

const payloadOf = (type: string) => paymentEvents.find((event) => event.type === type)!.payload

export const PAYMENT_NOTICE_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'payments.received',
    events: ['payment.recorded'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('payment.recorded').parse(raw) as { paymentId: string; partyId: string }
      const payment = await context.tx.payment.findUnique({ where: { id: payload.paymentId }, select: { id: true, companyId: true, partyId: true, amount: true, currency: true, status: true, createdById: true } })
      if (!payment || payment.status !== 'RECEIVED') return []
      const party = await context.tx.party.findUnique({ where: { id: payment.partyId }, select: { legalName: true } })
      const followers = await context.tx.recordFollower.findMany({ where: { recordType: 'Party', recordId: payment.partyId, muted: false }, select: { userId: true } })
      const allocations = await context.tx.paymentAllocation.findMany({ where: { paymentId: payment.id }, select: { invoice: { select: { salesOrderId: true } }, depositRequest: { select: { orderId: true } } } })
      const orderIds = [...new Set(allocations.flatMap((allocation) => [allocation.invoice?.salesOrderId ?? null, allocation.depositRequest?.orderId ?? null]).filter((id): id is string => id !== null))]
      const makers = orderIds.length === 0 ? [] : await context.tx.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { createdById: true } })
      const people = [...new Set([...followers.map((row) => row.userId), ...makers.map((row) => row.createdById).filter((id): id is string => id !== null)])]
      const scope = { companyId: payment.companyId, partyId: payment.partyId }
      const drafts: Draft[] = []
      for (const userId of people) {
        const reader = await context.reader(userId)
        if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, PAYMENTS_VIEW, scope)) continue
        const figure: Record<string, Prisma.InputJsonValue> = heldGrains(reader.actor).has('price') ? { netAmount: markMoney('price', { minor: payment.amount, currency: payment.currency }) as unknown as Prisma.InputJsonValue } : {}
        drafts.push({
          userId,
          category: 'SYSTEM',
          record: { type: 'Payment', id: payment.id, label: party?.legalName ?? '' },
          companyId: payment.companyId,
          anchor: null,
          messageKey: 'notifications.payments.received',
          params: { paymentId: payment.id, ...figure },
          actorId: payment.createdById,
        })
      }
      return drafts
    },
  },
  {
    name: 'payments.depositPaid',
    events: ['payment.deposit_paid'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf('payment.deposit_paid').parse(raw) as { depositRequestId: string; partyId: string; orderId: string | null }
      const request = await context.tx.depositRequest.findUnique({ where: { id: payload.depositRequestId }, select: { status: true, companyId: true, partyId: true, orderId: true, milestones: { select: { kind: true } } } })
      if (!request || request.status !== 'PAID' || !request.orderId || request.milestones.some((milestone) => milestone.kind === 'BEFORE_SHIPPING')) return []
      const order = await context.tx.salesOrder.findUnique({ where: { id: request.orderId }, select: { id: true, number: true, createdById: true } })
      if (!order) return []
      const scope = { companyId: request.companyId, partyId: request.partyId }
      const drafts: Draft[] = []
      for (const userId of await context.people()) {
        const reader = await context.reader(userId)
        if (!reader || !holds(reader.actor, HOME_VIEW)) continue
        const maker = userId === order.createdById && can(reader.actor, ORDERS_VIEW, scope)
        if (!maker && !can(reader.actor, WORKORDERS_RELEASE, { companyId: request.companyId })) continue
        drafts.push({
          userId,
          category: 'SYSTEM',
          record: { type: 'SalesOrder', id: order.id, label: order.number },
          companyId: request.companyId,
          anchor: `deposit:${payload.depositRequestId}`,
          messageKey: 'notifications.payments.depositPaid',
          params: { depositRequestId: payload.depositRequestId },
          actorId: null,
        })
      }
      return drafts
    },
  },
])
