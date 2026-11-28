import type { FactoryClient } from '@nexus/factory-db'
import type { CommandTx } from '../../core/command'
import type { RequestContext, OfficeContext } from '../../core/context'
import { ORDERS_VIEW, ORDERS_VIEW_OWN } from '@nexus/factory-domain/sales/orders/permissions'
import { mayOn } from '../../modules/sales/orders/access'
import { maySeeOrder, ORDER_RECORD, ownOrdersOf, REQUEST_RECORD } from '../../modules/sales/orders/on-the-order'
import type { WallScope } from './records'
import type { RecordRef } from './threads'

/**
 * The designer wall on an order's thread (owb- order workflow, S1 po2.4; plan.md § 5 D, R20 "the designer sees only his orders"; lead
 * 88's ask 2026-11-28 07:27): the thread of a SalesOrder — and of its Draft or Sent order, a PortalOrderRequest — is read in the office
 * only with orders.view over the order's scope, OR orders.view.own while the person is on the order. The ONE rule is S2's
 * (modules/sales/orders/on-the-order.ts `maySeeOrder`: a RecordFollower row on the order or its request, the customer's Factory
 * designer slot) — imported, never copied. Beside threads.read (mayOnThread), never instead of it. Any other record, a portal, a link
 * or the floor: as before. Out of reach = not found (the caller says it), absent from a list.
 */

export const ORDER_THREAD_TYPES: ReadonlySet<string> = new Set([ORDER_RECORD, REQUEST_RECORD])

/** Whether the office reader may read this order's thread beside threads.read (true for every other record and reader). */
export async function orderWallHolds(client: FactoryClient | CommandTx, context: RequestContext, record: RecordRef, scope: WallScope): Promise<boolean> {
  if (context.audience !== 'office' || !ORDER_THREAD_TYPES.has(record.type)) return true
  if (!scope.companyId || !scope.partyId) return false
  return maySeeOrder(client, context as OfficeContext, {
    scope: { companyId: scope.companyId, partyId: scope.partyId },
    salesOrderId: record.type === ORDER_RECORD ? record.id : null,
    requestId: record.type === REQUEST_RECORD ? record.id : null,
  })
}

/**
 * The same wall for a LIST of threads (unread counts, the waiting list): ONE read of the orders the person is on (S2's `ownOrdersOf`:
 * none for a reader without an own-orders-only grant), then a pure check per thread — in the read, before any paging.
 */
export async function orderWallFilter(client: FactoryClient | CommandTx, context: RequestContext): Promise<(record: RecordRef, scope: WallScope) => boolean> {
  if (context.audience !== 'office') return () => true
  const office = context as OfficeContext
  const own = await ownOrdersOf(client, office)
  const mine = new Set([...(own?.salesOrderIds ?? []), ...(own?.requestIds ?? [])])
  return (record, scope) => {
    if (!ORDER_THREAD_TYPES.has(record.type)) return true
    if (!scope.companyId || !scope.partyId) return false
    const at = { companyId: scope.companyId, partyId: scope.partyId }
    return mayOn(office, ORDERS_VIEW, at) || (own !== null && mayOn(office, ORDERS_VIEW_OWN, at) && mine.has(record.id))
  }
}
