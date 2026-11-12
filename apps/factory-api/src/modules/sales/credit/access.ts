import { ForbiddenError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { can, holds, type Permission } from '@nexus/factory-domain/core/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'

/**
 * Who works on credit (B-W2b-304): the office, over the companies AND customers its grants reach (a check and a limit are
 * a customer's with one company). No floor, portal or link route: a customer never reads its own credit reading. The
 * amounts need the price grain besides (the grain filter drops them from every answer without it).
 */
export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** The reader may do `permission` on the customer's credit with the company. */
export const mayOn = (context: OfficeContext, permission: Permission, at: { readonly companyId: string; readonly partyId: string }): boolean => can(actorOf(context), permission, at)

/** The reader holds the price grain (the amounts of a reading). */
export const seesPrices = (context: OfficeContext): boolean => holds(actorOf(context), 'money.price')
