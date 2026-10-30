import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { QUALITY_COMPLAINTS_VIEW } from '@nexus/factory-domain/quality/complaints/permissions'
import type { HeldCode } from '@nexus/factory-domain/quality/complaints/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeOf } from '../../sales/returns/access'
import { readComplaint, type ComplaintRow } from './store'

/**
 * Who works on complaints (plan A1 §2.2, §3.11): the office over the companies AND customers its grants reach (a role
 * limited to some customers sees only their complaints). A complaint the caller may not see is not found; one it sees but
 * may not act on is forbidden. The floor and the portal read none (the customer's claims pages are W2b).
 */

export { officeOf }

export interface ComplaintScope {
  readonly companyId: string
  readonly partyId: string
}

export const mayOn = (context: OfficeContext, permission: Permission, row: ComplaintScope): boolean => can(actorOf(context), permission, { companyId: row.companyId, partyId: row.partyId })

/** The complaint the office caller sees (quality.complaints.view, else not found) and acts on with `permission` (else forbidden). */
export async function officeComplaint(caller: CommandCaller, complaintId: string, permission: Permission = QUALITY_COMPLAINTS_VIEW): Promise<{ context: OfficeContext; complaint: ComplaintRow }> {
  const context = officeOf(caller)
  const complaint = isUuid(complaintId) ? await caller.withClient((client) => readComplaint(client, complaintId)) : null
  if (!complaint || !mayOn(context, QUALITY_COMPLAINTS_VIEW, complaint)) throw new NotFoundError('Complaint not found.')
  if (!mayOn(context, permission, complaint)) throw new ForbiddenError()
  return { context, complaint }
}

/** A step its complaint's state holds: 409 invalid_state, the code in `held/<CODE>` (the screens' words), the words here. */
export function held(code: HeldCode, words: string): DomainError {
  return new DomainError('invalid_state', words, [{ path: `held/${code}`, message: words }])
}
