import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'

/**
 * Who works on work orders, and where (plan A1 §2.2, §3.11): the office, over the companies and sites its grants
 * reach (a work order's company and site). No floor, portal or link route: the floor reads its own site's work orders
 * through its own screens (B-W1-39, 40, 42; row-level security keeps it to its site and to SELECT). A work order the
 * caller may not see is not found; one it sees but may not act on is forbidden.
 */

export function officeContextOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** A work order's scope (or the site a new one is made at). */
export interface WorkOrderScope {
  readonly companyId: string
  readonly siteId: string
}

export const mayOn = (context: OfficeContext, permission: Permission, row: WorkOrderScope): boolean =>
  can(actorOf(context), permission, { companyId: row.companyId, siteId: row.siteId })

/** The row is seen with workorders.view (else not found) and `permission` is held over it (else forbidden). */
export function assertMay(context: OfficeContext, permission: Permission, row: WorkOrderScope | null, what = 'Work order'): asserts row is WorkOrderScope {
  if (!row || !mayOn(context, WORKORDERS_VIEW, row)) throw new NotFoundError(`${what} not found.`)
  if (!mayOn(context, permission, row)) throw new ForbiddenError()
}
