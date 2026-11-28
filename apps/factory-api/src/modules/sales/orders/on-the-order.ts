import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { ORDERS_VIEW, ORDERS_VIEW_OWN } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { mayOn, type OrderScope } from './access'

/**
 * owb-of1a (order workflow, plan.md § 5 D R20 "the designer sees only his orders"; the base's `orders.view.own`): the ONE rule of
 * "this person is on this order". S1's thread wall (platform/threads) and S3's Confirm import this file, so it imports only Prisma
 * types, factory-domain and ./access.ts — never a platform or threads file (no import loop).
 *
 * A person is ON an order when
 *   - they follow it: a RecordFollower row of theirs on the SalesOrder OR on its PortalOrderRequest, any reason, muted too — both
 *     ways: a request's follow counts for the order made from it, an order's follow for the request it came from; or
 *   - they are its customer's Factory designer or that designer's backup (PortalSettings.factoryDesignerId /
 *     factoryDesignerBackupId of the order's party).
 * `maySeeOrder` = orders.view over the order's scope (today's rule), OR orders.view.own over the scope AND on the order.
 */

type Client = FactoryClient | CommandTx

/** The record types of the follow rows that put a person on an order (the threads' own names). */
export const ORDER_RECORD = 'SalesOrder'
export const REQUEST_RECORD = 'PortalOrderRequest'

const unique = (values: readonly (string | null | undefined)[]): string[] => [...new Set(values.filter((value): value is string => isUuid(value)))]

/** The person's Factory designer slots: the parties they design for, as designer or backup. */
const designerSlotWhere = (tenantId: string, userId: string): Prisma.PortalSettingsWhereInput => ({ tenantId, OR: [{ factoryDesignerId: userId }, { factoryDesignerBackupId: userId }] })

/** Is the person on this order (or on this Draft/Sent request)? Either id may be given; both name the same pair. */
export async function isOnOrder(client: Client, input: { tenantId: string; userId: string; salesOrderId?: string | null; requestId?: string | null }): Promise<boolean> {
  const { tenantId, userId } = input
  if (!isUuid(userId)) return false
  const salesOrderId = isUuid(input.salesOrderId) ? input.salesOrderId : null
  const requestId = isUuid(input.requestId) ? input.requestId : null
  if (!salesOrderId && !requestId) return false
  // The pair: the order's requests and the request's order (one read).
  const requests = await client.portalOrderRequest.findMany({
    where: { tenantId, OR: [...(requestId ? [{ id: requestId }] : []), ...(salesOrderId ? [{ salesOrderId }] : [])] },
    select: { id: true, salesOrderId: true, partyId: true },
  })
  const orderIds = unique([salesOrderId, ...requests.map((request) => request.salesOrderId)])
  const requestIds = unique(requests.map((request) => request.id))
  if (orderIds.length === 0 && requestIds.length === 0) return false
  const followed = await client.recordFollower.findFirst({
    where: {
      tenantId,
      userId,
      OR: [...(orderIds.length > 0 ? [{ recordType: ORDER_RECORD, recordId: { in: orderIds } }] : []), ...(requestIds.length > 0 ? [{ recordType: REQUEST_RECORD, recordId: { in: requestIds } }] : [])],
    },
    select: { id: true },
  })
  if (followed) return true
  // The customer's Factory designer slot (the order's party; a request's party is the same customer).
  const order = salesOrderId ? await client.salesOrder.findFirst({ where: { tenantId, id: salesOrderId }, select: { partyId: true } }) : null
  const partyIds = unique([order?.partyId, ...requests.map((request) => request.partyId)])
  if (partyIds.length === 0) return false
  const slot = await client.portalSettings.findFirst({ where: { AND: [designerSlotWhere(tenantId, userId), { partyId: { in: partyIds } }] }, select: { id: true } })
  return slot !== null
}

/**
 * Every order and request the person is on, for a list: filter `id in salesOrderIds` (or `requestIds`) IN SQL, before paging.
 * Both ways (a followed request brings its order, a followed order its requests) and every order and request of a customer the
 * person is the Factory designer (or backup) of.
 */
export async function ordersUserIsOn(client: Client, input: { tenantId: string; userId: string }): Promise<{ salesOrderIds: string[]; requestIds: string[] }> {
  const { tenantId, userId } = input
  if (!isUuid(userId)) return { salesOrderIds: [], requestIds: [] }
  const follows = await client.recordFollower.findMany({ where: { tenantId, userId, recordType: { in: [ORDER_RECORD, REQUEST_RECORD] } }, select: { recordType: true, recordId: true } })
  const followedOrders = unique(follows.filter((row) => row.recordType === ORDER_RECORD).map((row) => row.recordId))
  const followedRequests = unique(follows.filter((row) => row.recordType === REQUEST_RECORD).map((row) => row.recordId))
  const partyIds = unique((await client.portalSettings.findMany({ where: designerSlotWhere(tenantId, userId), select: { partyId: true } })).map((row) => row.partyId))
  const requestWhere: Prisma.PortalOrderRequestWhereInput[] = [
    ...(followedRequests.length > 0 ? [{ id: { in: followedRequests } }] : []),
    ...(followedOrders.length > 0 ? [{ salesOrderId: { in: followedOrders } }] : []),
    ...(partyIds.length > 0 ? [{ partyId: { in: partyIds } }] : []),
  ]
  const requests = requestWhere.length > 0 ? await client.portalOrderRequest.findMany({ where: { tenantId, OR: requestWhere }, select: { id: true, salesOrderId: true } }) : []
  const partyOrders = partyIds.length > 0 ? await client.salesOrder.findMany({ where: { tenantId, partyId: { in: partyIds } }, select: { id: true } }) : []
  return {
    salesOrderIds: unique([...followedOrders, ...requests.map((request) => request.salesOrderId), ...partyOrders.map((order) => order.id)]),
    requestIds: unique(requests.map((request) => request.id)),
  }
}

/** May the office person see this order (or this Draft/Sent request): orders.view over its scope, OR orders.view.own AND on it. */
export async function maySeeOrder(client: Client, context: OfficeContext, input: { scope: OrderScope; salesOrderId?: string | null; requestId?: string | null }): Promise<boolean> {
  if (mayOn(context, ORDERS_VIEW, input.scope)) return true
  if (!mayOn(context, ORDERS_VIEW_OWN, input.scope)) return false
  return isOnOrder(client, { tenantId: context.tenantId, userId: context.actorId, salesOrderId: input.salesOrderId ?? null, requestId: input.requestId ?? null })
}

/**
 * Some of the person's grants hold orders.view.own WITHOUT orders.view (the Factory designer): only then does a list read the
 * orders the person is on (an Owner or Read-only holds both in one grant — their orders.view already reaches every such row).
 */
export function seesOwnOrdersOnly(grants: readonly Grant[]): boolean {
  return grants.some((grant) => grant.permissions.includes(ORDERS_VIEW_OWN) && !grant.permissions.includes(ORDERS_VIEW))
}

/** The ids a list adds for orders.view.own (null: the caller holds no such grant, the list is orders.view's alone). */
export async function ownOrdersOf(client: Client, context: OfficeContext): Promise<{ salesOrderIds: string[]; requestIds: string[] } | null> {
  if (!seesOwnOrdersOnly(context.grants)) return null
  return ordersUserIsOn(client, { tenantId: context.tenantId, userId: context.actorId })
}
