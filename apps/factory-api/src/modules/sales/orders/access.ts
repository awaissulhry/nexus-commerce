import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'

/**
 * Who works on sales orders (plan A1 §2.2, §3.11): the office, over the companies AND parties its grants reach (a role
 * limited to some customers sees only their orders). No floor, portal or link route: the floor reads work orders, a
 * portal its own orders through its own screens (W2b). An order the caller may not see is not found; one it sees but may
 * not act on is forbidden. The worker's handlers act as the tenant's system (modules/sales/orders/moves followOrder).
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
