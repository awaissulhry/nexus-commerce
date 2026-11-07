import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { orderChangeRequestWords } from '@nexus/factory-domain/insights/words'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { capped, partyNames, SOURCE_LIMIT, type Source } from './common'

/**
 * Customers' change and cancel requests from the portal waiting for the office's answer (B-W2b-183; SAL-077, SAL-078; design
 * home.approvals "one inbox for every request that needs my yes", portal.customer.orders conn "the change request lands" in
 * the office). An OPEN request of an order the viewer sees (orders.view over its company and customer); it is the viewer's
 * when they manage that customer's orders (orders.manage: insights/attention's act). The row opens the order (its Changes
 * tab answers it: modules/sales/change-requests accept / refuse); one row per request. Oldest first: the customer waits.
 */
export const portalChangeRequests: Source = async ({ caller, viewer }) => {
  const scope = scopeWhere(viewer.actor, ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.OrderChangeRequestWhereInput
  return caller.withClient(async (db) => {
    const found = await db.orderChangeRequest.findMany({
      where: { AND: [scope, { status: 'OPEN' }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: SOURCE_LIMIT + 1,
      select: { id: true, companyId: true, partyId: true, orderId: true, kind: true, createdAt: true },
    })
    const { rows, complete } = capped(found, SOURCE_LIMIT)
    const ids = rows.map((row) => row.id)
    const orders = new Map((rows.length > 0 ? await db.salesOrder.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.orderId))] } }, select: { id: true, number: true } }) : []).map((row) => [row.id, row.number]))
    const cells = ids.length > 0 ? await db.orderChangeRequestLine.findMany({ where: { requestId: { in: ids } }, select: { requestId: true, orderLineId: true, size: true } }) : []
    const names = await partyNames(db, rows.map((row) => row.partyId))
    const candidates: AttentionCandidate[] = rows.map((row) => {
      const own = cells.filter((cell) => cell.requestId === row.id)
      const number = orders.get(row.orderId) ?? 'an order'
      return {
        kind: 'ORDER_CHANGE_REQUEST',
        state: row.kind,
        severity: 'MEDIUM',
        record: { type: 'SalesOrder', id: row.orderId, label: number },
        scope: { companyId: row.companyId, siteId: null, partyId: row.partyId },
        ...orderChangeRequestWords({ number, customer: names.get(row.partyId) ?? 'The customer', kind: row.kind, sizes: own.filter((cell) => cell.size !== null).length, lines: new Set(own.map((cell) => cell.orderLineId)).size }),
        due: null,
        since: row.createdAt,
        // One row per request (an order has at most one OPEN, but an answered one may be followed by another).
        subKey: row.id,
      }
    })
    return { kind: 'ORDER_CHANGE_REQUEST', candidates, complete }
  })
}
