import { OWNER_TEMPLATE } from '@nexus/factory-domain/auth/roles/custom'
import { brandPriceChangedByCustomer } from '@nexus/factory-domain/brand-prices/events'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { liveAssignment } from '../../../platform/auth/roles/access'
import type { Draft, FanOutRule, RuleContext } from '../../../platform/notifications/fan-out'
import { PRICE_PERMISSION } from './store'

/**
 * B-CP-021 (customer page plan C3; design customer-page 11 §1.2 "Notification"; review F4): ONE alert when the customer changes
 * its own price in its portal (sales_order.brand_price_changed_by_customer, ./portal.ts) — "Customer's price changed on order
 * {record}" (factory-domain notifications/rules notifications.priceCheck.customerChanged) — to:
 *
 *   the order's maker   who made the order (SalesOrder.createdById), and
 *   the Owner           every person holding the ready-made Owner role now,
 *
 * EACH only while they hold the price grain over the order's company and customer at fan-out (the money wall: a Sales worker who
 * made the order, a Production manager, the floor are never told — the alert itself says a price moved), reach the order
 * (orders.view, the brand wall) and Home. Category ALERT (the bell; mail and push by their own choice). Its words hold no amount
 * and no "not equal"; its params name the order only. NEVER a thread line: a message in the order's thread would show the change
 * to everyone who reads it. The alerts' own rules (platform/alerts/built-in.ts) are scheduled exception checks per role, not a
 * fan-out of an event: this rule joins the notification fan-out (platform/notifications/rules/index.ts) instead.
 */

/** The people holding the ready-made Owner role now (a tenant has one or a few). */
async function ownersOf(context: RuleContext): Promise<string[]> {
  const rows = await context.tx.roleAssignment.findMany({ where: { ...liveAssignment(context.now), role: { audience: 'OFFICE', system: true, key: OWNER_TEMPLATE } }, select: { userId: true }, orderBy: { userId: 'asc' } })
  return [...new Set(rows.map((row) => row.userId))]
}

export const BRAND_PRICE_NOTICE_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'brandPrices.customerChanged',
    events: ['sales_order.brand_price_changed_by_customer'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = brandPriceChangedByCustomer.payload.parse(raw)
      const order = await context.tx.salesOrder.findUnique({ where: { id: payload.orderId }, select: { id: true, number: true, companyId: true, partyId: true, createdById: true } })
      if (!order) return []
      const scope = { companyId: order.companyId, partyId: order.partyId }
      const people = [...new Set([...(order.createdById ? [order.createdById] : []), ...(await ownersOf(context))])]
      const drafts: Draft[] = []
      for (const userId of people) {
        const reader = await context.reader(userId)
        if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, ORDERS_VIEW, scope)) continue
        // The money wall, at fan-out: only a price holder over this order is told.
        if (!can(reader.actor, PRICE_PERMISSION, scope)) continue
        drafts.push({ userId, category: 'ALERT', record: { type: 'SalesOrder', id: order.id, label: order.number }, companyId: order.companyId, anchor: 'price-check', messageKey: 'notifications.priceCheck.customerChanged', params: { orderId: order.id }, actorId: null })
      }
      return drafts
    },
  },
])
