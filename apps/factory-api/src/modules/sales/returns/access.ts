import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { FLOOR_RMA_COLUMNS, readRma, type FloorRmaRow, type RmaRow } from './store'

/**
 * Who works on customer returns (plan A1 §2.2, §3.11): the office over the companies, sites AND customers its grants
 * reach (a role limited to some customers sees only their returns), and the dock's tablet at its own site (receive and
 * grade, never a price or a decision). An RMA the caller may not see is not found; one it sees but may not act on is
 * forbidden.
 */

export function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

export interface ReturnScope {
  readonly companyId: string
  /** The site the goods come back to (none yet: before the RMA is made). */
  readonly siteId?: string | null | undefined
  readonly partyId: string
}

const scopeOf = (row: ReturnScope) => ({ companyId: row.companyId, ...(row.siteId ? { siteId: row.siteId } : {}), partyId: row.partyId })

export const mayOn = (context: OfficeContext | FloorContext, permission: Permission, row: ReturnScope): boolean => can(actorOf(context), permission, scopeOf(row))

/** The RMA the office caller sees (sales.returns.view, else not found) and acts on with `permission` (else forbidden). */
export async function officeReturn(caller: CommandCaller, returnId: string, permission: Permission = SALES_RETURNS_VIEW): Promise<{ context: OfficeContext; rma: RmaRow }> {
  const context = officeOf(caller)
  const rma = isUuid(returnId) ? await caller.withClient((client) => readRma(client, returnId)) : null
  if (!rma || !mayOn(context, SALES_RETURNS_VIEW, rma)) throw new NotFoundError('Return not found.')
  if (!mayOn(context, permission, rma)) throw new ForbiddenError()
  return { context, rma }
}

/** The RMA a dock caller reaches: office (with `permission`) or the floor of its site (with `permission` there). */
export async function dockReturn(caller: CommandCaller, returnId: string, permission: Permission): Promise<{ context: OfficeContext | FloorContext; rma: FloorRmaRow }> {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience === 'floor') {
    const rma = isUuid(returnId) ? await caller.withClient((client) => client.returnAuthorisation.findUnique({ where: { id: returnId }, select: FLOOR_RMA_COLUMNS })) : null
    if (!rma || rma.siteId !== context.siteId || !mayOn(context, permission, rma)) throw new NotFoundError('Return not found.')
    return { context, rma }
  }
  if (context.audience !== 'office') throw new ForbiddenError()
  const rma = isUuid(returnId) ? await caller.withClient((client) => client.returnAuthorisation.findUnique({ where: { id: returnId }, select: FLOOR_RMA_COLUMNS })) : null
  if (!rma || !mayOn(context, SALES_RETURNS_VIEW, rma)) throw new NotFoundError('Return not found.')
  if (!mayOn(context, permission, rma)) throw new ForbiddenError()
  return { context, rma }
}

/** The acting person of a dock command: the office user, or the floor's signed-in worker (never a name in a list). */
export function actorIdOf(context: OfficeContext | FloorContext): string {
  return context.actorId
}
