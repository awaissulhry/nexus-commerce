import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { SALES_SERVICE_VIEW } from '@nexus/factory-domain/sales/service/permissions'
import { heldWords, type HeldCode } from '@nexus/factory-domain/sales/service/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeOf } from '../returns/access'
import { readCase, type CaseRow } from './store'

/**
 * Who works on service cases (plan A1 §2.2, §3.11): the office over the companies its grants reach and, when a case names
 * a customer, over that customer (a role limited to some customers sees only their cases, and the cases that name no
 * customer: a rider who wrote to us directly). A case the caller may not see is not found; one it sees but may not act on
 * is forbidden. The floor and the portal read none (the portal's service inbox is Later, SAL-447).
 */

export { officeOf }

export interface CaseScope {
  readonly companyId: string
  readonly partyId: string | null
}

export const scopeOfCase = (row: CaseScope): { companyId: string; partyId?: string } => ({ companyId: row.companyId, ...(row.partyId ? { partyId: row.partyId } : {}) })

export const mayOn = (context: OfficeContext, permission: Permission, row: CaseScope): boolean => can(actorOf(context), permission, scopeOfCase(row))

/** The case the office caller sees (sales.service.view, else not found) and acts on with `permission` (else forbidden). */
export async function officeCase(caller: CommandCaller, caseId: string, permission: Permission = SALES_SERVICE_VIEW): Promise<{ context: OfficeContext; row: CaseRow }> {
  const context = officeOf(caller)
  const row = isUuid(caseId) ? await caller.withClient((client) => readCase(client, caseId)) : null
  if (!row || !mayOn(context, SALES_SERVICE_VIEW, row)) throw new NotFoundError('Service case not found.')
  if (!mayOn(context, permission, row)) throw new ForbiddenError()
  return { context, row }
}

/** A step the case's state holds: 409 invalid_state, the code in `held/<CODE>` (the screens' words), the words here. */
export function held(code: HeldCode, number: string): DomainError {
  const words = `Case ${number} ${heldWords(code)}.`
  return new DomainError('invalid_state', words, [{ path: `held/${code}`, message: words }])
}
