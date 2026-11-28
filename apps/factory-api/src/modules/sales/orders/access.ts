import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { anyOf, can, holds, NO_ROWS, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { ORDERS_VIEW, ORDERS_VIEW_OWN } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
// owb-of1a (R20): the ONE "on the order" rule (its file imports this one back, for mayOn: both use the other only inside calls).
import { maySeeOrder } from './on-the-order'

/**
 * Who works on sales orders (plan A1 §2.2, §3.11): the office, over the companies AND parties its grants reach (a role
 * limited to some customers sees only their orders). No floor, portal or link route: the floor reads work orders, a
 * portal its own orders through its own screens (W2b). An order the caller may not see is not found; one it sees but may
 * not act on is forbidden. The worker's handlers act as the tenant's system (modules/sales/orders/moves followOrder).
 *
 * owb-of1a (plan.md § 5 D R20): the Factory designer holds orders.view.own, not orders.view — it sees an order only while it is
 * on it (./on-the-order.ts). The reads it uses check with `assertSees` (async: the rule reads the database); `assertMay` stays
 * for every other caller and check.
 */

export function officeContextOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** An order's scope: its selling company and its customer. */
export interface OrderScope {
  readonly companyId: string
  readonly partyId: string
}

export const mayOn = (context: OfficeContext, permission: Permission, scope: OrderScope): boolean => can(actorOf(context), permission, { companyId: scope.companyId, partyId: scope.partyId })

/** The caller sees the order with orders.view (else not found) and holds `permission` over it (else forbidden). */
export function assertMay(context: OfficeContext, permission: Permission, scope: OrderScope | null, what = 'Sales order'): asserts scope is OrderScope {
  if (!scope || !mayOn(context, ORDERS_VIEW, scope)) throw new NotFoundError(`${what} not found.`)
  if (!mayOn(context, permission, scope)) throw new ForbiddenError()
}

// ── owb-of1a (plan.md § 5 D R20: the designer sees only his orders) ──────────────────────────────────────────────────────────
/**
 * assertMay's sibling for a read the Factory designer uses: the order is seen with orders.view over its scope, or with
 * orders.view.own while the caller is on it (on-the-order.ts `maySeeOrder`, the ONE rule) — else not found; then the caller holds
 * `permission` over it — else forbidden (orders.view itself counts as held once the order is seen). Answers the scope.
 */
export async function assertSees(
  client: FactoryClient | CommandTx,
  context: OfficeContext,
  permission: Permission,
  scope: OrderScope | null,
  ids: { readonly salesOrderId?: string | null; readonly requestId?: string | null },
  what = 'Sales order',
): Promise<OrderScope> {
  if (!scope || !(await maySeeOrder(client, context, { scope, ...ids }))) throw new NotFoundError(`${what} not found.`)
  if (permission !== ORDERS_VIEW && !mayOn(context, permission, scope)) throw new ForbiddenError()
  return scope
}

/**
 * The reads the designer uses say `signed-in` in their manifest (a manifest names ONE permission, and these take orders.view OR
 * orders.view.own): a caller who holds neither in any grant is refused here (403), as the manifest refused before.
 */
export function assertOrdersReader(context: OfficeContext): void {
  const actor = actorOf(context)
  if (!holds(actor, ORDERS_VIEW) && !holds(actor, ORDERS_VIEW_OWN)) throw new ForbiddenError()
}

/** A route's caller once `assertOrdersReader` passed (routes.ts: `listOrders(ordersReader(request), …)`). */
export function ordersReader<T extends CommandCaller>(caller: T): T {
  assertOrdersReader(officeContextOf(caller))
  return caller
}

/**
 * A list's scope: the orders orders.view reaches, OR — when `own` is given (on-the-order.ts `ownOrdersOf`: the caller holds a grant
 * with orders.view.own and without orders.view) — the orders it is on that orders.view.own reaches. Ids IN SQL, before paging.
 */
export function seenOrdersWhere(context: OfficeContext, own: { readonly salesOrderIds: readonly string[] } | null): Prisma.SalesOrderWhereInput {
  const actor = actorOf(context)
  const columns = { company: 'companyId', party: 'partyId' } as const
  const viewed = scopeWhere(actor, ORDERS_VIEW, columns)
  if (!own) return viewed as Prisma.SalesOrderWhereInput
  const ownScope = scopeWhere(actor, ORDERS_VIEW_OWN, columns)
  const mine = ownScope === NO_ROWS || own.salesOrderIds.length === 0 ? NO_ROWS : { AND: [ownScope, { id: { in: [...own.salesOrderIds] } }] }
  return anyOf([viewed, mine]) as Prisma.SalesOrderWhereInput
}
// ── end owb-of1a ──
