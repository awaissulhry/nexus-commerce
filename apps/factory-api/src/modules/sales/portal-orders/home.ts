import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { PORTAL_SALES_ORDERS_VIEW } from '@nexus/factory-domain/sales/portal-orders/permissions'
import { isOnTheWay } from '@nexus/factory-domain/sales/portal-orders/shipments'
import { isOpenForCustomer, isStillToShip, weekOf } from '@nexus/factory-domain/sales/portal-orders/status'
import type { HomeSource } from '../../../platform/portal/home/sources'
import { portalReader } from './access'
import { statusOfOrder } from './orders'
import { dayOrNull, readOrders, readShipments } from './store'

/**
 * B-W2b-175: a customer's Home counts of its orders (design portal.customer.home "At a glance": Open orders, In production,
 * Shipping this week; "Your next deliveries" is the list itself: GET /portal/sales-orders?chip=OPEN&limit=5&progress=true;
 * portal.customer.orders "On the way"). Read in the party's scope, in the portal's company; null for a person whose role
 * does not see the orders (fails closed: the tile shows nothing).
 *
 *   orders.open                 orders not delivered or cancelled yet
 *   orders.in_production        orders in production
 *   orders.shipping_this_week   orders with pieces still to leave, promised this week (Monday to Sunday, Rome)
 *   orders.in_transit           shipments on the way to them
 */
export const SALES_ORDER_COUNTS: HomeSource = Object.freeze<HomeSource>({
  name: 'salesOrders',
  counts: [
    { key: 'orders.open', area: 'orders', kinds: ['CUSTOMER'], words: { it: 'Ordini aperti', en: 'Open orders' } },
    { key: 'orders.in_production', area: 'orders', kinds: ['CUSTOMER'], words: { it: 'In produzione', en: 'In production' } },
    { key: 'orders.shipping_this_week', area: 'orders', kinds: ['CUSTOMER'], words: { it: 'In spedizione questa settimana', en: 'Shipping this week' } },
    { key: 'orders.in_transit', area: 'orders', kinds: ['CUSTOMER'], words: { it: 'In viaggio', en: 'On the way' } },
  ],
  async read(app, request, now) {
    const reader = portalReader(app, request)
    const none = { 'orders.open': null, 'orders.in_production': null, 'orders.shipping_this_week': null, 'orders.in_transit': null }
    if (!can(reader.actor, PORTAL_SALES_ORDERS_VIEW, { companyId: reader.session.company.id, partyId: reader.session.partyId })) return none
    const { orders, shipments } = await request.withClient(async (client) => {
      const orders = await readOrders(client, reader.session.company.id)
      return { orders, shipments: await readShipments(client, orders.map((order) => order.id)) }
    })
    const week = weekOf(businessDate(now))
    const statuses = orders.map((order) => ({ order, status: statusOfOrder(order, shipments.filter((row) => row.salesOrderId === order.id)) }))
    const promised = (day: string | null): boolean => day !== null && day >= week.from && day <= week.to
    return {
      'orders.open': statuses.filter((entry) => isOpenForCustomer(entry.status)).length,
      'orders.in_production': statuses.filter((entry) => entry.status === 'IN_PRODUCTION').length,
      'orders.shipping_this_week': statuses.filter((entry) => isStillToShip(entry.status) && promised(dayOrNull(entry.order.promiseDate))).length,
      'orders.in_transit': shipments.filter((row) => isOnTheWay(row.status)).length,
    }
  },
})
