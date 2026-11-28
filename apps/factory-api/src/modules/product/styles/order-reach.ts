import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { anyOf, holds, NO_ROWS, scopeWhere, type WhereClause } from '@nexus/factory-domain/core/permissions'
import { ORDERS_VIEW, ORDERS_VIEW_OWN } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'

/**
 * Which sales orders a person reads where a product shows its orders (owb-pd1 1.1 "Where it is used", 1.2 the list's `openOrders`):
 * orders.view over the order's company and customer (a role limited to some customers reads only theirs: the brand wall), and —
 * base settle 9, plan.md § 5 D R20 — with orders.view.own the orders the person is on. Neither right: null (the product's orders
 * are not this person's to read).
 *
 * "On the order" is S2's ONE helper (`ordersUserIsOn`, apps/factory-api/src/modules/sales/orders/on-the-order.ts, PR owb-of1a). Until
 * that lands, `ordersOn` below reads the same three facts S2 named (LF shared-asks.md 08:27): a RecordFollower row of the person on
 * the SalesOrder or on its PortalOrderRequest (any reason, muted too), or the person is the order's customer's factory designer or
 * its backup (PortalSettings). When of1a is on main, `ordersOn` becomes one call to `ordersUserIsOn` (the S4 lead swaps it).
 */

type Reader = FactoryClient | CommandTx

const ORDER_SCOPE = { company: 'companyId', party: 'partyId' } as const

/** The orders not done yet: their lines still count as open work of the product. */
export const OPEN_ORDER: Prisma.SalesOrderWhereInput = { status: { notIn: ['CANCELLED', 'CLOSED', 'DELIVERED'] } }

/** The sales order ids the person is on (see the header: S2's helper replaces this when of1a lands). */
export async function ordersOn(client: Reader, userId: string): Promise<string[]> {
  // One query after another: a transaction client runs one at a time anyway.
  const followed = await client.recordFollower.findMany({ where: { userId, recordType: { in: ['SalesOrder', 'PortalOrderRequest'] } }, select: { recordType: true, recordId: true } })
  const orderIds = new Set(followed.filter((row) => row.recordType === 'SalesOrder').map((row) => row.recordId))
  const requestIds = followed.filter((row) => row.recordType === 'PortalOrderRequest').map((row) => row.recordId)
  if (requestIds.length > 0) {
    const requests = await client.portalOrderRequest.findMany({ where: { id: { in: requestIds }, salesOrderId: { not: null } }, select: { salesOrderId: true } })
    for (const request of requests) if (request.salesOrderId) orderIds.add(request.salesOrderId)
  }
  const designed = await client.portalSettings.findMany({ where: { OR: [{ factoryDesignerId: userId }, { factoryDesignerBackupId: userId }] }, select: { partyId: true } })
  if (designed.length > 0) {
    const orders = await client.salesOrder.findMany({ where: { partyId: { in: designed.map((row) => row.partyId) } }, select: { id: true } })
    for (const order of orders) orderIds.add(order.id)
  }
  return [...orderIds]
}

/** The orders the person reads here, as a `where` on SalesOrder; null without orders.view and orders.view.own. */
export async function orderReach(client: Reader, context: RequestContext): Promise<Prisma.SalesOrderWhereInput | null> {
  const actor = actorOf(context)
  const viewing = holds(actor, ORDERS_VIEW)
  const own = holds(actor, ORDERS_VIEW_OWN) && context.audience === 'office'
  if (!viewing && !own) return null
  const clauses: WhereClause[] = []
  if (viewing) clauses.push(scopeWhere(actor, ORDERS_VIEW, ORDER_SCOPE))
  if (own && context.audience === 'office') {
    const ids = await ordersOn(client, context.actorId)
    const scoped = scopeWhere(actor, ORDERS_VIEW_OWN, ORDER_SCOPE)
    clauses.push(ids.length === 0 || scoped === NO_ROWS ? NO_ROWS : { AND: [scoped, { id: { in: ids } }] })
  }
  return anyOf(clauses) as Prisma.SalesOrderWhereInput
}
