import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { anyOf, holds, NO_ROWS, scopeWhere, type WhereClause } from '@nexus/factory-domain/core/permissions'
import { ORDERS_VIEW, ORDERS_VIEW_OWN } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { ordersUserIsOn } from '../../sales/orders/on-the-order'

/**
 * Which sales orders a person reads where a product shows its orders (owb-pd1 1.1 "Where it is used", 1.2 the list's `openOrders`):
 * orders.view over the order's company and customer (a role limited to some customers reads only theirs: the brand wall), and —
 * base settle 9, plan.md § 5 D R20 — with orders.view.own the orders the person is on. Neither right: null (the product's orders
 * are not this person's to read).
 *
 * "On the order" is S2's ONE rule (`ordersUserIsOn`, modules/sales/orders/on-the-order.ts, owb-of1a #2044): a RecordFollower row of
 * the person on the SalesOrder or its PortalOrderRequest, or the person is the order's customer's Factory designer or backup.
 */

type Reader = FactoryClient | CommandTx

const ORDER_SCOPE = { company: 'companyId', party: 'partyId' } as const

/** The orders not done yet: their lines still count as open work of the product. */
export const OPEN_ORDER: Prisma.SalesOrderWhereInput = { status: { notIn: ['CANCELLED', 'CLOSED', 'DELIVERED'] } }

/** The orders the person reads here, as a `where` on SalesOrder; null without orders.view and orders.view.own. */
export async function orderReach(client: Reader, context: RequestContext): Promise<Prisma.SalesOrderWhereInput | null> {
  const actor = actorOf(context)
  const viewing = holds(actor, ORDERS_VIEW)
  const own = holds(actor, ORDERS_VIEW_OWN) && context.audience === 'office'
  if (!viewing && !own) return null
  const clauses: WhereClause[] = []
  if (viewing) clauses.push(scopeWhere(actor, ORDERS_VIEW, ORDER_SCOPE))
  if (own && context.audience === 'office') {
    const ids = (await ordersUserIsOn(client, { tenantId: context.tenantId, userId: context.actorId })).salesOrderIds
    const scoped = scopeWhere(actor, ORDERS_VIEW_OWN, ORDER_SCOPE)
    clauses.push(ids.length === 0 || scoped === NO_ROWS ? NO_ROWS : { AND: [scoped, { id: { in: ids } }] })
  }
  return anyOf(clauses) as Prisma.SalesOrderWhereInput
}
